/**
 * Tests for the public createTestDb API.
 *
 * Uses a generic e-commerce schema: orders (with JSONB) and products (with soft-delete).
 * Exercises create, seed, reset, query, and close lifecycle.
 */

import type { Knex } from 'knex';
import { createTestDb, createProbedTestDb, type TestDb } from '../src';

async function bootstrap(db: Knex): Promise<void> {
    await db.raw(`
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            customer_id BIGINT NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'pending',
            order_date DATE NOT NULL DEFAULT CURRENT_DATE,
            line_items JSONB NOT NULL DEFAULT '[]',
            metadata JSONB
        )
    `);

    await db.raw(`
        CREATE INDEX IF NOT EXISTS idx_orders_line_items_gin
        ON orders USING GIN (line_items)
    `);

    await db.raw(`
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            name VARCHAR NOT NULL,
            category VARCHAR NOT NULL,
            price_cents INTEGER NOT NULL,
            in_stock BOOLEAN NOT NULL DEFAULT true,
            deleted_at TIMESTAMP
        )
    `);
}

describe('createTestDb', () => {
    let testDb: TestDb;

    beforeAll(async () => {
        testDb = await createTestDb({ bootstrap });
    });

    afterAll(async () => {
        await testDb.close();
    });

    afterEach(async () => {
        await testDb.reset();
    });

    describe('seed and query', () => {
        it('seeds order rows with JSONB and queries them back', async () => {
            await testDb.seed('orders', [
                {
                    customer_id: 42,
                    status: 'shipped',
                    order_date: '2026-03-15',
                    line_items: [
                        { sku: 'WIDGET-A', qty: 2, price: 1999 },
                        { sku: 'GADGET-B', qty: 1, price: 4999 },
                    ],
                    metadata: { source: 'web', coupon: 'SAVE10' },
                },
            ]);

            const row = await testDb.db('orders').where({ customer_id: 42 }).select('line_items', 'metadata').first();

            expect(row).toBeDefined();
            const items = typeof row!.line_items === 'string' ? JSON.parse(row!.line_items as string) : row!.line_items;
            expect(items).toHaveLength(2);
            expect(items[0].sku).toBe('WIDGET-A');

            const meta = typeof row!.metadata === 'string' ? JSON.parse(row!.metadata as string) : row!.metadata;
            expect((meta as { coupon: string }).coupon).toBe('SAVE10');
        });

        it('seeds products and queries with soft-delete filter', async () => {
            await testDb.seed('products', [
                { name: 'Laptop', category: 'electronics', price_cents: 99900, in_stock: true },
                {
                    name: 'Discontinued Phone',
                    category: 'electronics',
                    price_cents: 49900,
                    in_stock: false,
                    deleted_at: '2026-01-01 00:00:00',
                },
            ]);

            const rows = await testDb
                .db('products')
                .select('name', 'price_cents')
                .where({ category: 'electronics' })
                .whereNull('deleted_at');

            expect(rows).toHaveLength(1);
            expect(rows[0].name).toBe('Laptop');
        });
    });

    describe('reset', () => {
        it('clears all data and recreates tables', async () => {
            await testDb.seed('orders', [
                {
                    customer_id: 1,
                    status: 'pending',
                    order_date: '2026-01-01',
                    line_items: [],
                    metadata: null,
                },
            ]);

            await testDb.reset();

            const rows = await testDb.db('orders').select('*');
            expect(rows).toHaveLength(0);
        });

        it('tables still exist after reset (bootstrap re-ran)', async () => {
            await testDb.reset();

            const result = await testDb.db.raw<{ rows: Array<{ tablename: string }> }>(
                `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
            );
            const tables = result.rows.map((r) => r.tablename).sort();
            expect(tables).toEqual(['orders', 'products']);
        });
    });

    describe('extensions option', () => {
        it('loads uuid-ossp extension and uuid_generate_v4() works', async () => {
            // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
            const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

            const extDb = await createTestDb({
                extensions: { uuid_ossp },
                bootstrap: async (db: Knex) => {
                    await db.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
                    await db.raw(`
                        CREATE TABLE IF NOT EXISTS uuid_test (
                            id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                            label VARCHAR NOT NULL
                        )
                    `);
                },
            });

            try {
                await extDb.seed('uuid_test', [{ label: 'auto-uuid' }]);
                const rows = await extDb.db('uuid_test').select('id', 'label');
                expect(rows).toHaveLength(1);
                expect(rows[0].label).toBe('auto-uuid');
                expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            } finally {
                await extDb.close();
            }
        });

        it('extensions survive reset()', async () => {
            // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
            const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

            const extDb = await createTestDb({
                extensions: { uuid_ossp },
                bootstrap: async (db: Knex) => {
                    await db.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
                    await db.raw(`
                        CREATE TABLE IF NOT EXISTS uuid_test (
                            id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                            label VARCHAR NOT NULL
                        )
                    `);
                },
            });

            try {
                await extDb.seed('uuid_test', [{ label: 'before-reset' }]);
                await extDb.reset();
                await extDb.seed('uuid_test', [{ label: 'after-reset' }]);

                const rows = await extDb.db('uuid_test').select('id', 'label');
                expect(rows).toHaveLength(1);
                expect(rows[0].label).toBe('after-reset');
                expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/i);
            } finally {
                await extDb.close();
            }
        });
    });

    describe('JSONB filter queries', () => {
        it('filters by JSONB text extraction with integer cast', async () => {
            await testDb.seed('orders', [
                {
                    customer_id: 1,
                    status: 'pending',
                    order_date: '2026-03-01',
                    line_items: [],
                    metadata: { priority: 1 },
                },
                {
                    customer_id: 2,
                    status: 'pending',
                    order_date: '2026-03-02',
                    line_items: [],
                    metadata: { priority: 5 },
                },
            ]);

            const rows = await testDb
                .db('orders')
                .whereRaw(`(metadata->>'priority')::integer = ?`, [5])
                .select('customer_id');

            expect(rows).toHaveLength(1);
            expect(rows[0].customer_id).toBe(2);
        });
    });
});

// ── knexConfig option ────────────────────────────────────────────────────────

describe('createTestDb with knexConfig (postProcessResponse transform)', () => {
    it('applies a custom postProcessResponse transform to query results', async () => {
        // Simulate a minimal knex-stringcase-style transform that uppercases all keys.
        const knexConfig: Partial<Knex.Config> = {
            postProcessResponse: (result: unknown) => {
                if (Array.isArray(result)) {
                    return result.map((row) => {
                        if (row && typeof row === 'object') {
                            return Object.fromEntries(
                                Object.entries(row as Record<string, unknown>).map(([k, v]) => [k.toUpperCase(), v]),
                            );
                        }
                        return row;
                    });
                }
                return result;
            },
        };

        const testDb = await createTestDb({
            knexConfig,
            bootstrap: async (db: Knex) => {
                await db.raw(`
                    CREATE TABLE IF NOT EXISTS items (
                        id SERIAL PRIMARY KEY,
                        label VARCHAR NOT NULL
                    )
                `);
            },
        });

        try {
            await testDb.seed('items', [{ label: 'hello' }]);

            const rows = await testDb.db('items').select('id', 'label');
            expect(rows).toHaveLength(1);
            // Keys should be uppercased by the transform.
            expect(rows[0]).toHaveProperty('LABEL', 'hello');

            await testDb.reset();
            const afterReset = await testDb.db('items').select('*');
            expect(afterReset).toHaveLength(0);
        } finally {
            await testDb.close();
        }
    });

    it('knexConfig is ignored for client/connection/pool — does not override PGlite wiring', async () => {
        const testDb = await createTestDb({
            // Supplying conflicting options should be silently stripped.
            knexConfig: { client: 'pg', connection: 'postgres://localhost/nope', pool: { min: 0, max: 5 } },
            bootstrap: async (db: Knex) => {
                await db.raw(`CREATE TABLE IF NOT EXISTS check_table (id SERIAL PRIMARY KEY)`);
            },
        });

        try {
            const rows = await testDb.db('check_table').select('*');
            expect(rows).toEqual([]);
        } finally {
            await testDb.close();
        }
    });
});

describe('createProbedTestDb with knexConfig', () => {
    it('probe still intercepts when knexConfig is provided', async () => {
        const testDb = await createProbedTestDb({
            knexConfig: {
                postProcessResponse: (result: unknown) => result,
            },
            bootstrap: async (db: Knex) => {
                await db.raw(`CREATE TABLE IF NOT EXISTS probed_items (id SERIAL PRIMARY KEY, name VARCHAR NOT NULL)`);
            },
        });

        try {
            const before: number = testDb.probe.queries.length;
            await testDb.db('probed_items').select('*');
            expect(testDb.probe.queries.length).toBeGreaterThan(before);
        } finally {
            await testDb.close();
        }
    });
});
