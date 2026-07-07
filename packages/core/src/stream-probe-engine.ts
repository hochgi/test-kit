/**
 * Stream probe engine: createStreamProbeRoot factory + four-tier rule
 * resolution, mirroring `probe-engine.ts`'s tiered matching (observers →
 * capturing waiters → one-shot rules → permanent rules → park) over the same
 * `FilterChain` primitive. The tier/waiter/expectation bookkeeping itself is
 * SHARED with the Promise engine via `expectation-engine.ts`; what lives here
 * is only what is genuinely stream-specific — the chunk channel, rule
 * application over it, and the push/end/error pending-call surface. See
 * `stream-types.ts` for why the settlement models are not unified.
 *
 * Tier 1a — observers (notify-only, FIFO).
 * Tier 1b — capturing waiters (intercept, FIFO).
 * Tier 2  — one-shot rules (single global FIFO queue).
 * Tier 3  — permanent rules (LIFO stack).
 * Default — park (the consumer's first pull never resolves).
 */
import type { Duration } from './duration.js';
import { milliseconds, seconds } from './duration.js';
import { errors, toError } from './errors.js';
import type { CallMatcher, FilterChain, ProbeAdmin } from './types.js';
import {
    appendFilter,
    defaultLabel,
    makeGenericExpectations,
    matchesFilter,
    matchingCalls,
    type ExpectationHost,
} from './expectation-engine.js';
import type {
    StreamCallNotifier,
    StreamChannel,
    StreamObserverEntry,
    StreamPendingCallBase,
    StreamProbe,
    StreamProbeRoot,
    StreamProbeRootConfig,
    StreamRecord,
    StreamRuleAction,
    StreamRuleBuilder,
    StreamRuleEntry,
    StreamSelection,
    StreamWaiterEntry,
} from './stream-types.js';

// ── Channel: the multi-value async producer/consumer primitive ────────────

type QueueItem<TChunk> =
    | { readonly kind: 'chunk'; readonly value: TChunk }
    | { readonly kind: 'end' }
    | { readonly kind: 'error'; readonly error: Error };

export function createChannel<TChunk>(): StreamChannel<TChunk> {
    const buffered: QueueItem<TChunk>[] = [];
    let closed = false;
    // FIFO queue (not a single slot): several `next()` pulls can be parked at
    // once — e.g. a consumer racing two reads, or two iterators replaying the
    // same channel — and every one of them must be re-woken on each state
    // change, or the ones whose waker got overwritten would hang forever.
    const wakers: Array<() => void> = [];

    const notify = (): void => {
        const pending = wakers.splice(0, wakers.length);
        for (const wake of pending) wake();
    };

    return {
        get settled() {
            return closed;
        },
        push(chunk) {
            if (closed) throw errors.doubleSettle('stream');
            buffered.push({ kind: 'chunk', value: chunk });
            notify();
        },
        end() {
            if (closed) throw errors.doubleSettle('stream');
            closed = true;
            buffered.push({ kind: 'end' });
            notify();
        },
        error(err) {
            if (closed) throw errors.doubleSettle('stream');
            closed = true;
            buffered.push({ kind: 'error', error: toError(err) });
            notify();
        },
        [Symbol.asyncIterator]() {
            let cursor = 0;
            // Mirrors async-generator completion semantics: after this
            // iterator has delivered its terminal signal (done or thrown
            // error), every later `next()` resolves `{done: true}` instead of
            // parking forever.
            let finished = false;
            return {
                async next(): Promise<IteratorResult<TChunk>> {
                    if (finished) return { done: true, value: undefined };
                    while (cursor >= buffered.length) {
                        if (closed) {
                            finished = true;
                            return { done: true, value: undefined };
                        }
                        await new Promise<void>((resolve) => {
                            wakers.push(resolve);
                        });
                    }
                    const item = buffered[cursor];
                    cursor += 1;
                    if (item.kind === 'chunk') return { done: false, value: item.value };
                    finished = true;
                    if (item.kind === 'end') return { done: true, value: undefined };
                    throw item.error;
                },
            };
        },
    };
}

/**
 * Drains a scripted (async) iterable into `channel`, forwarding a mid-stream
 * throw as `channel.error`. Every step is guarded on `channel.settled`:
 * another path (`drainAndReject`, `dispose`, an interactive `error()`) can
 * legitimately close the channel while the source is still producing, and
 * pumping must then become a silent no-op — this promise is fire-and-forget,
 * so a throw here would surface as an unhandled rejection.
 */
