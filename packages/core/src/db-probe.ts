import { realSetTimeout, realClearTimeout, type Deferred, createDeferred, toError } from './internal';

// ── Public types ─────────────────────────────────────────────────────────────

export interface QueryCall {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
}

export interface PendingQuery {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
    readonly settled: boolean;
    /** Forward the query to the real database and resolve with its result. */
    forward(): void;
    /** Reject the query with the given error without hitting the database. */
    reject(error: unknown): void;
}

// ── Internal state ────────────────────────────────────────────────────────────

type QueryInternal = {
    index: number;
    sql: string;
    parameters: ReadonlyArray<unknown>;
    deferred: Deferred<unknown>;
    forwardFn: () => Promise<unknown>;
    settled: boolean;
};

type PlannedBehavior = { type: 'forward' } | { type: 'reject'; error: unknown };

type Waiter = {
    predicate: (call: QueryCall) => boolean;
    resolve: (pending: PendingQuery) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof realSetTimeout>;
};

// ── PendingQuery factory ──────────────────────────────────────────────────────

function makePendingQuery(internal: QueryInternal): PendingQuery {
    return {
        get sql() {
            return internal.sql;
        },
        get parameters() {
            return internal.parameters;
        },
        get settled() {
            return internal.settled;
        },
        forward() {
            if (internal.settled) {
                throw new Error('Query is already settled.');
            }
            internal.settled = true;
            try {
                internal.forwardFn().then(
                    (result) => internal.deferred.resolve(result),
                    (err) => internal.deferred.reject(toError(err)),
                );
            } catch (err) {
                internal.deferred.reject(toError(err));
            }
        },
        reject(error: unknown) {
            if (internal.settled) {
                throw new Error('Query is already settled.');
            }
            internal.settled = true;
            internal.deferred.reject(toError(error));
        },
    };
}

// ── DbProbe ───────────────────────────────────────────────────────────────────

/**
 * Intercepts and controls database queries in component tests.
 *
 * ORM adapters call `recordQuery(queryInfo, forwardFn)` to hand off each
 * query. The probe decides whether to forward it to the real database,
 * reject it with an error, or hold it for explicit test control via
 * `expectNext` / `expectMatching`.
 */
export class DbProbe {
    private readonly queue: QueryInternal[] = [];

    private readonly consumed = new Set<number>();

    private readonly waiters: Waiter[] = [];

    private readonly planned: PlannedBehavior[] = [];

    private permanent: PlannedBehavior | undefined;

    private nextIndex = 0;

    /**
     * Called by the ORM adapter for every query.
     * `forwardFn` is a zero-argument closure that runs the real query and
     * returns its result -- the probe never needs to know about ORM internals.
     *
     * @internal
     */
    recordQuery(
        query: { sql: string; parameters: ReadonlyArray<unknown> },
        forwardFn: () => Promise<unknown>,
    ): Promise<unknown> {
        const deferred = createDeferred<unknown>();
        const index = this.nextIndex;
        this.nextIndex += 1;

        const internal: QueryInternal = {
            index,
            sql: query.sql,
            parameters: query.parameters,
            deferred,
            forwardFn,
            settled: false,
        };

        this.queue.push(internal);

        for (let i = 0; i < this.waiters.length; i += 1) {
            const waiter = this.waiters[i];
            if (waiter.predicate({ sql: internal.sql, parameters: internal.parameters })) {
                this.waiters.splice(i, 1);
                if (waiter.timer) realClearTimeout(waiter.timer);
                this.consumed.add(index);
                waiter.resolve(makePendingQuery(internal));
                return deferred.promise;
            }
        }

        const behavior = this.resolveBehavior();
        if (behavior) {
            this.applyBehavior(internal, behavior);
        }

        return deferred.promise;
    }

    // ── Plumbing: wait for queries ────────────────────────────────────────────

    async expectNext(timeoutMs = 5000): Promise<PendingQuery> {
        return this.expectMatching(() => true, timeoutMs);
    }

    async expectMatching(predicate: (call: QueryCall) => boolean, timeoutMs = 5000): Promise<PendingQuery> {
        for (const internal of this.queue) {
            if (
                !this.consumed.has(internal.index) &&
                !internal.settled &&
                predicate({ sql: internal.sql, parameters: internal.parameters })
            ) {
                this.consumed.add(internal.index);
                return makePendingQuery(internal);
            }
        }

        return new Promise<PendingQuery>((resolve, reject) => {
            const waiter: Waiter = { predicate, resolve, reject };
            waiter.timer = realSetTimeout(() => {
                this.removeWaiter(waiter);
                reject(new Error(`Timed out waiting for matching query after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    // ── Observation ───────────────────────────────────────────────────────────

    get queries(): ReadonlyArray<QueryCall> {
        return this.queue.map((q) => ({ sql: q.sql, parameters: q.parameters }));
    }

    pendingCount(): number {
        let count = 0;
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) count += 1;
        }
        return count;
    }

    // ── Porcelain: pre-program behavior ───────────────────────────────────────

    whenQueried(): { thenForward(): void; thenReject(error: unknown): void } {
        return {
            thenForward: () => {
                this.planned.push({ type: 'forward' });
            },
            thenReject: (error: unknown) => {
                this.planned.push({ type: 'reject', error });
            },
        };
    }

    alwaysForward(): void {
        this.permanent = { type: 'forward' };
    }

    alwaysReject(error: unknown): void {
        this.permanent = { type: 'reject', error };
    }

    /**
     * Clear any permanent behavior and the planned queue.
     * After this call, queries that are not matched by a waiter will hang
     * until explicitly settled.
     */
    clearBehavior(): void {
        this.permanent = undefined;
        this.planned.length = 0;
    }

    // ── Drain helpers ─────────────────────────────────────────────────────────

    drainWith(handler: (pending: PendingQuery) => void): void {
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) {
                this.consumed.add(internal.index);
                handler(makePendingQuery(internal));
            }
        }
    }

    drain(): void {
        this.drainWith(() => {});
    }

    drainAndForwardAll(): void {
        this.drainWith((q) => {
            if (!q.settled) q.forward();
        });
    }

    drainAndRejectAll(error?: Error): void {
        this.drainWith((q) => {
            if (!q.settled) q.reject(error ?? new Error('drained'));
        });
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private resolveBehavior(): PlannedBehavior | undefined {
        if (this.planned.length > 0) {
            return this.planned.shift();
        }
        return this.permanent;
    }

    private applyBehavior(internal: QueryInternal, behavior: PlannedBehavior): void {
        if (internal.settled) return;
        internal.settled = true;
        if (behavior.type === 'forward') {
            try {
                internal.forwardFn().then(
                    (result) => internal.deferred.resolve(result),
                    (err) => internal.deferred.reject(toError(err)),
                );
            } catch (err) {
                internal.deferred.reject(toError(err));
            }
        } else {
            internal.deferred.reject(toError(behavior.error));
        }
    }

    private removeWaiter(waiter: Waiter): void {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
    }
}
