/**
 * Unit tests for DbProbe.
 *
 * Uses mock forwardFn closures — no ORM or database needed.
 */
import { DbProbe, type PendingQuery } from '../src';

function mockForwardFn(result: unknown = { rows: [] }): () => Promise<unknown> {
    return () => Promise.resolve(result);
}

const selectUsers = { sql: 'SELECT * FROM users', parameters: [] as unknown[] };
const insertOrder = { sql: 'INSERT INTO orders (id) VALUES ($1)', parameters: [42] };

describe('DbProbe', () => {
    let probe: DbProbe;

    beforeEach(() => {
        probe = new DbProbe();
    });

    // ── alwaysForward ────────────────────────────────────────────────────────

    describe('alwaysForward', () => {
        it('resolves with the result of forwardFn', async () => {
            probe.alwaysForward();
            const result = await probe.recordQuery(selectUsers, mockForwardFn({ rows: [{ id: 1 }] }));
            expect(result).toEqual({ rows: [{ id: 1 }] });
        });

        it('records queries in the queries getter', async () => {
            probe.alwaysForward();
            await probe.recordQuery(selectUsers, mockForwardFn());
            await probe.recordQuery(insertOrder, mockForwardFn());

            expect(probe.queries).toHaveLength(2);
            expect(probe.queries[0].sql).toBe('SELECT * FROM users');
            expect(probe.queries[1].parameters).toEqual([42]);
        });
    });

    // ── alwaysReject ─────────────────────────────────────────────────────────

    describe('alwaysReject', () => {
        it('rejects every query with the given error', async () => {
            probe.alwaysReject(new Error('db down'));

            await expect(probe.recordQuery(selectUsers, mockForwardFn())).rejects.toThrow('db down');
            await expect(probe.recordQuery(insertOrder, mockForwardFn())).rejects.toThrow('db down');
        });

        it('can be switched back to alwaysForward', async () => {
            probe.alwaysReject(new Error('nope'));
            await expect(probe.recordQuery(selectUsers, mockForwardFn())).rejects.toThrow('nope');

            probe.alwaysForward();
            const result = await probe.recordQuery(selectUsers, mockForwardFn('ok'));
            expect(result).toBe('ok');
        });
    });

    // ── whenQueried ──────────────────────────────────────────────────────────

    describe('whenQueried', () => {
        beforeEach(() => {
            probe.alwaysForward();
        });

        it('thenReject rejects only the next query', async () => {
            probe.whenQueried().thenReject(new Error('transient'));

            await expect(probe.recordQuery(selectUsers, mockForwardFn())).rejects.toThrow('transient');
            const result = await probe.recordQuery(selectUsers, mockForwardFn('recovered'));
            expect(result).toBe('recovered');
        });

        it('thenForward forwards the next query even if permanent is reject', async () => {
            probe.alwaysReject(new Error('perm'));
            probe.whenQueried().thenForward();

            const result = await probe.recordQuery(selectUsers, mockForwardFn('through'));
            expect(result).toBe('through');

            await expect(probe.recordQuery(selectUsers, mockForwardFn())).rejects.toThrow('perm');
        });
    });

    // ── expectNext / expectMatching ──────────────────────────────────────────

    describe('expectNext', () => {
        it('captures an unsettled query and allows forward', async () => {
            const pendingPromise = probe.expectNext();
            const queryPromise = probe.recordQuery(selectUsers, mockForwardFn('data'));

            const pending = await pendingPromise;
            expect(pending.sql).toBe('SELECT * FROM users');
            expect(pending.settled).toBe(false);

            pending.forward();
            expect(pending.settled).toBe(true);
            await expect(queryPromise).resolves.toBe('data');
        });

        it('captures a query and allows reject', async () => {
            const pendingPromise = probe.expectNext();
            const queryPromise = probe.recordQuery(selectUsers, mockForwardFn());

            const pending = await pendingPromise;
            pending.reject(new Error('injected'));

            await expect(queryPromise).rejects.toThrow('injected');
        });

        it('throws if forward is called twice', async () => {
            const pendingPromise = probe.expectNext();
            const queryPromise = probe.recordQuery(selectUsers, mockForwardFn());

            const pending = await pendingPromise;
            pending.forward();
            await queryPromise;

            expect(() => pending.forward()).toThrow('already settled');
        });

        it('times out if no query arrives', async () => {
            await expect(probe.expectNext(50)).rejects.toThrow('Timed out');
        });
    });

    describe('expectMatching', () => {
        it('matches by SQL content', async () => {
            const pendingPromise = probe.expectMatching((q) => q.sql.includes('orders'));
            const queryPromise = probe.recordQuery(insertOrder, mockForwardFn('inserted'));

            const pending = await pendingPromise;
            expect(pending.sql).toContain('orders');
            pending.forward();
            await expect(queryPromise).resolves.toBe('inserted');
        });

        it('waits if no match yet, then resolves when matching query arrives', async () => {
            const pendingPromise = probe.expectMatching((q) => q.sql.includes('orders'));

            probe.alwaysForward();
            await probe.recordQuery(selectUsers, mockForwardFn());

            const queryPromise = probe.recordQuery(insertOrder, mockForwardFn('found'));
            const pending = await pendingPromise;
            pending.forward();
            await expect(queryPromise).resolves.toBe('found');
        });
    });

    // ── clearBehavior ────────────────────────────────────────────────────────

    describe('clearBehavior', () => {
        it('makes queries hang until explicitly settled', async () => {
            probe.alwaysForward();
            probe.clearBehavior();

            let didResolve = false;
            const queryPromise = probe.recordQuery(selectUsers, mockForwardFn()).then(() => {
                didResolve = true;
            });

            await new Promise<void>((r) => setImmediate(r));
            expect(didResolve).toBe(false);

            probe.drainAndForwardAll();
            await queryPromise;
            expect(didResolve).toBe(true);
        });
    });

    // ── drain helpers ────────────────────────────────────────────────────────

    describe('drain helpers', () => {
        it('drainAndForwardAll settles pending queries', async () => {
            const q1 = probe.recordQuery(selectUsers, mockForwardFn('a'));
            const q2 = probe.recordQuery(insertOrder, mockForwardFn('b'));

            probe.drainAndForwardAll();

            await expect(q1).resolves.toBe('a');
            await expect(q2).resolves.toBe('b');
        });

        it('drainAndRejectAll rejects pending queries', async () => {
            const q1 = probe.recordQuery(selectUsers, mockForwardFn());

            probe.drainAndRejectAll(new Error('bulk'));

            await expect(q1).rejects.toThrow('bulk');
        });

        it('pendingCount tracks unconsumed queries', () => {
            void probe.recordQuery(selectUsers, mockForwardFn());
            void probe.recordQuery(insertOrder, mockForwardFn());

            expect(probe.pendingCount()).toBe(2);

            probe.drain();
            expect(probe.pendingCount()).toBe(0);
        });
    });

    // ── synchronous throw in forwardFn ───────────────────────────────────────

    describe('synchronous forwardFn throw', () => {
        it('rejects the query when forward() calls a throwing forwardFn', async () => {
            const pendingPromise = probe.expectNext();
            const queryPromise = probe.recordQuery(selectUsers, () => {
                throw new Error('sync boom');
            });

            const pending = await pendingPromise;
            pending.forward();

            await expect(queryPromise).rejects.toThrow('sync boom');
        });

        it('rejects the query when alwaysForward auto-forwards a throwing forwardFn', async () => {
            probe.alwaysForward();

            await expect(
                probe.recordQuery(selectUsers, () => {
                    throw new Error('auto sync boom');
                }),
            ).rejects.toThrow('auto sync boom');
        });
    });
});
