/**
 * Public + internal type surface for the v2 core engine.
 *
 * Exported types appear in the public API per docs/v2-api-surface.md.
 * Internal types (FilterChain, ProbeState, CallRecord, RuleEntry, etc.)
 * are exported because domain packages need them to construct probes
 * via `createProbeRoot`. Users should not import these directly.
 */
import type { Duration } from './duration.js';
import type { Clock } from './clock.js';

// ── Public expectations options ─────────────────────────────────────────────

export type CallMatcher<TCall> = (call: TCall) => boolean;
export type CallTypeGuard<TCall, TNarrow extends TCall> = (call: TCall) => call is TNarrow;

export interface ExpectOptions {
    readonly within?: Duration;
}

export interface RequiredWithinOptions {
    readonly within: Duration;
}

// ── Public pending-call types ───────────────────────────────────────────────

export interface PendingCallBase<TCall, TResult = unknown> {
    readonly call: TCall;
    readonly settled: boolean;
    answer(value: Awaited<TResult>): void;
    answerWith(fn: (call: TCall) => Awaited<TResult> | Promise<Awaited<TResult>>): void;
    reject(error: unknown): void;
}

export interface ForwardablePendingCall<TCall, TResult = unknown> extends PendingCallBase<TCall, TResult> {
    forward(): void;
}

export type PendingAnswer<TPending> =
    TPending extends PendingCallBase<infer _TCall, infer TResult> ? Awaited<TResult> : unknown;

export type NarrowPending<TPending, TNarrow> =
    TPending extends PendingCallBase<infer TCall, infer TResult>
        ? TNarrow extends TCall
            ? PendingCallBase<TNarrow, TResult>
            : never
        : never;

// ── Public RuleBuilder types ────────────────────────────────────────────────

export interface RuleBuilder<TCall, TPending extends PendingCallBase<TCall>> {
    answer(value: PendingAnswer<TPending>): void;
    answerWith(fn: (call: TCall) => PendingAnswer<TPending> | Promise<PendingAnswer<TPending>>): void;
    reject(error: unknown): void;
    park(): void;
}

export interface ForwardableRuleBuilder<TCall, TPending extends ForwardablePendingCall<TCall>> extends RuleBuilder<
    TCall,
    TPending
> {
    forward(): void;
}

// ── Public Expectations interface ───────────────────────────────────────────

export interface Expectations<TCall, TPending extends PendingCallBase<TCall>> {
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

export interface Selection<TCall, TPending extends PendingCallBase<TCall>> {
    filter(predicate: CallMatcher<TCall>, label?: string): Selection<TCall, TPending>;
    filter<TNarrow extends TCall>(
        predicate: CallTypeGuard<TCall, TNarrow>,
        label?: string,
    ): Selection<TNarrow, NarrowPending<TPending, TNarrow>>;

    once(): RuleBuilder<TCall, TPending>;
    always(): RuleBuilder<TCall, TPending>;

    readonly expect: Expectations<TCall, TPending>;
    readonly calls: ReadonlyArray<TCall>;

    drain(handler?: (pending: TPending) => void): void;
    drainAndReject(error?: unknown): void;
}

export interface ForwardableSelection<TCall, TPending extends ForwardablePendingCall<TCall>> extends Selection<
    TCall,
    TPending
> {
    once(): ForwardableRuleBuilder<TCall, TPending>;
    always(): ForwardableRuleBuilder<TCall, TPending>;
    drainAndForward(): void;
}

export interface ProbeAdmin {
    clearRules(options?: { includeDefaults?: boolean }): void;
    clearCalls(): void;
    resetProbe(options?: { includeDefaults?: boolean }): void;
}

export type Probe<TCall, TPending extends PendingCallBase<TCall>> = Selection<TCall, TPending> & ProbeAdmin;

export type ForwardableProbe<TCall, TPending extends ForwardablePendingCall<TCall>> = ForwardableSelection<
    TCall,
    TPending
> &
    ProbeAdmin;

// ── Public adapter types ────────────────────────────────────────────────────

export interface ProbedAdapter<TAdapter, TProbe> {
    readonly adapter: TAdapter;
    readonly probe: TProbe;
}

export interface ProbedResource {
    reset(): Promise<void> | void;
    close(): Promise<void> | void;
}

export type ProbedAdapterWithLifecycle<TAdapter, TProbe> = ProbedAdapter<TAdapter, TProbe> & ProbedResource;

// ── Internal types (re-exported for domain-package use) ────────────────────

export interface FilterChain<TCall> {
    readonly predicates: ReadonlyArray<{
        readonly fn: (call: TCall) => boolean;
        readonly label: string;
    }>;
    readonly label: string;
}

export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason: unknown): void;
}

export interface CallRecord<TCall, _TPending> {
    readonly id: number;
    readonly call: TCall;
    readonly deferred: Deferred<unknown>;
    routed: boolean;
    settled: boolean;
    ruleParked: boolean;
    readonly forwardFn?: () => Promise<unknown>;
}

export type RuleAction<TCall, TPending extends PendingCallBase<TCall>> =
    | { readonly kind: 'answer'; readonly value: PendingAnswer<TPending> }
    | {
          readonly kind: 'answerWith';
          readonly fn: (call: TCall) => unknown | Promise<unknown>;
      }
    | { readonly kind: 'reject'; readonly error: unknown }
    | { readonly kind: 'forward' }
    | { readonly kind: 'park' };

export interface RuleEntry<TCall, TPending extends PendingCallBase<TCall>> {
    readonly filter: FilterChain<TCall>;
    readonly action: RuleAction<TCall, TPending>;
    readonly origin: 'harness' | 'user';
}

export interface WaiterEntry<TCall, TPending extends PendingCallBase<TCall>> {
    readonly filter: FilterChain<TCall>;
    resolve(pending: TPending): void;
    reject(error: Error): void;
    /** Cleans up the per-waiter timers (within + safety). */
    cleanup(): void;
}

export interface ObserverEntry<TCall> {
    readonly filter: FilterChain<TCall>;
    resolve(call: TCall): void;
    reject(error: Error): void;
    cleanup(): void;
}

/** Notifier hook used by atLeast/exactly to react to incoming calls. */
export interface CallNotifier<TCall> {
    onCall(call: TCall): void;
}

// Forward-declared to avoid circularity with harness.ts.
export interface HarnessRef {
    readonly clock: Clock;
    readonly defaultTimeout: Duration;
    readonly safetyTimeout: Duration | null;
}

export interface ProbeRootConfig<TCall, TPending extends PendingCallBase<TCall>> {
    readonly harness?: HarnessRef;
    readonly defaultTimeout?: Duration;
    readonly safetyTimeout?: Duration | null;
    readonly pendingFactory: (record: CallRecord<TCall, TPending>) => TPending;
    readonly forwardable?: boolean;
    readonly defaultRules?: ReadonlyArray<{
        readonly action: RuleAction<TCall, TPending>;
        readonly filter: FilterChain<TCall>;
    }>;
}

export interface ProbeRoot<TCall, TPending extends PendingCallBase<TCall>> {
    readonly probe: Probe<TCall, TPending>;
    recordCall(call: TCall, forwardFn?: () => Promise<unknown>): Promise<unknown>;
    dispose(): void;
}

/**
 * Convenience: an empty filter chain (matches every call). Used by domain
 * packages when installing a default rule and by the probe-root factory
 * itself for the root selection.
 */
export const emptyFilterChain: FilterChain<unknown> = {
    predicates: [],
    label: '<all calls>',
};
