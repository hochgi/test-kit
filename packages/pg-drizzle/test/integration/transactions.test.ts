/**
 * Delta P14 → "Requirement: Transaction control statements are not calls;
 * savepoints are", "Requirement: Rejection inside a transaction rolls it
 * back" and "Requirement: Cross-transaction serialisation is a documented
 * limitation".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { milliseconds } from '@hochgi/test-kit';
import {
    SutTimeoutError,
    TX_CONTROL,
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

describe('Requirement: Transaction control statements are not calls; savepoints are', () => {
    it('Scenario: BEGIN and COMMIT never appear', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        await db.adapter.transaction(async (tx) => tx.select().from(items));

        expect(db.probe.calls).toHaveLength(1);
        expect(db.probe.calls.filter((c) => TX_CONTROL.test(c.sql))).toEqual([]);
    });

    it('Scenario: nested transaction yields savepoint calls', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        await db.adapter.transaction(async (tx) =>
            tx.transaction(async (inner) => inner.execute(sql`select 1 as one`)),
        );

        expect(db.probe.calls.map((c) => c.sql)).toEqual(['savepoint sp1', 'select 1 as one', 'release savepoint sp1']);
    });

    it('Scenario: nested transaction that throws rolls back to its savepoint', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const innerFailure = new Error('inner failure');

        await db.adapter.transaction(async (tx) => {
            await tx.insert(items).values({ name: 'A' });
            const err = await rejectionOf(
                tx.transaction(async (inner) => {
                    await inner.insert(items).values({ name: 'B' });
                    throw innerFailure;
                }),
            );
            expect(causeChain(err)).toContain(innerFailure);
        });

        const statements = db.probe.calls.map((c) => c.sql);
        expect(statements).toContain('rollback to savepoint sp1');
        expect(statements).not.toContain('release savepoint sp1');
        expect(statements.indexOf('savepoint sp1')).toBeLessThan(statements.indexOf('rollback to savepoint sp1'));
        const rows = await db.pglite.maintenance.execute('select name from items order by name');
        expect(rows.rows).toEqual([{ name: 'A' }]);
    });
});

describe('Requirement: Rejection inside a transaction rolls it back', () => {
    it('Scenario: rejected second write rolls back the first', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        const refused = new Error('refused B');
        db.probe
            .filter((c) => /^insert into "items"/i.test(c.sql) && c.parameters.includes('B'), 'insert B')
            .once()
            .reject(refused);

        const err = await rejectionOf(
            db.adapter.transaction(async (tx) => {
                await tx.insert(items).values({ name: 'A' });
                await tx.insert(items).values({ name: 'B' });
            }),
        );

        expect(causeChain(err)).toContain(refused);
        expect(await db.adapter.select().from(items)).toEqual([]);
        expect(await maintenanceCount(db, 'items')).toBe(0);
    });
});

describe('Requirement: Cross-transaction serialisation is a documented limitation', () => {
    it('Scenario: transaction B waits for parked transaction A', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;

        const caughtA = db.probe.sql("select 'a' as tag").expect.intercept({ within });
        const txA = track(db.adapter.transaction(async (tx) => (await tx.execute(sql`select 'a' as tag`)).rows));
        const pendingA = await caughtA;

        const txB = track(db.adapter.transaction(async (tx) => (await tx.execute(sql`select 'b' as tag`)).rows));
        const plain = track(db.adapter.execute(sql`select 'plain' as tag`).then((r) => r.rows));
        await db.probe.sql("select 'plain' as tag").expect.atLeast(1, { within });
        await db.probe.sql("select 'b' as tag").expect.none({ within: milliseconds(100) });
        await tick();
        expect(plain.settled()).toBe(false);
        expect(txA.settled()).toBe(false);
        expect(txB.settled()).toBe(false);

        pendingA.forward();

        expect(await txA.promise).toEqual([{ tag: 'a' }]);
        expect(await txB.promise).toEqual([{ tag: 'b' }]);
        expect(await plain.promise).toEqual([{ tag: 'plain' }]);
    });

    it('Scenario: a timeout thrown inside the transaction frees PGlite', async () => {
        ctx = await createItemsRig();
        const { db } = ctx;
        await db.seed(items, [{ name: 'after' }]);
        db.probe
            .sql(/from "items"/)
            .once()
            .park();

        const err = await rejectionOf(
            db.adapter.transaction(async (tx) => withTimeout(Promise.resolve(tx.select().from(items)), 50)),
        );
        const next = await withTimeout(Promise.resolve(db.adapter.select().from(items)), 2_000);

        expect(err).toBeInstanceOf(SutTimeoutError);
        expect(next.map((r) => r.name)).toEqual(['after']);
    });
});