async function pumpIntoChannel<TChunk>(
    channel: StreamChannel<TChunk>,
    source: Iterable<TChunk> | AsyncIterable<TChunk>,
): Promise<void> {
    try {
        for await (const chunk of source) {
            if (channel.settled) return;
            channel.push(chunk);
        }
        if (!channel.settled) channel.end();
    } catch (err) {
        if (!channel.settled) channel.error(err);
    }
}

// ── Internal state ──────────────────────────────────────────────────────────

interface StreamProbeState<TCall, TPending extends StreamPendingCallBase<TCall>> {
    history: StreamRecord<TCall, unknown>[];
    oneShotRules: StreamRuleEntry<TCall, unknown>[];
    permanentRules: StreamRuleEntry<TCall, unknown>[];
    capturingWaiters: StreamWaiterEntry<TCall, TPending>[];
    observingWaiters: StreamObserverEntry<TCall>[];
    callNotifiers: StreamCallNotifier<TCall>[];
    config: ResolvedConfig<TCall, TPending>;
    closed: boolean;
    nextId: number;
}

interface ResolvedConfig<TCall, TPending extends StreamPendingCallBase<TCall>> {
    defaultTimeout: Duration;
    safetyTimeout: Duration | null;
    pendingFactory: (record: StreamRecord<TCall, unknown>) => TPending;
}

/** Adapter over the live state arrays for the shared expectation machinery. */
function expectationHost<TCall, TPending extends StreamPendingCallBase<TCall>>(
    state: StreamProbeState<TCall, TPending>,
): ExpectationHost<TCall, TPending, StreamRecord<TCall, unknown>> {
    return {
        history: state.history,
        capturingWaiters: state.capturingWaiters,
        observingWaiters: state.observingWaiters,
        callNotifiers: state.callNotifiers,
        defaultTimeout: state.config.defaultTimeout,
        safetyTimeout: state.config.safetyTimeout,
        pendingFactory: state.config.pendingFactory,
    };
}

// ── recordCall + applyRule ──────────────────────────────────────────────────

function recordCallImpl<TCall, TPending extends StreamPendingCallBase<TCall>>(
    state: StreamProbeState<TCall, TPending>,
    call: TCall,
): AsyncIterable<unknown> {
    const channel = createChannel<unknown>();
    if (state.closed) {
        channel.error(errors.harnessClosed());
        return channel;
    }

    const id = state.nextId;
    state.nextId += 1;
    const record: StreamRecord<TCall, unknown> = { id, call, channel, routed: false, ruleParked: false };
    state.history.push(record);

    for (const notifier of state.callNotifiers.slice()) notifier.onCall(call);

    // Tier 1a — observers (FIFO, notify-only).
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
            waiter.resolve(state.config.pendingFactory(record));
            return channel;
        }
    }

    // Tier 2 — one-shot rules (single global FIFO queue).
    for (let i = 0; i < state.oneShotRules.length; i++) {
        const rule = state.oneShotRules[i];
        if (matchesFilter(rule.filter, call)) {
            state.oneShotRules.splice(i, 1);
            applyRule(record, rule.action);
            return channel;
        }
    }

    // Tier 3 — permanent rules (LIFO stack; iterate from newest).
    for (let i = state.permanentRules.length - 1; i >= 0; i--) {
        const rule = state.permanentRules[i];
        if (matchesFilter(rule.filter, call)) {
            applyRule(record, rule.action);
            return channel;
        }
    }

    // Default — park (no rule matched). routed remains false; the call is retroactively interceptable.
    return channel;
}

function applyRule<TCall>(record: StreamRecord<TCall, unknown>, action: StreamRuleAction<TCall, unknown>): void {
    if (record.channel.settled) return;

    switch (action.kind) {
        case 'reject':
            record.routed = true;
            record.channel.error(toError(action.error));
            return;

        case 'answer':
            record.routed = true;
            void pumpIntoChannel(record.channel, action.chunks);
            return;

        case 'answerWith': {
            record.routed = true;
            let result;
            try {
                result = action.fn(record.call);
            } catch (err) {
                record.channel.error(toError(err));
                return;
            }
            Promise.resolve(result).then(
                (source) => pumpIntoChannel(record.channel, source),
                (err: unknown) => {
                    if (!record.channel.settled) record.channel.error(toError(err));
                },
            );
            return;
        }

        case 'park':
            record.routed = true;
            record.ruleParked = true;
            return;
    }
}

// ── Pending-call factory ────────────────────────────────────────────────────

