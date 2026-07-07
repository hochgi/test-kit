/**
 * Shared expectation/waiter machinery used by BOTH probe engines
 * (`probe-engine.ts` — Promise-settled calls; `stream-probe-engine.ts` —
 * chunk-channel calls). Everything here is settlement-agnostic: it needs only
 * a recorded call, its `routed` flag, and a pending-call factory. Extracted so
 * the deadline / eviction / notifier bookkeeping cannot drift between the two
 * engines (PR #32 review finding).
 *
 * Internal module: not exported from the package index. Domain packages get
 * this behavior through `createProbeRoot` / `createStreamProbeRoot`.
 */
import type { Duration } from './duration.js';
import { errors } from './errors.js';
import type { ExpectOptions, FilterChain, RequiredWithinOptions } from './types.js';

// Snapshot real timer functions BEFORE any test framework installs fake
// timers. Waiter/safety/none deadlines run on wall-clock time by design.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

// ── Filter helpers ──────────────────────────────────────────────────────────

export function matchesFilter<TCall>(chain: FilterChain<TCall>, call: TCall): boolean {
    for (const p of chain.predicates) {
        if (!p.fn(call)) return false;
    }
    return true;
}

export function appendFilter<TCall>(
    chain: FilterChain<TCall>,
    predicate: (call: TCall) => boolean,
    label: string,
): FilterChain<TCall> {
    const newPredicates = [...chain.predicates, { fn: predicate, label }];
    const labels = newPredicates.map((p) => p.label);
    const joined = labels.length === 0 ? '<all calls>' : labels.join(' AND ');
    return { predicates: newPredicates, label: joined };
}

export function defaultLabel(predicate: { name?: string }): string {
    const n = predicate.name?.trim();
    return n && n !== 'fn' ? n : '<anonymous predicate>';
}

// ── Host contract ───────────────────────────────────────────────────────────

/** The slice of a call record the expectation machinery needs. */
export interface ExpectationRecord<TCall> {
    readonly call: TCall;
    routed: boolean;
}

interface Waiter<TCall, TPending> {
    readonly filter: FilterChain<TCall>;
    resolve(pending: TPending): void;
    reject(error: Error): void;
    cleanup(): void;
}

interface Observer<TCall> {
    readonly filter: FilterChain<TCall>;
    resolve(call: TCall): void;
    reject(error: Error): void;
    cleanup(): void;
}

interface Notifier<TCall> {
    onCall(call: TCall): void;
}

/**
 * Structural adapter each engine builds over its own state. The arrays are the
 * engine's live arrays (mutated in place — never reassigned), so waiters
 * registered here are visible to the engine's `recordCall` tier matching.
 */
export interface ExpectationHost<TCall, TPending, TRecord extends ExpectationRecord<TCall>> {
    readonly history: TRecord[];
    readonly capturingWaiters: Array<Waiter<TCall, TPending>>;
    readonly observingWaiters: Array<Observer<TCall>>;
    readonly callNotifiers: Array<Notifier<TCall>>;
    readonly defaultTimeout: Duration;
    readonly safetyTimeout: Duration | null;
    pendingFactory(record: TRecord): TPending;
}

/**
 * Structurally identical to the engines' public `Expectations` /
 * `StreamExpectations` interfaces, minus their pending-type constraints —
 * each engine's `makeExpectations` returns this and the structural match
 * satisfies its declared public type.
 */
export interface GenericExpectations<TCall, TPending> {
    intercept(options?: ExpectOptions): Promise<TPending>;
    observe(options?: ExpectOptions): Promise<TCall>;
    none(options: RequiredWithinOptions): Promise<void>;
    atLeast(n: number, options?: ExpectOptions): Promise<ReadonlyArray<TCall>>;
    exactly(n: number, options: RequiredWithinOptions): Promise<ReadonlyArray<TCall>>;
    calledTimes(n: number): void;
    neverCalled(): void;
    called(): void;
}

// ── Implementations ─────────────────────────────────────────────────────────

