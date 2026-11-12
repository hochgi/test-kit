/**
 * Delta P14 → "Requirement: Package and factory shape",
 * "Requirement: Default rule forwards every application statement" and
 * "Requirement: Other PGlite members pass through unprobed".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { createItemsRig, items, maintenanceCount, type ItemsRig } from './fixtures.js';

let ctx: ItemsRig | undefined;

afterEach(async () => {
    await ctx?.rig.close();
    ctx = undefined;
});

describe('Requirement: Package and factory shape', () => {
    it('Scenario: factory resolves to the documented handle', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        expect(db.adapter).toBeDefined();
        expect(typeof db.probe.sql).toBe('function');
        expect(typeof db.probe.filter).toBe('function');
        expect(Array.isArray(db.probe.calls)).toBe(true);
        expect(db.probe.expect).toBeDefined();
        expect(typeof db.seed).toBe('function');
        expect(typeof db.reset).toBe('function');
        expect(typeof db.close).toBe('function');
        expect(db.pglite).toBeDefined();
        expect(db.notifications).toBe(db.pglite.notifications);
    });
});

describe('Requirement: Default rule forwards every application statement', () => {
    it('Scenario: forward returns real rows', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        await db.seed(items, [{ name: 'widget' }]);

        const query = db.adapter.select().from(items).where(eq(items.name, 'widget'));
        const expected = query.toSQL();
        const rows = await query;

        expect(rows).toEqual([{ id: 1, name: 'widget' }]);
        expect(db.probe.calls).toHaveLength(1);
        expect(db.probe.calls[0]?.sql).toBe(expected.sql);
        expect(db.probe.calls[0]?.parameters).toEqual(['widget']);
    });

    it('Scenario: relational query is probed', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        await db.seed(items, [{ name: 'a' }, { name: 'b' }]);

        const rows = await db.adapter.query.items.findMany({ orderBy: (t, { asc }) => [asc(t.id)] });

        expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
        expect(db.probe.calls.some((c) => /^select\b/i.test(c.sql) && c.sql.includes('"items"'))).toBe(true);
    });

    it('Scenario: raw execute is probed', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        const result = await db.adapter.execute(sql`select 1 as one`);

        expect(result.rows).toEqual([{ one: 1 }]);
        expect(db.probe.calls.map((c) => c.sql)).toContain('select 1 as one');
    });

    it('Scenario: prepared query is probed on each execution', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        await db.seed(items, [{ name: 'a' }, { name: 'b' }]);

        const prepared = db.adapter
            .select()
            .from(items)
            .where(eq(items.name, sql.placeholder('name')))
            .prepare('items_by_name');
        await prepared.execute({ name: 'a' });
        await prepared.execute({ name: 'b' });

        expect(db.probe.calls).toHaveLength(2);
        expect(db.probe.calls[0]?.sql).toBe(db.probe.calls[1]?.sql);
        expect(db.probe.calls.map((c) => c.parameters)).toEqual([['a'], ['b']]);
    });

    it('Scenario: statements inside a transaction are probed', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        const rows = await db.adapter.transaction(async (tx) => {
            await tx.insert(items).values({ name: 'in-tx' });
            return tx.select().from(items);
        });

        expect(rows.map((r) => r.name)).toEqual(['in-tx']);
        const statements = db.probe.calls.map((c) => c.sql);
        expect(statements).toHaveLength(2);
        expect(statements[0]).toMatch(/^insert into "items"/i);
        expect(statements[1]).toMatch(/^select\b.*from "items"/i);
        expect(await maintenanceCount(db, 'items')).toBe(1);
    });
});

describe('Requirement: Other PGlite members pass through unprobed', () => {
    it('Scenario: $client members behave like the real instance', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const client = clientOf(db.adapter);

        const result = await client.exec('select 3 as three');

        expect(result).toHaveLength(1);
        expect(result[0]?.rows).toEqual([{ three: 3 }]);
        expect(client.closed).toBe(false);
        expect(client.constructor).toBe(PGlite);
        expect(db.probe.calls).toEqual([]);
    });

    it('Scenario: query without parameters records an empty parameter list', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const client = clientOf(db.adapter);

        const result = await client.query('select 2 as two');

        expect(result.rows).toEqual([{ two: 2 }]);
        expect(db.probe.calls).toEqual([{ sql: 'select 2 as two', parameters: [] }]);
    });
});

/** The adapter's `$client` (not on the `PgliteDatabase` type), runtime-checked. */
function clientOf(adapter: object): PGlite {
    const client: unknown = Reflect.get(adapter, '$client');
    if (
        typeof client !== 'object' ||
        client === null ||
        typeof Reflect.get(client, 'exec') !== 'function' ||
        typeof Reflect.get(client, 'query') !== 'function' ||
        typeof Reflect.get(client, 'closed') !== 'boolean'
    ) {
        throw new Error('adapter has no PGlite $client');
    }
    return client as PGlite;
}
