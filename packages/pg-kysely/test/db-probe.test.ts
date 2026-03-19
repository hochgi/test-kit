/**
 * Tests for the probed-fake Kysely database.
 *
 * Validates the DbProbe intercept/forward/reject lifecycle on top of PGlite.
 * Uses a generic e-commerce schema: orders and products.
 */

import { Kysely, sql, ColumnType, JSONColumnType } from 'kysely';
import { createProbedTestDb, DbProbe, ProbedTestDb } from '../src';

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

// ── Bootstrap ───────────────────────────────────────────────────────────────

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

describe('createProbedTestDb', () => {
    let testDb: ProbedTestDb<TestDatabase>;
    let probe: DbProbe;

    beforeAll(async () => {
        testDb = await createProbedTestDb<TestDatabase>({ bootstrap });
        probe = testDb.probe;
    });

    afterAll(async () => {
        await testDb.close();
    });

    afterEach(async () => {
        await testDb.reset();
    });

    describe('alwaysForward (default passthrough)', () => {
        it('forwards queries to PGlite and returns real results', async () => {
            await testDb.seed('orders', [
                {
                    customer_id: 42,
                    status: 'shipped',
                    order_date: '2026-03-15',
                    line_items: [{ sku: 'WIDGET-A', qty: 2, price: 1999 }],
                    metadata: null,
                },
            ]);

            const row = await testDb.db
                .selectFrom('orders')
                .where('customer_id', '=', 42)
                .select(['line_items'])
                .executeTakeFirstOrThrow();

            const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
            expect(items[0].sku).toBe('WIDGET-A');
        });

        it('records queries that go through the probed db', async () => {
            const before = probe.queries.length;

            await testDb.db.selectFrom('products').selectAll().execute();

            expect(probe.queries.length).toBeGreaterThan(before);
        });
    });

    describe('whenQueried().thenReject()', () => {
        it('rejects the next query with the given error', async () => {
            probe.whenQueried().thenReject(new Error('connection lost'));

            await expect(testDb.db.selectFrom('orders').selectAll().execute()).rejects.toThrow('connection lost');
        });

        it('only rejects one query, subsequent queries forward normally', async () => {
            probe.whenQueried().thenReject(new Error('transient'));

            await expect(testDb.db.selectFrom('orders').selectAll().execute()).rejects.toThrow('transient');

            const rows = await testDb.db.selectFrom('orders').selectAll().execute();
            expect(rows).toEqual([]);
        });
    });

    describe('alwaysReject()', () => {
        it('rejects all queries until reset to alwaysForward', async () => {
            probe.alwaysReject(new Error('db down'));

            await expect(testDb.db.selectFrom('orders').selectAll().execute()).rejects.toThrow('db down');

            await expect(testDb.db.selectFrom('products').selectAll().execute()).rejects.toThrow('db down');

            probe.alwaysForward();

            const rows = await testDb.db.selectFrom('orders').selectAll().execute();
            expect(rows).toEqual([]);
        });
    });

    describe('expectNext() plumbing', () => {
        afterEach(() => {
            probe.alwaysForward();
        });

        it('captures the next query and allows explicit forward', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectNext();
            const queryPromise = testDb.db.selectFrom('orders').selectAll().execute();

            const pending = await pendingPromise;
            expect(pending.sql).toContain('orders');
            expect(pending.settled).toBe(false);

            pending.forward();
            const rows = await queryPromise;
            expect(rows).toEqual([]);
        });

        it('captures the next query and allows explicit reject', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectNext();
            const queryPromise = testDb.db.selectFrom('orders').selectAll().execute();

            const pending = await pendingPromise;
            pending.reject(new Error('injected failure'));

            await expect(queryPromise).rejects.toThrow('injected failure');
        });

        it('throws if forward is called twice on the same query', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectNext();
            const queryPromise = testDb.db.selectFrom('orders').selectAll().execute();

            const pending = await pendingPromise;
            pending.forward();
            await queryPromise;

            expect(() => pending.forward()).toThrow('already settled');
        });
    });

    describe('expectMatching() plumbing', () => {
        afterEach(() => {
            probe.alwaysForward();
        });

        it('matches queries by SQL content', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectMatching((q) => q.sql.includes('products'));
            const queryPromise = testDb.db
                .selectFrom('products')
                .select(['name'])
                .where('category', '=', 'electronics')
                .execute();

            const pending = await pendingPromise;
            expect(pending.sql).toContain('products');

            pending.forward();
            await queryPromise;
        });
    });

    describe('seed and reset still work through the probe', () => {
        it('seed flows through the probe to PGlite', async () => {
            await testDb.seed('products', [
                { name: 'Keyboard', category: 'accessories', price_cents: 7900, in_stock: true },
            ]);

            const rows = await testDb.db
                .selectFrom('products')
                .select(['name'])
                .where('category', '=', 'accessories')
                .where('deleted_at', 'is', null)
                .execute();

            expect(rows).toHaveLength(1);
            expect(rows[0].name).toBe('Keyboard');
        });

        it('reset clears data and tables are recreated', async () => {
            await testDb.seed('products', [
                { name: 'Mouse', category: 'accessories', price_cents: 2900, in_stock: true },
            ]);

            await testDb.reset();

            const rows = await testDb.db.selectFrom('products').selectAll().execute();
            expect(rows).toHaveLength(0);
        });
    });

    describe('JSONB queries work through the probe', () => {
        it('filters by JSONB text extraction with integer cast', async () => {
            await testDb.seed('orders', [
                {
                    customer_id: 1,
                    status: 'pending',
                    order_date: '2026-03-01',
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
        });
    });
});
