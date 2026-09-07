/**
 * Translated from v1 packages/pg-kysely/test/db-probe.test.ts and
 * v1 packages/pg-kysely/test/test-db.test.ts to v2 grammar.
 *
 * Exercises the full createProbedKyselyAdapter lifecycle against PGlite:
 * bootstrap, seed, reset, JSONB queries, soft-delete filters, default
 * forward rule, always().reject, once().reject, expect.intercept with
 * forward/reject, probe.sql() filter, drainAndForward, extensions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ColumnType, JSONColumnType, Kysely, sql } from 'kysely';
import { createRig, type Rig } from '@vnatures/test-kit';
import { createProbedKyselyAdapter, type ProbedKyselyAdapter } from '@vnatures/test-kit-pg-kysely';

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

describe('createProbedKyselyAdapter', () => {
    let rig: Rig;
    let db: ProbedKyselyAdapter<TestDatabase>;

    beforeAll(async () => {
        rig = createRig();
        db = await rig.attach(createProbedKyselyAdapter<TestDatabase>({ harness: rig, bootstrap }));
    });

    afterAll(async () => {
        await rig.close();
    });

    afterEach(async () => {
        await rig.reset();
    });

    describe('default forward rule', () => {
        it('forwards application queries to PGlite and returns real results', async () => {
            await db.seed('orders', [
                {
                    customer_id: 42,
                    status: 'shipped',
                    order_date: '2026-03-15',
                    line_items: [{ sku: 'WIDGET-A', qty: 2, price: 1999 }],
                    metadata: null,
                },
            ]);

            const row = await db.adapter
                .selectFrom('orders')
                .where('customer_id', '=', 42)
                .select(['line_items'])
                .executeTakeFirstOrThrow();

            const items = typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items;
            expect(items[0].sku).toBe('WIDGET-A');
        });

        it('records application queries in probe.calls', async () => {
            const before = db.probe.calls.length;
            await db.adapter.selectFrom('products').selectAll().execute();
            expect(db.probe.calls.length).toBeGreaterThan(before);
        });
    });

    describe('once().reject — single-query interception', () => {
        it('rejects only the next query, then default forward resumes', async () => {
            db.probe.once().reject(new Error('transient'));

            await expect(db.adapter.selectFrom('orders').selectAll().execute()).rejects.toThrow('transient');

            const rows = await db.adapter.selectFrom('orders').selectAll().execute();
            expect(rows).toEqual([]);
        });
    });

    describe('always().reject — permanent override of default forward', () => {
        it('rejects all queries until clearRules() restores default', async () => {
            db.probe.always().reject(new Error('db down'));

            await expect(db.adapter.selectFrom('orders').selectAll().execute()).rejects.toThrow('db down');
            await expect(db.adapter.selectFrom('products').selectAll().execute()).rejects.toThrow('db down');

            db.probe.clearRules();
            const rows = await db.adapter.selectFrom('orders').selectAll().execute();
            expect(rows).toEqual([]);
        });
    });

    describe('expect.intercept — capturing waiter', () => {
        it('captures a query and allows explicit forward', async () => {
            // park the default so the test owns the intercept timing
            db.probe.always().park();

            const pendingPromise = db.probe.expect.intercept();
            const queryPromise = db.adapter.selectFrom('orders').selectAll().execute();

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
            const queryPromise = db.adapter.selectFrom('orders').selectAll().execute();

            const pending = await pendingPromise;
            pending.reject(new Error('injected failure'));

            await expect(queryPromise).rejects.toThrow('injected failure');
        });

        it('throws if forward is called twice on the same pending', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.expect.intercept();
            const queryPromise = db.adapter.selectFrom('orders').selectAll().execute();

            const pending = await pendingPromise;
            pending.forward();
            await queryPromise;

            expect(() => pending.forward()).toThrow(/already settled/);
        });
    });

    describe('probe.sql() filter', () => {
        it('intercepts a query matching a sql substring', async () => {
            db.probe.always().park();

            const pendingPromise = db.probe.sql(/products/i).expect.intercept();
            const queryPromise = db.adapter
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

    describe('seed and reset through maintenance connection', () => {
        it('seed flows to PGlite without going through the probe', async () => {
            const before = db.probe.calls.length;

            await db.seed('products', [
                {
                    name: 'Keyboard',
                    category: 'accessories',
                    price_cents: 7900,
                    in_stock: true,
                },
            ]);

            // seed uses the maintenance connection, so probe doesn't see it.
            // Reading the data DOES go through the probe.
            expect(db.probe.calls.length).toBe(before);

            const rows = await db.adapter
                .selectFrom('products')
                .select(['name'])
                .where('category', '=', 'accessories')
                .where('deleted_at', 'is', null)
                .execute();

            expect(rows).toHaveLength(1);
            expect(rows[0].name).toBe('Keyboard');
        });

        it('reset clears all user table data; tables remain (bootstrap preserved)', async () => {
            await db.seed('products', [
                {
                    name: 'Mouse',
                    category: 'accessories',
                    price_cents: 2900,
                    in_stock: true,
                },
            ]);

            await db.reset();

            const rows = await db.adapter.selectFrom('products').selectAll().execute();
            expect(rows).toHaveLength(0);

            const tables = await sql<{ tablename: string }>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `.execute(db.adapter);

            const sortedTables = tables.rows.map((r) => r.tablename).sort();
            expect(sortedTables).toEqual(['orders', 'products']);
        });
    });

    describe('drain helpers', () => {
        it('drainAndForward settles parked queries via PGlite', async () => {
            db.probe.always().park();

            const queryPromise = db.adapter.selectFrom('orders').selectAll().execute();
            // give the runtime a tick so the query has reached the probe.
            await new Promise<void>((r) => setImmediate(r));

            db.probe.drainAndForward();

            await expect(queryPromise).resolves.toEqual([]);
        });
    });

    describe('JSONB queries through the probe', () => {
        it('filters by JSONB text extraction with integer cast', async () => {
            await db.seed('orders', [
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

            const rows = await db.adapter
                .selectFrom('orders')
                .where(sql`(metadata->>'priority')::integer`, '=', 5)
                .select(['customer_id'])
                .execute();

            expect(rows).toHaveLength(1);
            expect(rows[0].customer_id).toBe(2);
        });
    });
});

describe('createProbedKyselyAdapter — extensions', () => {
    it('loads uuid-ossp extension; uuid_generate_v4() works', async () => {
        // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
        const { uuid_ossp } = (await import('@electric-sql/pglite/contrib/uuid_ossp')) as {
            uuid_ossp: unknown;
        };

        const rig = createRig();
        const db = await rig.attach(
            createProbedKyselyAdapter<{ uuid_test: { id: string; label: string } }>({
                harness: rig,
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
            }),
        );

        try {
            await db.seed('uuid_test', [{ label: 'auto-uuid' }]);
            const rows = await db.adapter.selectFrom('uuid_test').select(['id', 'label']).execute();
            expect(rows).toHaveLength(1);
            expect(rows[0].label).toBe('auto-uuid');
            expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        } finally {
            await rig.close();
        }
    });

    it('extensions survive rig.reset()', async () => {
        // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
        const { uuid_ossp } = (await import('@electric-sql/pglite/contrib/uuid_ossp')) as {
            uuid_ossp: unknown;
        };

        const rig = createRig();
        const db = await rig.attach(
            createProbedKyselyAdapter<{ uuid_test: { id: string; label: string } }>({
                harness: rig,
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
            }),
        );

        try {
            await db.seed('uuid_test', [{ label: 'before-reset' }]);
            await rig.reset();
            await db.seed('uuid_test', [{ label: 'after-reset' }]);

            const rows = await db.adapter.selectFrom('uuid_test').select(['id', 'label']).execute();
            expect(rows).toHaveLength(1);
            expect(rows[0].label).toBe('after-reset');
        } finally {
            await rig.close();
        }
    });
});
