/**
 * Translated from v1 packages/core/test/db-probe.test.ts to v2 grammar.
 *
 * Tests QueryProbe behavior with a synthetic SqlDriver (no real database).
 * Exercises: default forward rule, once+reject, always+reject, expect.intercept
 * (with forward/reject), filter by SQL substring (probe.sql sugar),
 * drainAndForward, sync-throw in driver.
 *
 * v1 vocabulary mapping:
 *   probe.alwaysForward()             → (default; no call needed)
 *   probe.alwaysReject(error)         → probe.always().reject(error)
 *   probe.whenQueried().thenReject(e) → probe.once().reject(e)
 *   probe.whenQueried().thenForward() → probe.once().forward()
 *   probe.expectNext(ms?)             → probe.expect.intercept({ within: ms })
 *   probe.expectMatching(p, ms?)      → probe.filter(p).expect.intercept({ within: ms })
 *   probe.queries                     → probe.calls
 *   probe.clearBehavior()             → probe.clearRules({ includeDefaults: true })
 *   probe.drainAndForwardAll()        → probe.drainAndForward()
 *   probe.drainAndRejectAll(e?)       → probe.drainAndReject(e)
 *   pendingCount()                    → (dropped)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRig, milliseconds, type Rig, type ProbeRoot } from '@vnatures/test-kit';
import {
    createProbedSqlAdapter,
    type QueryCall,
    type QueryPendingCall,
    type QueryProbe,
    type SqlDriver,
} from '@vnatures/test-kit-sql';

const selectUsers: QueryCall = { sql: 'SELECT * FROM users', parameters: [] };
const insertOrder: QueryCall = {
    sql: 'INSERT INTO orders (id) VALUES ($1)',
    parameters: [42],
};

/**
 * Test fixture: builds a probe wired to a synthetic driver where every
 * forward call is settled by `nextResult` (or throws if a forward error
 * has been queued). Exposes `dispatch(call)` as the SUT entry point.
 */
function setup(rig: Rig): {
    probe: QueryProbe;
    dispatch: (call: QueryCall) => Promise<unknown>;
    setNextResult: (value: unknown) => void;
    setForwardError: (err: Error) => void;
} {
    let nextResult: unknown = { rows: [] };
    let throwOnForward = false;

    // eslint-disable-next-line prefer-const -- declared up-front so `driver.onApplicationQuery` can capture it; assigned once after `createProbedSqlAdapter` returns.
    let root: ProbeRoot<QueryCall, QueryPendingCall>;
    const driver: SqlDriver = {
        onApplicationQuery(call) {
            return root.recordCall(call, async () => {
                if (throwOnForward) throw nextResult as Error;
                return nextResult;
            });
        },
        reset: async () => {
            /* no-op */
        },
        close: async () => {
            /* no-op */
        },
    };

    const sqlAdapter = createProbedSqlAdapter({ harness: rig, driver });
    root = sqlAdapter.probeRoot;

    return {
        probe: sqlAdapter.probe,
        dispatch: (call) => driver.onApplicationQuery(call),
        setNextResult: (value) => {
            nextResult = value;
            throwOnForward = false;
        },
        setForwardError: (err) => {
            nextResult = err;
            throwOnForward = true;
        },
    };
}

