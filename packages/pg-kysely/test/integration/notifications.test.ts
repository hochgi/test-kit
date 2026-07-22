/**
 * Notification (LISTEN/NOTIFY) capability for the probed Kysely adapter.
 *
 * Consumer pain (cycle-processing `packages/coordination-pg/test/_wakeup-harness.ts`):
 * a NOTIFY issued through the probed Kysely could not be observed because the
 * adapter did not expose its underlying PGlite instance, and a separately
 * created listener is a different database. These tests prove the probed pair
 * now exposes a notification façade over the SAME PGlite instance the probed
 * Kysely writes through.
 *
 * Acceptance (from the brief):
 *  (a) pg_notify inside a committed transaction delivers exactly once to a
 *      same-instance listener.
 *  (b) pg_notify inside a rolled-back transaction delivers nothing.
 *  (c) the probed SQL intercept still sees the NOTIFY statement.
 *
 * NOTE: PGlite 0.3.x rejects NOTIFY with bind parameters, so the tests use
 * `pg_notify($1, $2)` (the function form), which accepts bind params.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, sql } from 'kysely';
import { createHarness, type Harness } from '@vnatures/test-kit';
import { createProbedKyselyAdapter, type ProbedKyselyAdapter } from '@vnatures/test-kit-pg-kysely';

interface TestDatabase {
    notes: { id: number; body: string };
}

async function bootstrap(db: Kysely<TestDatabase>): Promise<void> {
    await sql`
        CREATE TABLE IF NOT EXISTS notes (
            id SERIAL PRIMARY KEY,
            body TEXT NOT NULL
        )
    `.execute(db);
}

describe('createProbedKyselyAdapter — notifications', () => {
    let harness: Harness;
    let db: ProbedKyselyAdapter<TestDatabase>;

    beforeAll(async () => {
        harness = createHarness();
        db = await harness.attach(createProbedKyselyAdapter<TestDatabase>({ harness, bootstrap }));
    });

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await harness.reset();
    });

    it('exposes a notifications façade backed by the same PGlite instance', () => {
        expect(db.notifications).toBeDefined();
        expect(typeof db.notifications.listen).toBe('function');
        // The underlying handle is also exposed for advanced consumers.
        expect(db.pglite).toBeDefined();
    });

    it('delivers a pg_notify issued inside a committed transaction exactly once', async () => {
        const received: string[] = [];
        const unlisten = await db.notifications.listen('work_ready', (payload) => {
            received.push(payload);
        });
        try {
            await db.adapter
                .insertInto('notes')
                .values({ body: 'hello' })
                .execute();

            await db.adapter
                .transaction()
                .execute(async (trx) => {
                    await trx.insertInto('notes').values({ body: 'inside-tx' }).execute();
                    await sql`select pg_notify(${'work_ready'}, ${'commit-payload'})`.execute(trx);
                });

            // PGlite delivers notifications asynchronously; give it a tick.
            await waitForDeliveries();
            expect(received).toEqual(['commit-payload']);
        } finally {
            await unlisten();
        }
    });

    it('delivers nothing for a pg_notify inside a rolled-back transaction', async () => {
        const received: string[] = [];
        const unlisten = await db.notifications.listen('work_ready', (payload) => {
            received.push(payload);
        });
        try {
            await expect(
                db.adapter
                    .transaction()
                    .execute(async (trx) => {
                        await trx.insertInto('notes').values({ body: 'will-rollback' }).execute();
                        await sql`select pg_notify(${'work_ready'}, ${'rollback-payload'})`.execute(trx);
                        throw new Error('force-rollback');
                    }),
            ).rejects.toThrow('force-rollback');

            await waitForDeliveries();
            expect(received).toEqual([]);
        } finally {
            await unlisten();
        }
    });

    it('the probed SQL intercept still sees the pg_notify statement', async () => {
        const unlisten = await db.notifications.listen('work_ready', () => {
            /* no-op */
        });
        try {
            db.probe.always().park();

            const pendingPromise = db.probe.expect.intercept();
            const queryPromise = sql`select pg_notify(${'work_ready'}, ${'intercepted'})`.execute(db.adapter);

            const pending = await pendingPromise;
            expect(pending.sql.toLowerCase()).toContain('pg_notify');
            expect(pending.parameters).toContain('work_ready');
            expect(pending.parameters).toContain('intercepted');

            pending.forward();
            await queryPromise;

            await waitForDeliveries();
        } finally {
            await unlisten();
        }
    });

    it('unlisten stops further deliveries', async () => {
        const received: string[] = [];
        const unlisten = await db.notifications.listen('work_ready', (payload) => {
            received.push(payload);
        });

        await sql`select pg_notify(${'work_ready'}, ${'before-unlisten'})`.execute(db.adapter);
        await waitForDeliveries();
        expect(received).toEqual(['before-unlisten']);

        await unlisten();

        await sql`select pg_notify(${'work_ready'}, ${'after-unlisten'})`.execute(db.adapter);
        await waitForDeliveries();
        expect(received).toEqual(['before-unlisten']);
    });
});

/**
 * Flush PGlite's async notification delivery. PGlite dispatches LISTEN
 * callbacks on a microtask/macrotask after the notifying statement resolves.
 * A couple of `setTimeout(0)` ticks is empirically enough; we cap at a few
 * iterations to stay fast and deterministic.
 */
async function waitForDeliveries(ticks = 5): Promise<void> {
    for (let i = 0; i < ticks; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}
