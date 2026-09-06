/**
 * Core probe engine: createProbeRoot factory + four-tier rule resolution +
 * Selection / Probe / RuleBuilder / Expectations factories on top.
 *
 * Per docs/internal/tech-design.md §"Internal Storage Model" and
 * §"recordCall flow", §"applyRule", §"Retroactive intercept".
 *
 * Tier 1a — observers (notify-only, FIFO).
 * Tier 1b — capturing waiters (intercept, FIFO).
 * Tier 2  — one-shot rules (single global FIFO queue).
 * Tier 3  — permanent rules (LIFO stack).
 * Default — park.
 */
import type { Duration } from './duration.js';
import { milliseconds, seconds } from './duration.js';
import { errors, toError } from './errors.js';
import {
    appendFilter,
    defaultLabel,
    makeGenericExpectations,
    matchesFilter,
    matchingCalls,
    type ExpectationHost,
} from './expectation-engine.js';
import type {
    CallMatcher,
    CallNotifier,
    CallRecord,
    Deferred,
    FilterChain,
    ForwardablePendingCall,
    ForwardableSelection,
    HarnessRef,
    ObserverEntry,
    PendingAnswer,
    PendingCallBase,
    Probe,
    ProbeAdmin,
    ProbeRoot,
    ProbeRootConfig,
    RuleAction,
    RuleBuilder,
    RuleEntry,
    Selection,
    WaiterEntry,
} from './types.js';

// ── Internal state ──────────────────────────────────────────────────────────

interface ProbeState<TCall, TPending extends PendingCallBase<TCall>> {
    history: CallRecord<TCall, TPending>[];
    oneShotRules: RuleEntry<TCall, TPending>[];
    permanentRules: RuleEntry<TCall, TPending>[];
    capturingWaiters: WaiterEntry<TCall, TPending>[];
    observingWaiters: ObserverEntry<TCall>[];
    callNotifiers: CallNotifier<TCall>[];
    config: ResolvedConfig<TCall, TPending>;
    closed: boolean;
    nextId: number;
}