describe('QueryProbe (synthetic driver)', () => {
    let rig: Rig;
    let probe: QueryProbe;
    let dispatch: (call: QueryCall) => Promise<unknown>;
    let setNextResult: (value: unknown) => void;
    let setForwardError: (err: Error) => void;

    beforeEach(() => {
        rig = createRig();
        ({ probe, dispatch, setNextResult, setForwardError } = setup(rig));
    });

    afterEach(async () => {
        await rig.close();
    });

    describe('default forward rule', () => {
        it('resolves with the result of the driver forward', async () => {
            setNextResult({ rows: [{ id: 1 }] });
            await expect(dispatch(selectUsers)).resolves.toEqual({ rows: [{ id: 1 }] });
        });

        it('records queries in probe.calls', async () => {
            await dispatch(selectUsers);
            await dispatch(insertOrder);

            expect(probe.calls).toHaveLength(2);
            expect(probe.calls[0].sql).toBe('SELECT * FROM users');
            expect(probe.calls[1].parameters).toEqual([42]);
        });
    });

    describe('always().reject(error)', () => {
        it('rejects every query with the given error', async () => {
            probe.always().reject(new Error('db down'));

            await expect(dispatch(selectUsers)).rejects.toThrow('db down');
            await expect(dispatch(insertOrder)).rejects.toThrow('db down');
        });

        it('clearRules() restores default forward', async () => {
            probe.always().reject(new Error('nope'));
            await expect(dispatch(selectUsers)).rejects.toThrow('nope');

            probe.clearRules();
            setNextResult('ok');
            await expect(dispatch(selectUsers)).resolves.toBe('ok');
        });
    });

    describe('once() — one-shot rules', () => {
        it('once().reject(e) rejects only the next query, then default forward resumes', async () => {
            probe.once().reject(new Error('transient'));

            await expect(dispatch(selectUsers)).rejects.toThrow('transient');

            setNextResult('recovered');
            await expect(dispatch(selectUsers)).resolves.toBe('recovered');
        });

        it('once().forward() bypasses an always().reject', async () => {
            probe.always().reject(new Error('perm'));
            probe.once().forward();

            setNextResult('through');
            await expect(dispatch(selectUsers)).resolves.toBe('through');

            // Subsequent queries hit always().reject.
            await expect(dispatch(selectUsers)).rejects.toThrow('perm');
        });
    });

    describe('expect.intercept (capturing waiter)', () => {
        it('captures an unsettled query and allows forward()', async () => {
            const pendingPromise = probe.expect.intercept();
            const queryPromise = dispatch(selectUsers);

            const pending = await pendingPromise;
            expect(pending.sql).toBe('SELECT * FROM users');
            expect(pending.settled).toBe(false);

            setNextResult('data');
            pending.forward();
            expect(pending.settled).toBe(true);

            await expect(queryPromise).resolves.toBe('data');
        });

        it('captures a query and allows reject()', async () => {
            const pendingPromise = probe.expect.intercept();
            const queryPromise = dispatch(selectUsers);

            const pending = await pendingPromise;
            pending.reject(new Error('injected'));

            await expect(queryPromise).rejects.toThrow('injected');
        });

        it('throws if forward() is called twice on the same pending', async () => {
            const pendingPromise = probe.expect.intercept();
            const queryPromise = dispatch(selectUsers);

            const pending = await pendingPromise;
            pending.forward();
            await queryPromise;

            expect(() => pending.forward()).toThrow(/already settled/);
        });

        it('times out if no query arrives', async () => {
            await expect(probe.expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
        });
    });

    describe('probe.sql() typed sugar', () => {
        it('matches by sql substring (regex)', async () => {
            const pendingPromise = probe.sql(/orders/i).expect.intercept();
            const queryPromise = dispatch(insertOrder);

            const pending = await pendingPromise;
            expect(pending.sql).toContain('orders');
            setNextResult('inserted');
            pending.forward();
            await expect(queryPromise).resolves.toBe('inserted');
        });

        it('waits for matching query, ignoring earlier non-matches', async () => {
            const pendingPromise = probe.sql(/orders/i).expect.intercept();

            // First query (selectUsers) shouldn't match — default forward handles it.
            setNextResult({ rows: [] });
            await dispatch(selectUsers);

            // Second query (insertOrder) matches.
            const queryPromise = dispatch(insertOrder);
            const pending = await pendingPromise;
            setNextResult('found');
            pending.forward();
            await expect(queryPromise).resolves.toBe('found');
        });

        it('matches by exact-string', async () => {
            const pendingPromise = probe.sql('SELECT * FROM users').expect.intercept();
            const queryPromise = dispatch(selectUsers);

            const pending = await pendingPromise;
            setNextResult('exact-match');
            pending.forward();
            await expect(queryPromise).resolves.toBe('exact-match');
        });

        it('matches by predicate function', async () => {
            const pendingPromise = probe.sql((sql) => sql.startsWith('INSERT')).expect.intercept();
            const queryPromise = dispatch(insertOrder);

            const pending = await pendingPromise;
            setNextResult('predicated');
            pending.forward();
            await expect(queryPromise).resolves.toBe('predicated');
        });
    });

    describe('clearRules({ includeDefaults: true }) — fully cleared probe', () => {
        it('makes queries hang until drained', async () => {
            probe.clearRules({ includeDefaults: true });

            let resolved = false;
            const queryPromise = dispatch(selectUsers).then(() => {
                resolved = true;
            });

            await new Promise<void>((r) => setImmediate(r));
            expect(resolved).toBe(false);

            setNextResult('through');
            probe.drainAndForward();

            await queryPromise;
            expect(resolved).toBe(true);
        });
    });

    describe('drain helpers', () => {
        it('drainAndForward settles parked queries via the driver', async () => {
            probe.clearRules({ includeDefaults: true });

            setNextResult('a');
            const q1 = dispatch(selectUsers);
            const q2 = dispatch(insertOrder);

            probe.drainAndForward();

            await expect(q1).resolves.toBe('a');
            await expect(q2).resolves.toBe('a');
        });

        it('drainAndReject rejects parked queries', async () => {
            probe.clearRules({ includeDefaults: true });
            const q1 = dispatch(selectUsers);

            probe.drainAndReject(new Error('bulk'));

            await expect(q1).rejects.toThrow('bulk');
        });
    });

    describe('synchronous throw in driver.forward', () => {
        it('rejects when intercept-then-forward calls a throwing driver', async () => {
            const pendingPromise = probe.expect.intercept();
            const queryPromise = dispatch(selectUsers);

            const pending = await pendingPromise;
            setForwardError(new Error('sync boom'));
            pending.forward();

            await expect(queryPromise).rejects.toThrow('sync boom');
        });

        it('rejects when default forward auto-fires a throwing driver', async () => {
            setForwardError(new Error('auto sync boom'));

            await expect(dispatch(selectUsers)).rejects.toThrow('auto sync boom');
        });
    });
});