export function matchingCalls<TCall, TPending, TRecord extends ExpectationRecord<TCall>>(
    host: ExpectationHost<TCall, TPending, TRecord>,
    filter: FilterChain<TCall>,
): TCall[] {
    return host.history.filter((r) => matchesFilter(filter, r.call)).map((r) => r.call);
}

/**
 * Register an entry in a waiter registry with a `within` deadline and an
 * optional safety deadline; on either firing, the entry is evicted and the
 * promise rejects. The single home for the timer/eviction wiring that
 * `intercept` and `observe` previously each duplicated.
 */
function awaitEntry<TCall, TResult, TEntry>(
    registry: TEntry[],
    filter: FilterChain<TCall>,
    within: Duration,
    safety: Duration | null,
    makeEntry: (resolve: (value: TResult) => void, reject: (error: Error) => void, cleanup: () => void) => TEntry,
): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
        let withinTimer: ReturnType<typeof realSetTimeout> | undefined;
        let safetyTimer: ReturnType<typeof realSetTimeout> | undefined;

        const cleanup = (): void => {
            if (withinTimer !== undefined) {
                realClearTimeout(withinTimer);
                withinTimer = undefined;
            }
            if (safetyTimer !== undefined) {
                realClearTimeout(safetyTimer);
                safetyTimer = undefined;
            }
        };

        const entry = makeEntry(resolve, reject, cleanup);

        const evict = (error: Error): void => {
            const idx = registry.indexOf(entry);
            if (idx >= 0) registry.splice(idx, 1);
            cleanup();
            reject(error);
        };

        withinTimer = realSetTimeout(
            () => evict(errors.timeout(filter.label, within.milliseconds)),
            within.milliseconds,
        );
        if (safety !== null) {
            safetyTimer = realSetTimeout(() => evict(errors.safetyTimeout(safety.milliseconds)), safety.milliseconds);
        }

        registry.push(entry);
    });
}

export function interceptImpl<TCall, TPending, TRecord extends ExpectationRecord<TCall>>(
    host: ExpectationHost<TCall, TPending, TRecord>,
    filter: FilterChain<TCall>,
    options?: ExpectOptions,
): Promise<TPending> {
    // Retroactive scan: oldest unrouted matching record wins.
    for (const record of host.history) {
        if (!record.routed && matchesFilter(filter, record.call)) {
            record.routed = true;
            return Promise.resolve(host.pendingFactory(record));
        }
    }

    const within = options?.within ?? host.defaultTimeout;
    return awaitEntry<TCall, TPending, Waiter<TCall, TPending>>(
        host.capturingWaiters,
        filter,
        within,
        host.safetyTimeout,
        (resolve, reject, cleanup) => ({ filter, resolve, reject, cleanup }),
    );
}

export function observeImpl<TCall, TPending, TRecord extends ExpectationRecord<TCall>>(
    host: ExpectationHost<TCall, TPending, TRecord>,
    filter: FilterChain<TCall>,
    options?: ExpectOptions,
): Promise<TCall> {
    // Per spec: observe does NOT scan history retroactively. It registers a
    // waiter that fires on the next incoming matching call.
    const within = options?.within ?? host.defaultTimeout;
    return awaitEntry<TCall, TCall, Observer<TCall>>(
        host.observingWaiters,
        filter,
        within,
        host.safetyTimeout,
        (resolve, reject, cleanup) => ({ filter, resolve, reject, cleanup }),
    );
}

export function noneImpl<TCall, TPending, TRecord extends ExpectationRecord<TCall>>(
    host: ExpectationHost<TCall, TPending, TRecord>,
    filter: FilterChain<TCall>,
    options: RequiredWithinOptions,
): Promise<void> {
    const { within } = options;
    return new Promise<void>((resolve, reject) => {
        realSetTimeout(() => {
            // Drain microtasks before checking history.
            queueMicrotask(() => {
                const matching = matchingCalls(host, filter);
                if (matching.length === 0) resolve();
                else reject(errors.none(filter.label, within.milliseconds, matching.length));
            });
        }, within.milliseconds);
    });
}