export function makeStreamPendingBase<TCall, TChunk = unknown>(
    record: StreamRecord<TCall, unknown>,
    label: string,
): StreamPendingCallBase<TCall, TChunk> {
    const channel = record.channel as StreamChannel<TChunk>;
    return {
        get call() {
            return record.call;
        },
        get settled() {
            return channel.settled;
        },
        push(chunk) {
            if (channel.settled) throw errors.doubleSettle(label);
            record.routed = true;
            channel.push(chunk);
        },
        end() {
            if (channel.settled) throw errors.doubleSettle(label);
            record.routed = true;
            channel.end();
        },
        error(err) {
            if (channel.settled) throw errors.doubleSettle(label);
            record.routed = true;
            channel.error(err);
        },
    };
}

// ── Engine factories: Selection / Probe / RuleBuilder ──────────────────────

function makeRuleBuilder<TCall, TPending extends StreamPendingCallBase<TCall>>(
    state: StreamProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
    tier: 'oneShot' | 'permanent',
    origin: 'harness' | 'user',
): StreamRuleBuilder<TCall, unknown> {
    const addRule = (action: StreamRuleAction<TCall, unknown>): void => {
        const entry: StreamRuleEntry<TCall, unknown> = { filter, action, origin };
        if (tier === 'oneShot') state.oneShotRules.push(entry);
        else state.permanentRules.push(entry);
    };

    return {
        answer(chunks) {
            addRule({ kind: 'answer', chunks });
        },
        answerWith(fn) {
            addRule({ kind: 'answerWith', fn });
        },
        reject(error) {
            addRule({ kind: 'reject', error });
        },
        park() {
            addRule({ kind: 'park' });
        },
    };
}

function makeSelection<TCall, TPending extends StreamPendingCallBase<TCall>>(
    state: StreamProbeState<TCall, TPending>,
    filter: FilterChain<TCall>,
): StreamSelection<TCall, TPending> {
    const host = expectationHost(state);
    const sel = {
        filter(predicate: CallMatcher<TCall>, label?: string) {
            const lbl = label ?? defaultLabel(predicate as { name?: string });
            return makeSelection(state, appendFilter(filter, predicate, lbl));
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
                    if (handler) handler(state.config.pendingFactory(record));
                }
            }
        },
        drainAndReject(error?: unknown) {
            for (const record of state.history) {
                if (matchesFilter(filter, record.call) && !record.channel.settled) {
                    record.routed = true;
                    record.channel.error(error ?? new Error('drained'));
                }
            }
        },
    };
    return sel as unknown as StreamSelection<TCall, TPending>;
}

function makeProbeAdmin<TCall, TPending extends StreamPendingCallBase<TCall>>(
    state: StreamProbeState<TCall, TPending>,
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

export function createStreamProbeRoot<TCall, TPending extends StreamPendingCallBase<TCall>>(
    config: StreamProbeRootConfig<TCall, TPending>,
): StreamProbeRoot<TCall, TPending> {
    const state: StreamProbeState<TCall, TPending> = {
        history: [],
        oneShotRules: [],
        permanentRules: [],
        capturingWaiters: [],
        observingWaiters: [],
        callNotifiers: [],
        config: {
            defaultTimeout: config.defaultTimeout ?? config.harness?.defaultTimeout ?? seconds(5),
            safetyTimeout:
                config.safetyTimeout !== undefined
                    ? config.safetyTimeout
                    : (config.harness?.safetyTimeout ?? seconds(30)),
            pendingFactory: config.pendingFactory,
        },
        closed: false,
        nextId: 0,
    };

    for (const def of config.defaultRules ?? []) {
        state.permanentRules.push({ filter: def.filter, action: def.action, origin: 'harness' });
    }

    const matchAll: FilterChain<TCall> = { predicates: [], label: '<all calls>' };
    const baseSelection = makeSelection(state, matchAll);
    const admin = makeProbeAdmin(state);

    const probe = Object.create(baseSelection) as StreamProbe<TCall, TPending>;
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
        recordCall(call) {
            return recordCallImpl(state, call);
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
            // Settle every still-open channel so an in-flight `for await`
            // completes (with the harness-closed error) instead of hanging
            // forever once its buffered chunks run out.
            for (const record of state.history) {
                if (!record.channel.settled) {
                    record.channel.error(errors.harnessClosed());
                }
            }
            state.callNotifiers.length = 0;
        },
    };
}

// Re-export milliseconds for internal use.
export { milliseconds };
