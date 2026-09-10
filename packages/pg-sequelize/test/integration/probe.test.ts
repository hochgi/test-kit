/**
 * Translated from v1 packages/pg-sequelize/test/{db-probe,test-db,integration}.test.ts
 * to v2 grammar.
 *
 * Exercises createProbedSequelizeAdapter against PGlite: bootstrap, seed,
 * reset, JSONB, default forward, always().reject, once().reject,
 * expect.intercept with forward/reject, probe.sql() filter.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { createRig, type Rig } from '@vnatures/test-kit';
import { createProbedSequelizeAdapter, type ProbedSequelizeAdapter } from '@vnatures/test-kit-pg-sequelize';

async function bootstrap(sequelize: Sequelize): Promise<void> {
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
    CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR NOT NULL,
        category VARCHAR NOT NULL,
        price_cents INTEGER NOT NULL,
        in_stock BOOLEAN NOT NULL DEFAULT true,
        deleted_at TIMESTAMP
    )
  `);

    await sequelize.query(`
    CREATE TABLE IF NOT EXISTS tagging_policies (
        id SERIAL PRIMARY KEY,
        name VARCHAR NOT NULL,
        conditions JSONB NOT NULL DEFAULT '[]',
        rule JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('createProbedSequelizeAdapter', () => {
    let rig: Rig;
    let db: ProbedSequelizeAdapter;

    beforeAll(async () => {
        rig = createRig();
        db = await rig.attach(createProbedSequelizeAdapter({ harness: rig, bootstrap }));
    });

    afterAll(async () => {
        await rig.close();
    });

    afterEach(async () => {
        await rig.reset();
    });

    describe('default forward rule', () => {
        it('forwards queries to PGlite and returns real results', async () => {
            await db.seed('orders' as never, [
                {
                    customer_id: 42,
                    status: 'shipped',
                    order_date: '2026-03-15',
                    line_items: [{ sku: 'WIDGET-A', qty: 2, price: 1999 }],
                    metadata: null,
                },
            ]);

            const rows = await db.adapter.query(`SELECT line_items FROM orders WHERE customer_id = 42`, {
                type: QueryTypes.SELECT,
            });

            expect(rows).toHaveLength(1);
            const row = rows[0] as Record<string, unknown>;
            const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
            expect((items as Array<{ sku: string }>)[0].sku).toBe('WIDGET-A');
        });

        it('records queries in probe.calls', async () => {
            const before = db.probe.calls.length;
            await db.adapter.query(`SELECT * FROM products`, { type: QueryTypes.SELECT });
            expect(db.probe.calls.length).toBeGreaterThan(before);
        });
    });

    describe('once().reject', () => {
        it('rejects only the next query', async () => {
            db.probe.once().reject(new Error('transient'));

            await expect(db.adapter.query(`SELECT * FROM orders`, { type: QueryTypes.SELECT })).rejects.toThrow(
                'transient',
            );

            const rows = await db.adapter.query(`SELECT * FROM orders`, {
                type: QueryTypes.SELECT,
            });
            expect(rows).toEqual([]);
        });
    });

    describe('always().reject', () => {
        it('rejects all queries until clearRules', async () => {
            db.probe.always().reject(new Error('db down'));

            await expect(db.adapter.query(`SELECT * FROM orders`, { type: QueryTypes.SELECT })).rejects.toThrow(
                'db down',
            );

            db.probe.clearRules();

            const rows = await db.adapter.query(`SELECT * FROM orders`, {
                type: QueryTypes.SELECT,
            });
            expect(rows).toEqual([]);
        });
    });

    describe('expect.intercept', () => {
        it('captures a query and allows explicit forward', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.expect.intercept();
            const queryPromise = db.adapter.query(`SELECT * FROM orders`, {
                type: QueryTypes.SELECT,
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
            const queryPromise = db.adapter.query(`SELECT * FROM orders`, {
                type: QueryTypes.SELECT,
            });

            const pending = await pendingPromise;
            pending.reject(new Error('injected'));

            await expect(queryPromise).rejects.toThrow('injected');
        });
    });

    describe('probe.sql() filter', () => {
        it('matches by sql substring (regex)', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.sql(/products/i).expect.intercept();
            const queryPromise = db.adapter.query(`SELECT name FROM products WHERE category = 'electronics'`, {
                type: QueryTypes.SELECT,
            });

            const pending = await pendingPromise;
            expect(pending.sql).toContain('products');
            pending.forward();
            await queryPromise;
        });
    });

    describe('seed and reset', () => {
        it('seed flows through maintenance connection', async () => {
            const before = db.probe.calls.length;

            await db.seed('products' as never, [
                { name: 'Keyboard', category: 'accessories', price_cents: 7900, in_stock: true },
            ]);

            expect(db.probe.calls.length).toBe(before);

            const rows = await db.adapter.query(
                `SELECT name FROM products WHERE category = 'accessories' AND deleted_at IS NULL`,
                { type: QueryTypes.SELECT },
            );

            expect(rows).toHaveLength(1);
            expect((rows[0] as { name: string }).name).toBe('Keyboard');
        });

        it('reset clears data', async () => {
            await db.seed('products' as never, [
                { name: 'Mouse', category: 'accessories', price_cents: 2900, in_stock: true },
            ]);

            await db.reset();

            const rows = await db.adapter.query(`SELECT * FROM products`, {
                type: QueryTypes.SELECT,
            });
            expect(rows).toHaveLength(0);
        });
    });

    describe('JSONB queries through the probe', () => {
        it('filters by JSONB text extraction with integer cast', async () => {
            await db.seed('orders' as never, [
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

            const rows = await db.adapter.query(
                `SELECT customer_id FROM orders WHERE (metadata->>'priority')::integer = 5`,
                { type: QueryTypes.SELECT },
            );

            expect(rows).toHaveLength(1);
            expect((rows[0] as { customer_id: number }).customer_id).toBe(2);
        });

        it('seeds and queries complex JSONB conditions', async () => {
            await db.seed('tagging_policies' as never, [
                {
                    name: 'Crane Tagging',
                    conditions: [
                        { entities: ['crane'], values: ['tower_crane'], operator: 'equals' },
                        { entities: ['load'], values: [1000, 2000], operator: 'between' },
                    ],
                    rule: { entities: ['tag'], values: ['heavy_lift'], operator: 'assign' },
                },
            ]);

            const rows = await db.adapter.query(
                `SELECT name, conditions, rule FROM tagging_policies WHERE name = 'Crane Tagging'`,
                { type: QueryTypes.SELECT },
            );

            expect(rows).toHaveLength(1);
            const row = rows[0] as Record<string, unknown>;
            const conditions = typeof row.conditions === 'string' ? JSON.parse(row.conditions) : row.conditions;
            expect(conditions).toHaveLength(2);
            expect((conditions as Array<{ operator: string }>)[0].operator).toBe('equals');
        });
    });
});
