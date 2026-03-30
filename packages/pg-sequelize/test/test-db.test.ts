/**
 * Tests for the public createTestDb API.
 *
 * Uses a generic e-commerce schema: orders (with JSONB) and products (with soft-delete).
 * Exercises create, seed, reset, query, and close lifecycle.
 */

import { Sequelize, QueryTypes } from 'sequelize';
import { createTestDb, createProbedTestDb, type TestDb, type BootstrapFn } from '../src';

const bootstrap: BootstrapFn = async (sequelize: Sequelize) => {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            customer_id BIGINT NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'pending',
            order_date DATE NOT NULL DEFAULT CURRENT_DATE,
            line_items JSONB NOT NULL DEFAULT '[]',
            metadata JSONB
        )
    `);

    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_orders_line_items_gin
        ON orders USING GIN (line_items)
    `);

    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            name VARCHAR NOT NULL,
            category VARCHAR NOT NULL,
            price_cents INTEGER NOT NULL,
            in_stock BOOLEAN NOT NULL DEFAULT true,
            deleted_at TIMESTAMP
        )
    `);
};

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

            const [rows] = await testDb.sequelize.query(
                `SELECT line_items, metadata FROM orders WHERE customer_id = 42`,
                { type: QueryTypes.SELECT, raw: true },
            );

            expect(rows).toBeDefined();
            const row = rows as Record<string, unknown>;
            const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
            expect(items).toHaveLength(2);
            expect(items[0].sku).toBe('WIDGET-A');

            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
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

            const rows = await testDb.sequelize.query(
                `SELECT name, price_cents FROM products WHERE category = 'electronics' AND deleted_at IS NULL`,
                { type: QueryTypes.SELECT },
            );

            expect(rows).toHaveLength(1);
            expect((rows[0] as any).name).toBe('Laptop');
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

            const rows = await testDb.sequelize.query(`SELECT * FROM orders`, { type: QueryTypes.SELECT });
            expect(rows).toHaveLength(0);
        });

        it('tables still exist after reset (bootstrap re-ran)', async () => {
            await testDb.reset();

            const rows = await testDb.sequelize.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`, {
                type: QueryTypes.SELECT,
            });
            const tables = (rows as Array<{ tablename: string }>).map((r) => r.tablename).sort();
            expect(tables).toEqual(['orders', 'products']);
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

            const rows = await testDb.sequelize.query(
                `SELECT customer_id FROM orders WHERE (metadata->>'priority')::integer = 5`,
                { type: QueryTypes.SELECT },
            );

            expect(rows).toHaveLength(1);
            expect((rows[0] as any).customer_id).toBe(2);
        });
    });
});

// ── sequelizeOptions ────────────────────────────────────────────────────────

describe('createTestDb with sequelizeOptions', () => {
    it('sequelizeOptions is ignored for dialect/dialectModule/connection — does not override PGlite wiring', async () => {
        const testDb = await createTestDb({
            sequelizeOptions: {
                dialect: 'mysql' as any,
                host: 'remote-server.example.com',
                port: 3306,
                username: 'root',
                password: 'secret',
                database: 'prod',
            },
            bootstrap: async (sequelize: Sequelize) => {
                await sequelize.query(`CREATE TABLE IF NOT EXISTS check_table (id SERIAL PRIMARY KEY)`);
            },
        });

        try {
            const rows = await testDb.sequelize.query(`SELECT * FROM check_table`, { type: QueryTypes.SELECT });
            expect(rows).toEqual([]);
        } finally {
            await testDb.close();
        }
    });
});

describe('createProbedTestDb with sequelizeOptions', () => {
    it('probe still intercepts when sequelizeOptions is provided', async () => {
        const testDb = await createProbedTestDb({
            sequelizeOptions: { logging: false },
            bootstrap: async (sequelize: Sequelize) => {
                await sequelize.query(
                    `CREATE TABLE IF NOT EXISTS probed_items (id SERIAL PRIMARY KEY, name VARCHAR NOT NULL)`,
                );
            },
        });

        try {
            const before: number = testDb.probe.queries.length;
            await testDb.sequelize.query(`SELECT * FROM probed_items`, { type: QueryTypes.SELECT });
            expect(testDb.probe.queries.length).toBeGreaterThan(before);
        } finally {
            await testDb.close();
        }
    });
});
