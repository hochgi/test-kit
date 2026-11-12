/**
 * Delta P14 → "Requirement: Maintenance path is unprobed",
 * "Requirement: Lifecycle" and "Requirement: Notifications on the same
 * instance".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createRig } from '@hochgi/test-kit';
import { createProbedDrizzleAdapter } from '@hochgi/test-kit-pg-drizzle';
import { createItemsRig, items, rejectionOf, type ItemsRig } from './fixtures.js';

let ctx: ItemsRig | undefined;

afterEach(async () => {
    await ctx?.rig.close();
    ctx = undefined;
});

describe('Requirement: Maintenance path is unprobed', () => {
    it('Scenario: bootstrap and seed produce no calls', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        await db.seed(items, [{ name: 'one' }, { name: 'two' }]);
        expect(db.probe.calls).toEqual([]);

        const rows = await db.adapter.select().from(items);
        expect(rows.map((r) => r.name).sort()).toEqual(['one', 'two']);
    });

    it('Scenario: seeding no rows is a no-op', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        await expect(db.seed(items, [])).resolves.toBeUndefined();

        expect(db.probe.calls).toEqual([]);
        expect(await db.pglite.maintenance.execute('select count(*)::int as n from items')).toEqual({
            rows: [{ n: 0 }],
        });
    });
});

describe('Requirement: Lifecycle', () => {
    it('Scenario: reset empties tables and re-bootstraps', async () => {
        ctx = await createItemsRig();
        const { db, rig } = ctx;
        await db.seed(items, [{ name: 'gone' }]);

        await rig.reset();

        const tables = await db.pglite.maintenance.execute(
            `select tablename from pg_tables where schemaname = 'public' and tablename = 'items'`,
        );
        expect(tables.rows).toHaveLength(1);
        expect(await db.adapter.select().from(items)).toEqual([]);
    });

    it('Scenario: close releases PGlite', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        await db.close();

        expect(db.pglite.pglite.closed).toBe(true);
    });

    it('Scenario: bootstrap failure disposes and rethrows', async () => {
        const rig = createRig();
        const boom = new Error('boom');
        let captured: { readonly closed: boolean } | undefined;
        try {
            const err = await rejectionOf(
                createProbedDrizzleAdapter({
                    harness: rig,
                    bootstrap: async (db) => {
                        captured = clientOf(db);
                        throw boom;
                    },
                }),
            );
            expect(err).toBe(boom);
            expect(captured, 'bootstrap must have been handed a PGlite client').toBeDefined();
            expect(captured?.closed, 'the PGlite instance bootstrap saw must be closed').toBe(true);
        } finally {
            await rig.close();
        }
    });
});

describe('Requirement: Notifications on the same instance', () => {
    it('Scenario: NOTIFY through the adapter reaches a listener', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const received: string[] = [];
        const unlisten = await db.notifications.listen('work_ready', (payload) => received.push(payload));
        try {
            await db.adapter.execute(sql`select pg_notify('work_ready', 'x')`);
            await waitFor(() => received.length > 0);
            expect(received).toEqual(['x']);
        } finally {
            await unlisten();
        }
    });
});

/**
 * `bootstrap` is typed `PgliteDatabase<TSchema>`, which does not declare the
 * `$client` drizzle() attaches at runtime; read it with a runtime check.
 */
function clientOf(db: object): { readonly closed: boolean } {
    const client: unknown = Reflect.get(db, '$client');
    if (typeof client !== 'object' || client === null || typeof Reflect.get(client, 'closed') !== 'boolean') {
        throw new Error('bootstrap db has no PGlite $client');
    }
    return {
        get closed(): boolean {
            return Reflect.get(client, 'closed') === true;
        },
    };
}

/** Poll on real timers; PGlite delivers notifications asynchronously. */
async function waitFor(condition: () => boolean, attempts = 40): Promise<void> {
    for (let i = 0; i < attempts && !condition(); i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
}
