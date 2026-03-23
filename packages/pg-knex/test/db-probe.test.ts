/**
 * Tests for the probed-fake Knex database.
 *
 * Validates the DbProbe intercept/forward/reject lifecycle on top of PGlite.
 * Uses a generic e-commerce schema: orders and products.
 */

import type { Knex } from 'knex';
import { createProbedTestDb, DbProbe, type ProbedTestDb } from '../src';

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

describe('createProbedTestDb', () => {
    let testDb: ProbedTestDb;
    let probe: DbProbe;

    beforeAll(async () => {
        testDb = await createProbedTestDb({ bootstrap });
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

            const row = await testDb.db('orders').where({ customer_id: 42 }).select('line_items').first();

            expect(row).toBeDefined();
            const items = typeof row!.line_items === 'string' ? JSON.parse(row!.line_items as string) : row!.line_items;
            expect(items[0].sku).toBe('WIDGET-A');
        });

        it('records queries that go through the probed db', async () => {
            const before: number = probe.queries.length;

            await testDb.db('products').select('*');

            expect(probe.queries.length).toBeGreaterThan(before);
        });
    });

    describe('whenQueried().thenReject()', () => {
        it('rejects the next query with the given error', async () => {
            probe.whenQueried().thenReject(new Error('connection lost'));

            await expect(testDb.db('orders').select('*')).rejects.toThrow('connection lost');
        });

        it('only rejects one query, subsequent queries forward normally', async () => {
            probe.whenQueried().thenReject(new Error('transient'));

            await expect(testDb.db('orders').select('*')).rejects.toThrow('transient');

            const rows = await testDb.db('orders').select('*');
            expect(rows).toEqual([]);
        });
    });

    describe('alwaysReject()', () => {
        it('rejects all queries until reset to alwaysForward', async () => {
            probe.alwaysReject(new Error('db down'));

            await expect(testDb.db('orders').select('*')).rejects.toThrow('db down');

            await expect(testDb.db('products').select('*')).rejects.toThrow('db down');

            probe.alwaysForward();

            const rows = await testDb.db('orders').select('*');
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
            const queryPromise = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    testDb.db('orders').select('*').then(resolve).catch(reject);
                });
            });

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
            const queryPromise = new Promise((resolve, reject) => {
                setImmediate(() => {
                    testDb.db('orders').select('*').then(resolve).catch(reject);
                });
            });

            const pending = await pendingPromise;
            pending.reject(new Error('injected failure'));

            await expect(queryPromise).rejects.toThrow('injected failure');
        });

        it('throws if forward is called twice on the same query', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectNext();
            const queryPromise = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    testDb.db('orders').select('*').then(resolve).catch(reject);
                });
            });

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
            const queryPromise = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    testDb.db('products').select('name').where({ category: 'electronics' }).then(resolve).catch(reject);
                });
            });

            const pending = await pendingPromise;
            expect(pending.sql).toContain('products');

            pending.forward();
            await queryPromise;
        });
    });

    describe('seed and reset still work through maintenance knex', () => {
        it('seed flows to PGlite without blocking on probe', async () => {
            await testDb.seed('products', [
                { name: 'Keyboard', category: 'accessories', price_cents: 7900, in_stock: true },
            ]);

            const rows = await testDb
                .db('products')
                .select('name')
                .where({ category: 'accessories' })
                .whereNull('deleted_at');

            expect(rows).toHaveLength(1);
            expect(rows[0].name).toBe('Keyboard');
        });

        it('reset clears data and tables are recreated', async () => {
            await testDb.seed('products', [
                { name: 'Mouse', category: 'accessories', price_cents: 2900, in_stock: true },
            ]);

            await testDb.reset();

            const rows = await testDb.db('products').select('*');
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

            const rows = await testDb
                .db('orders')
                .whereRaw(`(metadata->>'priority')::integer = ?`, [5])
                .select('customer_id');

            expect(rows).toHaveLength(1);
        });
    });

    describe('drain helpers', () => {
        afterEach(() => {
            probe.alwaysForward();
        });

        it('drainAndForwardAll settles a stuck probed query', async () => {
            probe.clearBehavior();

            const q = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    testDb.db('orders').select('*').then(resolve).catch(reject);
                });
            });
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });

            probe.drainAndForwardAll();

            await expect(q).resolves.toEqual([]);
        });
    });
});