interface ResolvedConfig<TCall, TPending extends PendingCallBase<TCall>> {
    harness?: HarnessRef;
    defaultTimeout: Duration;
    safetyTimeout: Duration | null;
    pendingFactory: (record: CallRecord<TCall, TPending>) => TPending;
    forwardable: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function getDefaultTimeout<TCall, TPending extends PendingCallBase<TCall>>(
    state: ProbeState<TCall, TPending>,
): Duration {
    return state.config.defaultTimeout ?? state.config.harness?.defaultTimeout ?? seconds(5);
}

function getSafetyTimeout<TCall, TPending extends PendingCallBase<TCall>>(
    state: ProbeState<TCall, TPending>,
): Duration | null {
    if (state.config.safetyTimeout !== undefined) return state.config.safetyTimeout;
    if (state.config.harness?.safetyTimeout !== undefined) {
        return state.config.harness.safetyTimeout;
    }
    return seconds(30);
}

/** Adapter over the live state arrays for the shared expectation machinery. */
function expectationHost<TCall, TPending extends PendingCallBase<TCall>>(
    state: ProbeState<TCall, TPending>,
): ExpectationHost<TCall, TPending, CallRecord<TCall, TPending>> {
    return {
        history: state.history,
        capturingWaiters: state.capturingWaiters,
        observingWaiters: state.observingWaiters,
        callNotifiers: state.callNotifiers,
        defaultTimeout: getDefaultTimeout(state),
        safetyTimeout: getSafetyTimeout(state),
        pendingFactory: state.config.pendingFactory,
    };
}

// ── recordCall + applyRule ──────────────────────────────────────────────────

function recordCallImpl<TCall, TPending extends PendingCallBase<TCall>>(
    state: ProbeState<TCall, TPending>,
    call: TCall,
    forwardFn?: () => Promise<unknown>,
): Promise<unknown> {
    if (state.closed) {
        return Promise.reject(errors.harnessClosed());
    }

    const deferred = createDeferred<unknown>();
    const id = state.nextId;
    state.nextId += 1;

    const record: CallRecord<TCall, TPending> = {
        id,
        call,
        deferred,
        routed: false,
        settled: false,
        ruleParked: false,
        forwardFn,
    };
    state.history.push(record);

    // Notify atLeast/exactly subscribers FIRST so they observe every call.
    for (const notifier of state.callNotifiers.slice()) {
        notifier.onCall(call);
    }

    // Tier 1a — observers (FIFO, notify-only). Drain matching observers
    // BEFORE intercepts; observers do not consume.
    if (state.observingWaiters.length > 0) {
        const observers = state.observingWaiters.slice();
        for (const observer of observers) {
            if (matchesFilter(observer.filter, call)) {
                const idx = state.observingWaiters.indexOf(observer);
                if (idx >= 0) state.observingWaiters.splice(idx, 1);
                observer.cleanup();
                observer.resolve(call);
            }
        }
    }

    // Tier 1b — capturing waiters (FIFO).
    for (let i = 0; i < state.capturingWaiters.length; i++) {
        const waiter = state.capturingWaiters[i];
        if (matchesFilter(waiter.filter, call)) {
            state.capturingWaiters.splice(i, 1);
            waiter.cleanup();
            record.routed = true;
            const pending = state.config.pendingFactory(record);
            waiter.resolve(pending);
            return deferred.promise;
        }
    }

    // Tier 2 — one-shot rules (single global FIFO queue).
    for (let i = 0; i < state.oneShotRules.length; i++) {
        const rule = state.oneShotRules[i];
        if (matchesFilter(rule.filter, call)) {
            state.oneShotRules.splice(i, 1);
            applyRule(record, rule.action);
            return deferred.promise;
        }
    }

    // Tier 3 — permanent rules (LIFO stack; iterate from newest).
    for (let i = state.permanentRules.length - 1; i >= 0; i--) {
        const rule = state.permanentRules[i];
        if (matchesFilter(rule.filter, call)) {
            applyRule(record, rule.action);
            return deferred.promise;
        }
    }

    // Default — park (no rule matched). routed remains false; the call
    // is retroactively interceptable.
    return deferred.promise;
}

function applyRule<TCall, TPending extends PendingCallBase<TCall>>(
    record: CallRecord<TCall, TPending>,
    action: RuleAction<TCall, TPending>,
): void {
    if (record.settled) return;

    switch (action.kind) {
        case 'answer':
            record.routed = true;
            record.settled = true;
            record.deferred.resolve(action.value);
            return;

        case 'reject':
            record.routed = true;
            record.settled = true;
            record.deferred.reject(toError(action.error));
            return;

        case 'answerWith': {
            record.routed = true;
            let result: unknown;
            try {
                result = action.fn(record.call);
            } catch (err) {
                record.settled = true;
                record.deferred.reject(toError(err));
                return;
            }
            if (isPromise(result)) {
                result.then(
                    (v) => {
                        record.settled = true;
                        record.deferred.resolve(v);
                    },
                    (e: unknown) => {
                        record.settled = true;
                        record.deferred.reject(toError(e));
                    },
                );
            } else {
                record.settled = true;
                record.deferred.resolve(result);
            }
            return;
        }

        case 'forward':
            record.routed = true;
            if (!record.forwardFn) {
                record.settled = true;
                record.deferred.reject(errors.cannotForwardNoBacking());
                return;
            }
            record.forwardFn().then(
                (v) => {
                    record.settled = true;
                    record.deferred.resolve(v);
                },
                (e: unknown) => {
                    record.settled = true;
                    record.deferred.reject(toError(e));
                },
            );
            return;

        case 'park':
            record.routed = true;
            record.ruleParked = true;
            // Deliberately not settling.
            return;
    }
}

function isPromise(v: unknown): v is Promise<unknown> {
    return (
        v !== null &&
        typeof v === 'object' &&
        'then' in (v as object) &&
        typeof (v as { then?: unknown }).then === 'function'
    );
}

// ── Pending-call factories ─────────────────────────────────────────────────

export function makePendingBase<TCall, TResult = unknown>(
    record: CallRecord<TCall, PendingCallBase<TCall, TResult>>,
    label: string,
): PendingCallBase<TCall, TResult> {
    const settle = (action: () => void): void => {
        if (record.settled) {
            throw errors.doubleSettle(label);
        }
        record.routed = true;
        record.settled = true;
        action();
    };

    return {
        get call() {
            return record.call;
        },
        get settled() {
            return record.settled;
        },
        answer(value) {
            settle(() => record.deferred.resolve(value));
        },
        answerWith(fn) {
            if (record.settled) throw errors.doubleSettle(label);
            record.routed = true;
            record.settled = true;
            let result: unknown;
            try {
                result = fn(record.call);
            } catch (err) {
                record.deferred.reject(toError(err));
                return;
            }
            if (isPromise(result)) {
                result.then(
                    (v) => record.deferred.resolve(v),
                    (e: unknown) => record.deferred.reject(toError(e)),
                );
            } else {
                record.deferred.resolve(result);
            }
        },
        reject(error) {
            settle(() => record.deferred.reject(toError(error)));
        },
    };
}

export function makeForwardablePending<TCall, TResult = unknown>(
    record: CallRecord<TCall, ForwardablePendingCall<TCall, TResult>>,
    label: string,
): ForwardablePendingCall<TCall, TResult> {
    const base = makePendingBase<TCall, TResult>(record as CallRecord<TCall, PendingCallBase<TCall, TResult>>, label);
    // Inherit from base so getters (call, settled) propagate live; spreading
    // would freeze them into static values at construction time.
    const pending = Object.create(base) as PendingCallBase<TCall, TResult>;
    Object.defineProperty(pending, 'forward', {
        value: () => {
            if (record.settled) throw errors.doubleSettle(label);
            if (!record.forwardFn) throw errors.cannotForwardNoBacking();
            record.routed = true;
            record.settled = true;
            record.forwardFn().then(
                (v) => record.deferred.resolve(v),
                (e: unknown) => record.deferred.reject(toError(e)),
            );
        },
        enumerable: false,
        configurable: true,
    });
    return pending as ForwardablePendingCall<TCall, TResult>;
}

// ── Engine factories: Selection / Probe / RuleBuilder / Expectations ──────

function makeRuleBuilder<TCall, TPending extends PendingCallBase<TCall>>(
    state: ProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
    tier: 'oneShot' | 'permanent',
    origin: 'harness' | 'user',
): RuleBuilder<TCall, TPending> & { forward(): void } {
    const addRule = (action: RuleAction<TCall, TPending>): void => {
        const entry: RuleEntry<TCall, TPending> = { filter, action, origin };
        if (tier === 'oneShot') state.oneShotRules.push(entry);
        else state.permanentRules.push(entry);
    };

    return {
        answer(value: PendingAnswer<TPending>) {
            addRule({ kind: 'answer', value });
        },
        answerWith(fn: (call: TCall) => PendingAnswer<TPending> | Promise<PendingAnswer<TPending>>) {
            addRule({
                kind: 'answerWith',
                fn: fn as (call: TCall) => unknown | Promise<unknown>,
            });
        },
        reject(error: unknown) {
            addRule({ kind: 'reject', error });
        },
        park() {
            addRule({ kind: 'park' });
        },
        forward() {
            if (!state.config.forwardable) {
                throw errors.cannotForwardNoBacking();
            }
            addRule({ kind: 'forward' });
        },
    };
}

function makeSelection<TCall, TPending extends PendingCallBase<TCall>>(
    state: ProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
): Selection<TCall, TPending> {
    const host = expectationHost(state);
    const sel = {
        filter(predicate: CallMatcher<TCall>, label?: string) {
            const lbl = label ?? defaultLabel(predicate as { name?: string });
            const newFilter = appendFilter(filter, predicate, lbl);
            return makeSelection(state, newFilter);
        },
        once() {
            return makeRuleBuilder(state, filter, 'oneShot', 'user');
        },
        always() {
            return makeRuleBuilder(state, filter, 'permanent', 'user');
        },
        get expect() {
            return makeGenericExpectations(host, filter);
        },
        get calls() {
            return matchingCalls(host, filter);
        },
        drain(handler?: (pending: TPending) => void) {
            for (const record of state.history) {
                if (matchesFilter(filter, record.call) && !record.routed) {
                    record.routed = true;
                    if (handler) {
                        const pending = state.config.pendingFactory(record);
                        handler(pending);
                    }
                }
            }
        },
        drainAndReject(error?: unknown) {
            for (const record of state.history) {
                if (matchesFilter(filter, record.call) && !record.settled) {
                    record.routed = true;
                    record.settled = true;
                    record.deferred.reject(toError(error ?? new Error('drained')));
                }
            }
        },
    };
    return sel as unknown as Selection<TCall, TPending>;
}

function addDrainAndForward<TCall, TPending extends ForwardablePendingCall<TCall>>(
    state: ProbeState<TCall, TPending>,
    baseSelection: Selection<TCall, TPending>,
    filter: FilterChain<TCall>,
): ForwardableSelection<TCall, TPending> {
    // Inherit from baseSelection via prototype chain so live getters (calls)
    // propagate. Spreading or Object.assign would freeze getters into static
    // values at the time of construction.
    const ext = Object.create(baseSelection) as Selection<TCall, TPending>;
    Object.defineProperty(ext, 'drainAndForward', {
        value: () => {
            for (const record of state.history) {
                if (matchesFilter(filter, record.call) && !record.settled && record.forwardFn) {
                    record.routed = true;
                    record.settled = true;
                    record.forwardFn().then(
                        (v) => record.deferred.resolve(v),
                        (e: unknown) => record.deferred.reject(toError(e)),
                    );
                }
            }
        },
        enumerable: false,
        configurable: true,
    });
    return ext as unknown as ForwardableSelection<TCall, TPending>;
}

function makeProbeAdmin<TCall, TPending extends PendingCallBase<TCall>>(
    state: ProbeState<TCall, TPending>,
): ProbeAdmin {
    return {
        clearRules(options?: { includeDefaults?: boolean }) {
            const includeDefaults = options?.includeDefaults ?? false;
            if (includeDefaults) {
                state.oneShotRules.length = 0;
                state.permanentRules.length = 0;
            } else {
                state.oneShotRules = state.oneShotRules.filter((r) => r.origin === 'harness');
                state.permanentRules = state.permanentRules.filter((r) => r.origin === 'harness');
            }
        },
        clearCalls() {
            state.history.length = 0;
            state.nextId = 0;
        },
        resetProbe(options?: { includeDefaults?: boolean }) {
            this.clearRules(options);
            this.clearCalls();
        },
    };
}

// ── Top-level factory ─────────────────────────────────────────────────────

export function createProbeRoot<TCall, TPending extends PendingCallBase<TCall>>(
    config: ProbeRootConfig<TCall, TPending>,
): ProbeRoot<TCall, TPending> {
    const state: ProbeState<TCall, TPending> = {
        history: [],
        oneShotRules: [],
        permanentRules: [],
        capturingWaiters: [],
        observingWaiters: [],
        callNotifiers: [],
        config: {
            harness: config.harness,
            defaultTimeout: config.defaultTimeout ?? config.harness?.defaultTimeout ?? seconds(5),
            safetyTimeout:
                config.safetyTimeout !== undefined
                    ? config.safetyTimeout
                    : (config.harness?.safetyTimeout ?? seconds(30)),
            pendingFactory: config.pendingFactory,
            forwardable: config.forwardable ?? false,
        },
        closed: false,
        nextId: 0,
    };

    // Install harness-origin default rules.
    for (const def of config.defaultRules ?? []) {
        state.permanentRules.push({
            filter: def.filter,
            action: def.action,
            origin: 'harness',
        });
    }

    const matchAll: FilterChain<TCall> = {
        predicates: [],
        label: '<all calls>',
    };

    const baseSelection = makeSelection(state, matchAll);

    const admin = makeProbeAdmin(state);

    // Compose probe = (forwardable selection) + admin, with admin defined as
    // own properties on top of the prototype-inherited selection so the
    // selection's getters still resolve dynamically.
    const selectionRoot = state.config.forwardable
        ? (addDrainAndForward(
              state as unknown as ProbeState<TCall, ForwardablePendingCall<TCall>>,
              baseSelection as unknown as Selection<TCall, ForwardablePendingCall<TCall>>,
              matchAll,
          ) as unknown as Selection<TCall, TPending>)
        : baseSelection;

    const probe = Object.create(selectionRoot) as Probe<TCall, TPending>;
    Object.defineProperty(probe, 'clearRules', {
        value: admin.clearRules.bind(admin),
        enumerable: false,
        configurable: true,
    });
    Object.defineProperty(probe, 'clearCalls', {
        value: admin.clearCalls.bind(admin),
        enumerable: false,
        configurable: true,
    });
    Object.defineProperty(probe, 'resetProbe', {
        value: admin.resetProbe.bind(admin),
        enumerable: false,
        configurable: true,
    });

    return {
        probe,
        recordCall(call, forwardFn) {
            return recordCallImpl(state, call, forwardFn);
        },
        dispose() {
            state.closed = true;
            const total = state.capturingWaiters.length + state.observingWaiters.length;
            if (total > 0) {
                const err = errors.closeWithUnsettledWaiters(total);
                for (const waiter of state.capturingWaiters) {
                    waiter.cleanup();
                    waiter.reject(err);
                }
                for (const observer of state.observingWaiters) {
                    observer.cleanup();
                    observer.reject(err);
                }
                state.capturingWaiters.length = 0;
                state.observingWaiters.length = 0;
            }
            state.callNotifiers.length = 0;
        },
    };
}

// Re-export milliseconds for internal use.
export { milliseconds };