export function atLeastImpl<TCall, TPending, TRecord extends ExpectationRecord<TCall>>(
    host: ExpectationHost<TCall, TPending, TRecord>,
    filter: FilterChain<TCall>,
    n: number,
    options?: ExpectOptions,
): Promise<ReadonlyArray<TCall>> {
    const within = options?.within ?? host.defaultTimeout;
    const safety = host.safetyTimeout;

    return new Promise<ReadonlyArray<TCall>>((resolve, reject) => {
        let done = false;
        // eslint-disable-next-line prefer-const -- declared up-front so cleanup can reference it; assigned once below.
        let withinTimer: ReturnType<typeof realSetTimeout> | undefined;
        let safetyTimer: ReturnType<typeof realSetTimeout> | undefined;

        const initial = matchingCalls(host, filter);
        if (initial.length >= n) {
            resolve(initial);
            return;
        }

        const notifier: Notifier<TCall> = {
            onCall(call) {
                if (done) return;
                if (!matchesFilter(filter, call)) return;
                const all = matchingCalls(host, filter);
                if (all.length >= n) {
                    done = true;
                    cleanup();
                    resolve(all);
                }
            },
        };

        const cleanup = (): void => {
            const idx = host.callNotifiers.indexOf(notifier);
            if (idx >= 0) host.callNotifiers.splice(idx, 1);
            if (withinTimer !== undefined) realClearTimeout(withinTimer);
            if (safetyTimer !== undefined) realClearTimeout(safetyTimer);
        };

        withinTimer = realSetTimeout(() => {
            if (done) return;
            done = true;
            cleanup();
            reject(errors.atLeast(filter.label, n, within.milliseconds, matchingCalls(host, filter).length));
        }, within.milliseconds);

        if (safety !== null) {
            safetyTimer = realSetTimeout(() => {
                if (done) return;
                done = true;
                cleanup();
                reject(errors.safetyTimeout(safety.milliseconds));
            }, safety.milliseconds);
        }

        host.callNotifiers.push(notifier);
    });
}

export function exactlyImpl<TCall, TPending, TRecord extends ExpectationRecord<TCall>>(
    host: ExpectationHost<TCall, TPending, TRecord>,
    filter: FilterChain<TCall>,
    n: number,
    options: RequiredWithinOptions,
): Promise<ReadonlyArray<TCall>> {
    const { within } = options;
    return new Promise<ReadonlyArray<TCall>>((resolve, reject) => {
        realSetTimeout(() => {
            queueMicrotask(() => {
                const all = matchingCalls(host, filter);
                if (all.length === n) resolve(all);
                else reject(errors.exactly(filter.label, n, within.milliseconds, all.length));
            });
        }, within.milliseconds);
    });
}

export function makeGenericExpectations<TCall, TPending, TRecord extends ExpectationRecord<TCall>>(
    host: ExpectationHost<TCall, TPending, TRecord>,
    filter: FilterChain<TCall>,
): GenericExpectations<TCall, TPending> {
    return {
        intercept: (options?: ExpectOptions) => interceptImpl(host, filter, options),
        observe: (options?: ExpectOptions) => observeImpl(host, filter, options),
        none: (options: RequiredWithinOptions) => noneImpl(host, filter, options),
        atLeast: (n: number, options?: ExpectOptions) => atLeastImpl(host, filter, n, options),
        exactly: (n: number, options: RequiredWithinOptions) => exactlyImpl(host, filter, n, options),
        calledTimes(n: number) {
            const count = matchingCalls(host, filter).length;
            if (count !== n) {
                throw new Error(`Expected ${filter.label} to have been called ${n} times, got ${count}.`);
            }
        },
        neverCalled() {
            const count = matchingCalls(host, filter).length;
            if (count !== 0) {
                throw new Error(`Expected ${filter.label} to have never been called, got ${count} calls.`);
            }
        },
        called() {
            const count = matchingCalls(host, filter).length;
            if (count === 0) {
                throw new Error(`Expected ${filter.label} to have been called, got 0 calls.`);
            }
        },
    };
}
