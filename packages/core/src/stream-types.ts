/**
 * Public + internal type surface for the stream probe engine
 * (`stream-probe-engine.ts`). Parallels `types.ts`, but for boundaries whose
 * method returns `AsyncIterable<TChunk>` (e.g. an `async *stream()` method)
 * instead of `Promise<TResult>`.
 *
 * Deliberately NOT unified with the Promise-settlement types in `types.ts`:
 * a stream call settles by pushing zero-or-more chunks over time and then
 * ending or erroring, not by resolving/rejecting once. Forcing both models
 * through one generic would either leak stream concerns into every Promise-
 * based domain package or leak single-value concerns into this one. If a
 * third settlement model shows up, that's the point to look for a shared
 * abstraction (BSSN) — not before.
 */
import type { Duration } from './duration.js';
import type {
    CallMatcher,
    CallTypeGuard,
    ExpectOptions,
    FilterChain,
    HarnessRef,
    ProbeAdmin,
    RequiredWithinOptions,
} from './types.js';

// ── Public pending-call types ───────────────────────────────────────────────

export interface StreamPendingCallBase<TCall, TChunk = unknown> {
    readonly call: TCall;
    /** `true` once `end()` or `error()` has closed the stream. `push()` remains legal until then. */
    readonly settled: boolean;
    /** Enqueue one chunk. The consumer's next `for await` step receives it. */
    push(chunk: TChunk): void;
    /** Close the stream normally — the consumer's iteration completes. */
    end(): void;
    /** Close the stream with an error — the consumer's iteration throws. */
    error(err: unknown): void;
}

// ── Public RuleBuilder types ────────────────────────────────────────────────

export interface StreamRuleBuilder<TCall = unknown, TChunk = unknown> {
    /** Push every chunk in order, then end normally. */
    answer(chunks: Iterable<TChunk> | AsyncIterable<TChunk>): void;
    /**
     * Push every chunk yielded by `fn`'s result, then end normally — or, if
     * the source throws/rejects partway through, error at that point. This is
     * how a "yields N chunks then fails" script is expressed: have `fn`
     * return an async generator that yields then throws.
     */
    answerWith(
        fn: (
            call: TCall,
        ) => Iterable<TChunk> | AsyncIterable<TChunk> | Promise<Iterable<TChunk> | AsyncIterable<TChunk>>,
    ): void;
    /** Close the stream with an error before any chunk is pushed. */
    reject(error: unknown): void;
    /** Never close the stream — the consumer's iteration hangs (for timeout tests). */
    park(): void;
}

// ── Public Expectations interface ───────────────────────────────────────────
// Same semantics as core's `Expectations`, restated because `TPending` here
// extends `StreamPendingCallBase`, not `PendingCallBase` — see file header.

export interface StreamExpectations<TCall, TPending extends StreamPendingCallBase<TCall>> {
    intercept(options?: ExpectOptions): Promise<TPending>;
    observe(options?: ExpectOptions): Promise<TCall>;
    none(options: RequiredWithinOptions): Promise<void>;
    atLeast(n: number, options?: ExpectOptions): Promise<ReadonlyArray<TCall>>;
    exactly(n: number, options: RequiredWithinOptions): Promise<ReadonlyArray<TCall>>;
    calledTimes(n: number): void;
    neverCalled(): void;
    called(): void;
}

// ── Public Selection interface ──────────────────────────────────────────────

export interface StreamSelection<TCall, TPending extends StreamPendingCallBase<TCall>> {
    filter(predicate: CallMatcher<TCall>, label?: string): StreamSelection<TCall, TPending>;
    filter<TNarrow extends TCall>(
        predicate: CallTypeGuard<TCall, TNarrow>,
        label?: string,
    ): StreamSelection<TNarrow, StreamPendingCallBase<TNarrow>>;

    once(): StreamRuleBuilder<TCall, StreamChunkOf<TPending>>;
    always(): StreamRuleBuilder<TCall, StreamChunkOf<TPending>>;

    readonly expect: StreamExpectations<TCall, TPending>;
    readonly calls: ReadonlyArray<TCall>;

    drain(handler?: (pending: TPending) => void): void;
    drainAndReject(error?: unknown): void;
}

/** Extracts the chunk type from a `StreamPendingCallBase<TCall, TChunk>`. */
export type StreamChunkOf<TPending> =
    TPending extends StreamPendingCallBase<infer _TCall, infer TChunk> ? TChunk : unknown;

export type StreamProbe<TCall, TPending extends StreamPendingCallBase<TCall>> = StreamSelection<TCall, TPending> &
    ProbeAdmin;

// ── Internal types (re-exported for domain-package use) ────────────────────

export interface StreamRecord<TCall, TChunk> {
    readonly id: number;
    readonly call: TCall;
    readonly channel: StreamChannel<TChunk>;
    routed: boolean;
    ruleParked: boolean;
}

export type StreamRuleAction<TCall, TChunk> =
    | { readonly kind: 'answer'; readonly chunks: Iterable<TChunk> | AsyncIterable<TChunk> }
    | {
          readonly kind: 'answerWith';
          readonly fn: (
              call: TCall,
          ) => Iterable<TChunk> | AsyncIterable<TChunk> | Promise<Iterable<TChunk> | AsyncIterable<TChunk>>;
      }
    | { readonly kind: 'reject'; readonly error: unknown }
    | { readonly kind: 'park' };

export interface StreamRuleEntry<TCall, TChunk> {
    readonly filter: FilterChain<TCall>;
    readonly action: StreamRuleAction<TCall, TChunk>;
    readonly origin: 'harness' | 'user';
}

export interface StreamWaiterEntry<TCall, TPending> {
    readonly filter: FilterChain<TCall>;
    resolve(pending: TPending): void;
    reject(error: Error): void;
    cleanup(): void;
}

export interface StreamObserverEntry<TCall> {
    readonly filter: FilterChain<TCall>;
    resolve(call: TCall): void;
    reject(error: Error): void;
    cleanup(): void;
}

export interface StreamCallNotifier<TCall> {
    onCall(call: TCall): void;
}

/**
 * A multi-value async channel: producers `push`/`end`/`error`, consumers pull
 * via `Symbol.asyncIterator`. The consumer side is available synchronously
 * (unlike a Promise), which is what lets an async-generator-shaped adapter
 * method return immediately, before any rule has settled anything.
 */
export interface StreamChannel<TChunk> extends AsyncIterable<TChunk> {
    readonly settled: boolean;
    push(chunk: TChunk): void;
    end(): void;
    error(err: unknown): void;
}

export interface StreamProbeRootConfig<TCall, TPending extends StreamPendingCallBase<TCall>> {
    readonly harness?: HarnessRef;
    readonly defaultTimeout?: Duration;
    readonly safetyTimeout?: Duration | null;
    readonly pendingFactory: (record: StreamRecord<TCall, unknown>) => TPending;
    readonly defaultRules?: ReadonlyArray<{
        readonly action: StreamRuleAction<TCall, unknown>;
        readonly filter: FilterChain<TCall>;
    }>;
}

export interface StreamProbeRoot<TCall, TPending extends StreamPendingCallBase<TCall>> {
    readonly probe: StreamProbe<TCall, TPending>;
    /** Records the call and returns the consumer-facing async iterable synchronously — never a Promise. */
    recordCall(call: TCall): AsyncIterable<unknown>;
    dispose(): void;
}
