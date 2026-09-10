import type { PendingCallBase, Probe, ProbedAdapter, ProbedResource, RuleBuilder, Selection } from '@vnatures/test-kit';

// ── Method call shape ──────────────────────────────────────────────────────

export interface MethodCall<
    TMethod extends string = string,
    TArgs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
> {
    readonly method: TMethod;
    readonly args: TArgs;
}

export interface MethodPendingCall<
    TMethod extends string = string,
    TArgs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
    TResult = unknown,
> extends PendingCallBase<MethodCall<TMethod, TArgs>, TResult> {
    readonly method: TMethod;
    readonly args: TArgs;
}

// ── Type machinery ─────────────────────────────────────────────────────────

/** All method names on T (sync and async). */
export type MethodName<T> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped method variance on a generic mock
    [K in keyof T]: T[K] extends (...args: any[]) => any ? Extract<K, string> : never;
}[keyof T];

/**
 * Method names on T that return Promise<...> directly. Used as the constraint
 * for the `methods` parameter of createProbedMock.
 */
export type AsyncMethodName<T> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped method variance on a generic mock
    [K in keyof T]: T[K] extends (...args: any[]) => Promise<unknown> ? Extract<K, string> : never;
}[keyof T];

/** Sync method names on T. Used in compile-time error diagnostics. */
export type SyncMethodName<T> = Exclude<MethodName<T>, AsyncMethodName<T>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped method variance on a generic mock
export type MethodArgs<T, K extends keyof T> = T[K] extends (...args: infer A) => any ? A : never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped method variance on a generic mock
export type MethodResolvedReturn<T, K extends keyof T> = T[K] extends (...args: any[]) => infer R ? Awaited<R> : never;

/**
 * Compile-time guard. If every name in M is async, returns M unchanged.
 * Otherwise returns a branded error type whose readonly properties are
 * visible in the TypeScript diagnostic.
 */
export type CheckedMethods<T, M extends ReadonlyArray<string>> =
    Exclude<M[number], AsyncMethodName<T>> extends never
        ? M
        : ReadonlyArray<AsyncMethodName<T>> & {
              readonly __test_kit_error: 'createProbedMock requires methods that return Promise<...>';
              readonly __sync_methods_cannot_be_probed: Exclude<M[number], AsyncMethodName<T>>;
              readonly __how_to_fix: "For sync dependencies, use the real implementation in tests. See 'Synchronous Dependencies: Use The Real Thing' in the docs.";
          };

// ── Probe + Selection types ────────────────────────────────────────────────

export interface MethodSelection<T extends object, K extends AsyncMethodName<T>> extends Selection<
    MethodCall<K, MethodArgs<T, K>>,
    MethodPendingCall<K, MethodArgs<T, K>, MethodResolvedReturn<T, K>>
> {
    once(): RuleBuilder<
        MethodCall<K, MethodArgs<T, K>>,
        MethodPendingCall<K, MethodArgs<T, K>, MethodResolvedReturn<T, K>>
    >;
    always(): RuleBuilder<
        MethodCall<K, MethodArgs<T, K>>,
        MethodPendingCall<K, MethodArgs<T, K>, MethodResolvedReturn<T, K>>
    >;
}

export interface MethodProbe<T extends object> extends Probe<
    MethodCall<AsyncMethodName<T>>,
    MethodPendingCall<AsyncMethodName<T>>
> {
    on<K extends AsyncMethodName<T>>(method: K): MethodSelection<T, K>;
}

// ── ProbedMock ──────────────────────────────────────────────────────────────

export type ProbedMock<T extends object> = ProbedAdapter<T, MethodProbe<T>> & ProbedResource;
