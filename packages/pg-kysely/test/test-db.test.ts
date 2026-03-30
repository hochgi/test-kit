/**
 * Tests for the public createTestDb API.
 *
 * Uses a generic e-commerce schema: orders (with JSONB) and products (with soft-delete).
 * Exercises create, seed, reset, query, and close lifecycle.
 */

import { Kysely, sql, ColumnType, JSONColumnType } from 'kysely';
import { createTestDb, TestDb } from '../src';

// ── Schema types ────────────────────────────────────────────────────────────

interface OrderTable {
    id: number;
    customer_id: number;
    status: string;
    order_date: ColumnType<string | Date, string | Date, string | Date>;
    line_items: JSONColumnType<Array<{ sku: string; qty: number; price: number }>>;
    metadata: JSONColumnType<Record<string, unknown> | null>;
}

interface ProductTable {
    id: number;
    name: string;
    category: string;
    price_cents: number;
    in_stock: boolean;
    deleted_at: ColumnType<Date | null, string | null, string | null>;
}

interface TestDatabase {
    orders: OrderTable;
    products: ProductTable;
}

// ── Bootstrap function ──────────────────────────────────────────────────────

async function bootstrap(db: Kysely<TestDatabase>): Promise<void> {
    await sql
        .raw(
            `
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            customer_id BIGINT NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'pending',
            order_date DATE NOT NULL DEFAULT CURRENT_DATE,
            line_items JSONB NOT NULL DEFAULT '[]',
            metadata JSONB
        )
    `,
        )
        .execute(db);

    await sql
        .raw(
            `CREATE INDEX IF NOT EXISTS idx_orders_line_items_gin
             ON orders USING GIN (line_items)`,
        )
        .execute(db);

    await sql
        .raw(
            `
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            name VARCHAR NOT NULL,
            category VARCHAR NOT NULL,
            price_cents INTEGER NOT NULL,
            in_stock BOOLEAN NOT NULL DEFAULT true,
            deleted_at TIMESTAMP
        )
    `,
        )
        .execute(db);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createTestDb', () => {
    let testDb: TestDb<TestDatabase>;

    beforeAll(async () => {
        testDb = await createTestDb<TestDatabase>({ bootstrap });
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

            const row = await testDb.db
                .selectFrom('orders')
                .where('customer_id', '=', 42)
                .select(['line_items', 'metadata'])
                .executeTakeFirstOrThrow();

            const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
            expect(items).toHaveLength(2);
            expect(items[0].sku).toBe('WIDGET-A');

            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            expect(meta.coupon).toBe('SAVE10');
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

            const rows = await testDb.db
                .selectFrom('products')
                .select(['name', 'price_cents'])
                .where('category', '=', 'electronics')
                .where('deleted_at', 'is', null)
                .execute();

            expect(rows).toHaveLength(1);
            expect(rows[0].name).toBe('Laptop');
        });
    });

    describe('reset', () => {
        it('clears all data and recreates tables', async () => {
            await testDb.seed('orders', [
                { customer_id: 1, status: 'pending', order_date: '2026-01-01', line_items: [], metadata: null },
            ]);

            await testDb.reset();

            const rows = await testDb.db.selectFrom('orders').selectAll().execute();
            expect(rows).toHaveLength(0);
        });

        it('tables still exist after reset (bootstrap re-ran)', async () => {
            await testDb.reset();

            const result = await sql<{ tablename: string }>`
                SELECT tablename FROM pg_tables WHERE schemaname = 'public'
            `.execute(testDb.db);

            const tables = result.rows.map((r) => r.tablename).sort();
            expect(tables).toEqual(['orders', 'products']);
        });
    });

    describe('extensions option', () => {
        it('loads uuid-ossp extension and uuid_generate_v4() works', async () => {
            // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
            const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

            const extDb = await createTestDb<{ uuid_test: { id: string; label: string } }>({
                extensions: { uuid_ossp },
                bootstrap: async (db) => {
                    await sql.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"').execute(db);
                    await sql
                        .raw(
                            `CREATE TABLE IF NOT EXISTS uuid_test (
                                id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                                label VARCHAR NOT NULL
                            )`,
                        )
                        .execute(db);
                },
            });

            try {
                await extDb.seed('uuid_test', [{ label: 'auto-uuid' }]);
                const rows = await extDb.db.selectFrom('uuid_test').select(['id', 'label']).execute();
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

            const extDb = await createTestDb<{ uuid_test: { id: string; label: string } }>({
                extensions: { uuid_ossp },
                bootstrap: async (db) => {
                    await sql.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"').execute(db);
                    await sql
                        .raw(
                            `CREATE TABLE IF NOT EXISTS uuid_test (
                                id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                                label VARCHAR NOT NULL
                            )`,
                        )
                        .execute(db);
                },
            });

            try {
                await extDb.seed('uuid_test', [{ label: 'before-reset' }]);
                await extDb.reset();
                await extDb.seed('uuid_test', [{ label: 'after-reset' }]);

                const rows = await extDb.db.selectFrom('uuid_test').select(['id', 'label']).execute();
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

            const rows = await testDb.db
                .selectFrom('orders')
                .where(sql`(metadata->>'priority')::integer`, '=', 5)
                .select(['customer_id'])
                .execute();

            expect(rows).toHaveLength(1);
            expect(rows[0].customer_id).toBe(2);
        });
    });
});
