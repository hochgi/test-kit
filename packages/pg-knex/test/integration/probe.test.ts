/**
 * Translated from v1 packages/pg-knex/test/db-probe.test.ts and
 * v1 packages/pg-knex/test/test-db.test.ts to v2 grammar.
 *
 * Same scenarios as pg-kysely's probe.test.ts, but with the Knex API.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { createHarness, type Harness } from '@vnatures/test-kit';
import { createProbedKnexAdapter, type ProbedKnexAdapter } from '@vnatures/test-kit-pg-knex';

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

describe('createProbedKnexAdapter', () => {
    let harness: Harness;
    let db: ProbedKnexAdapter;

    beforeAll(async () => {
        harness = createHarness();
        db = await harness.attach(createProbedKnexAdapter({ harness, bootstrap }));
    });

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await harness.reset();
    });

    describe('default forward rule', () => {
        it('forwards application queries to PGlite and returns real results', async () => {
            await db.seed('orders', [
                {
                    customer_id: 42,
                    status: 'shipped',
                    order_date: '2026-03-15',
                    line_items: JSON.stringify([{ sku: 'WIDGET-A', qty: 2, price: 1999 }]),
                    metadata: null,
                },
            ]);

            const row = await db.adapter('orders').where({ customer_id: 42 }).select('line_items').first();

            expect(row).toBeDefined();
            const items = typeof row!.line_items === 'string' ? JSON.parse(row!.line_items as string) : row!.line_items;
            expect(items[0].sku).toBe('WIDGET-A');
        });

        it('records application queries in probe.calls', async () => {
            const before = db.probe.calls.length;
            await db.adapter('products').select('*');
            expect(db.probe.calls.length).toBeGreaterThan(before);
        });
    });

    describe('once().reject', () => {
        it('rejects only the next query, then default forward resumes', async () => {
            db.probe.once().reject(new Error('transient'));

            await expect(db.adapter('orders').select('*')).rejects.toThrow('transient');

            const rows = await db.adapter('orders').select('*');
            expect(rows).toEqual([]);
        });
    });

    describe('always().reject', () => {
        it('rejects all queries until clearRules', async () => {
            db.probe.always().reject(new Error('db down'));

            await expect(db.adapter('orders').select('*')).rejects.toThrow('db down');
            await expect(db.adapter('products').select('*')).rejects.toThrow('db down');

            db.probe.clearRules();

            const rows = await db.adapter('orders').select('*');
            expect(rows).toEqual([]);
        });
    });

    describe('expect.intercept', () => {
        it('captures a query and allows explicit forward', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.expect.intercept();
            const queryPromise = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    db.adapter('orders').select('*').then(resolve).catch(reject);
                });
            });

            const pending = await pendingPromise;
            expect(pending.sql).toContain('orders');
            expect(pending.settled).toBe(false);

            pending.forward();
            const rows = await queryPromise;
            expect(rows).toEqual([]);
        });

        it('captures a query and allows reject', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.expect.intercept();
            const queryPromise = new Promise((resolve, reject) => {
                setImmediate(() => {
                    db.adapter('orders').select('*').then(resolve).catch(reject);
                });
            });

            const pending = await pendingPromise;
            pending.reject(new Error('injected failure'));

            await expect(queryPromise).rejects.toThrow('injected failure');
        });

        it('throws if forward is called twice', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.expect.intercept();
            const queryPromise = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    db.adapter('orders').select('*').then(resolve).catch(reject);
                });
            });

            const pending = await pendingPromise;
            pending.forward();
            await queryPromise;

            expect(() => pending.forward()).toThrow(/already settled/);
        });
    });

    describe('probe.sql() filter', () => {
        it('matches by sql substring', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.sql(/products/i).expect.intercept();
            const queryPromise = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    db.adapter('products')
                        .select('name')
                        .where({ category: 'electronics' })
                        .then(resolve)
                        .catch(reject);
                });
            });

            const pending = await pendingPromise;
            expect(pending.sql).toContain('products');

            pending.forward();
            await queryPromise;
        });
    });

    describe('seed and reset', () => {
        it('seed flows through maintenance connection (not via probe)', async () => {
            const before = db.probe.calls.length;

            await db.seed('products', [
                { name: 'Keyboard', category: 'accessories', price_cents: 7900, in_stock: true },
            ]);

            expect(db.probe.calls.length).toBe(before);

            const rows = await db
                .adapter('products')
                .select('name')
                .where({ category: 'accessories' })
                .whereNull('deleted_at');

            expect(rows).toHaveLength(1);
            expect(rows[0].name).toBe('Keyboard');
        });

        it('reset clears data; tables remain', async () => {
            await db.seed('products', [{ name: 'Mouse', category: 'accessories', price_cents: 2900, in_stock: true }]);

            await db.reset();

            const rows = await db.adapter('products').select('*');
            expect(rows).toHaveLength(0);
        });
    });

    describe('JSONB queries through the probe', () => {
        it('filters by JSONB text extraction with integer cast', async () => {
            await db.seed('orders', [
                {
                    customer_id: 1,
                    status: 'pending',
                    order_date: '2026-03-01',
                    line_items: JSON.stringify([]),
                    metadata: JSON.stringify({ priority: 5 }),
                },
            ]);

            const rows = await db
                .adapter('orders')
                .whereRaw(`(metadata->>'priority')::integer = ?`, [5])
                .select('customer_id');

            expect(rows).toHaveLength(1);
        });
    });

    describe('drain helpers', () => {
        it('drainAndForward settles parked queries via PGlite', async () => {
            db.probe.always().park();

            const queryPromise = new Promise<unknown[]>((resolve, reject) => {
                setImmediate(() => {
                    db.adapter('orders').select('*').then(resolve).catch(reject);
                });
            });
            await new Promise<void>((r) => setImmediate(r));

            db.probe.drainAndForward();

            await expect(queryPromise).resolves.toEqual([]);
        });
    });
});
