import type {
    ProbedAdapter,
    ProbedResource,
    StreamPendingCallBase,
    StreamProbe,
    StreamRuleBuilder,
    StreamSelection,
} from '@hochgi/test-kit';

// ── Stream method call shape ────────────────────────────────────────────────

export interface StreamMethodCall<
    TMethod extends string = string,
    TArgs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
> {
    readonly method: TMethod;
    readonly args: TArgs;
}

export interface StreamMethodPendingCall<
    TMethod extends string = string,
    TArgs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
    TChunk = unknown,
> extends StreamPendingCallBase<StreamMethodCall<TMethod, TArgs>, TChunk> {
    readonly method: TMethod;
    readonly args: TArgs;
}

// ── Type machinery ─────────────────────────────────────────────────────────

/** Method names on T whose return type is `AsyncIterable<...>` (covers async generator methods). */
export type StreamMethodName<T> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped method variance on a generic mock for async-iterable methods
    [K in keyof T]: T[K] extends (...args: any[]) => AsyncIterable<any> ? Extract<K, string> : never;
}[keyof T];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped method variance on a generic mock for async-iterable methods
export type StreamMethodArgs<T, K extends keyof T> = T[K] extends (...args: infer A) => any ? A : never;

/** The chunk type yielded by T[K], e.g. `ModelStreamEvent` for `stream(...): AsyncIterable<ModelStreamEvent>`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped method variance on a generic mock for async-iterable methods
export type StreamMethodChunk<T, K extends keyof T> = T[K] extends (...args: any[]) => AsyncIterable<infer C>
    ? C
    : never;

/**
 * Compile-time guard. If every name in M returns `AsyncIterable<...>`, returns
 * M unchanged. Otherwise returns a branded error type whose readonly
 * properties are visible in the TypeScript diagnostic.
 */
export type CheckedStreamMethods<T, M extends ReadonlyArray<string>> =
    Exclude<M[number], StreamMethodName<T>> extends never
        ? M
        : ReadonlyArray<StreamMethodName<T>> & {
              readonly __test_kit_error: 'createProbedStreamMock requires methods that return AsyncIterable<...> (e.g. an async generator method)';
              readonly __non_stream_methods_cannot_be_probed: Exclude<M[number], StreamMethodName<T>>;
              readonly __how_to_fix: 'For Promise-returning methods use createProbedMock. For sync dependencies, use the real implementation in tests.';
          };

// ── Probe + Selection types ────────────────────────────────────────────────

export interface StreamMethodSelection<T extends object, K extends StreamMethodName<T>> extends StreamSelection<
    StreamMethodCall<K, StreamMethodArgs<T, K>>,
    StreamMethodPendingCall<K, StreamMethodArgs<T, K>, StreamMethodChunk<T, K>>
> {
    once(): StreamRuleBuilder<StreamMethodCall<K, StreamMethodArgs<T, K>>, StreamMethodChunk<T, K>>;
    always(): StreamRuleBuilder<StreamMethodCall<K, StreamMethodArgs<T, K>>, StreamMethodChunk<T, K>>;
}

export interface StreamMethodProbe<T extends object> extends StreamProbe<
    StreamMethodCall<StreamMethodName<T>>,
    StreamMethodPendingCall<StreamMethodName<T>>
> {
    on<K extends StreamMethodName<T>>(method: K): StreamMethodSelection<T, K>;
}

// ── ProbedStreamMock ─────────────────────────────────────────────────────────

export type ProbedStreamMock<T extends object> = ProbedAdapter<T, StreamMethodProbe<T>> & ProbedResource;
