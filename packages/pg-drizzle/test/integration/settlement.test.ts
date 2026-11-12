/**
 * Delta P14 → "Requirement: Probe settlement reaches the SUT" and
 * "Requirement: Out-of-order release within one PGlite session scope".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { milliseconds } from '@hochgi/test-kit';
import {
    SutTimeoutError,
    causeChain,
    createItemsRig,
    items,
    maintenanceCount,
    rejectionOf,
    tick,
    track,
    withTimeout,
    type ItemsRig,
} from './fixtures.js';

const within = milliseconds(2_000);

let ctx: ItemsRig | undefined;

afterEach(async () => {
    await ctx?.rig.close();
    ctx = undefined;
});

describe('Requirement: Probe settlement reaches the SUT', () => {
    it("Scenario: always().reject rejects the SUT's query", async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const diskFull = new Error('disk full');
        db.probe
            .sql(/insert into/)
            .always()
            .reject(diskFull);

        const err = await rejectionOf(db.adapter.insert(items).values({ name: 'never' }));

        expect(causeChain(err)).toContain(diskFull);
        expect(await maintenanceCount(db, 'items')).toBe(0);
    });

    it('Scenario: once().reject is one-shot', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        await db.seed(items, [{ name: 'real' }]);
        const transient = new Error('transient');
        db.probe.once().reject(transient);

        const first = await rejectionOf(db.adapter.select().from(items));
        const second = await db.adapter.select().from(items);

        expect(causeChain(first)).toContain(transient);
        expect(second.map((r) => r.name)).toEqual(['real']);
    });

    it('Scenario: a captured query stays pending until released', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        await db.seed(items, [{ name: 'held' }]);

        const intercepted = db.probe.sql(/from "items"/).expect.intercept({ within });
        const query = track(db.adapter.select().from(items));
        const pending = await intercepted;
        await tick();
        expect(query.settled()).toBe(false);

        pending.forward();

        expect((await query.promise).map((r) => r.name)).toEqual(['held']);
    });

    it("Scenario: a parked query lets the SUT's own timeout fire", async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        db.probe
            .sql(/select/)
            .once()
            .park();

        const err = await rejectionOf(withTimeout(Promise.resolve(db.adapter.select().from(items)), 50));

        expect(err).toBeInstanceOf(SutTimeoutError);
        expect(db.probe.calls.some((c) => /select/.test(c.sql))).toBe(true);
    });

    it('Scenario: answer passes through unchanged', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        db.probe.once().answer({ rows: [{ one: 42 }], fields: [], affectedRows: 0 });

        const result = await db.adapter.execute(sql`select 1 as one`);

        expect(result.rows).toEqual([{ one: 42 }]);
    });
});

describe('Requirement: Out-of-order release within one PGlite session scope', () => {
    it('Scenario: two concurrent queries released in reverse order', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const order: string[] = [];

        const firstCaught = db.probe.sql('select 1 as first').expect.intercept({ within });
        const secondCaught = db.probe.sql('select 2 as second').expect.intercept({ within });
        const first = db.adapter.execute(sql`select 1 as first`).then((r) => {
            order.push('first');
            return r.rows;
        });
        const second = db.adapter.execute(sql`select 2 as second`).then((r) => {
            order.push('second');
            return r.rows;
        });
        const [p1, p2] = await Promise.all([firstCaught, secondCaught]);

        p2.forward();
        expect(await second).toEqual([{ second: 2 }]);
        p1.forward();
        expect(await first).toEqual([{ first: 1 }]);
        expect(order).toEqual(['second', 'first']);
    });

    it('Scenario: two concurrent queries inside one transaction released in reverse order', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const order: string[] = [];

        const firstCaught = db.probe.sql('select 1 as first').expect.intercept({ within });
        const secondCaught = db.probe.sql('select 2 as second').expect.intercept({ within });
        const txDone = db.adapter.transaction(async (tx) => {
            await tx.insert(items).values({ name: 'committed' });
            const run = (statement: ReturnType<typeof sql>, label: string) =>
                tx.execute(statement).then((r) => {
                    order.push(label);
                    return r.rows;
                });
            return Promise.all([run(sql`select 1 as first`, 'first'), run(sql`select 2 as second`, 'second')]);
        });
        const [p1, p2] = await Promise.all([firstCaught, secondCaught]);

        p2.forward();
        await tick();
        p1.forward();

        expect(await txDone).toEqual([[{ first: 1 }], [{ second: 2 }]]);
        expect(order).toEqual(['second', 'first']);
        expect(await maintenanceCount(db, 'items')).toBe(1);
    });
});
