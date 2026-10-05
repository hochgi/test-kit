import type { Duration, ForwardablePendingCall, ForwardableProbe, ForwardableSelection } from '@hochgi/test-kit';

export type CacheKeyInput = string | { readonly format: string; readonly args: ReadonlyArray<string | number> };

export type CacheMethod = 'get' | 'set' | 'del' | 'setnx' | 'getSet';

export interface CacheCall {
    readonly method: CacheMethod;
    readonly args: ReadonlyArray<unknown>;
}

export interface CachePendingCall<TResult = unknown> extends ForwardablePendingCall<CacheCall, TResult> {
    readonly method: CacheMethod;
    readonly args: ReadonlyArray<unknown>;
}

export interface CacheAdapter {
    get<T>(key: CacheKeyInput): Promise<T | null>;
    set<T>(input: { key: CacheKeyInput; val: T }, ttl?: Duration): Promise<boolean>;
    del(key: CacheKeyInput): Promise<void>;
    setnx<T>(input: { key: CacheKeyInput; val: T }, options: { readonly ttl: Duration }): Promise<T>;
    getSet<T>(
        key: CacheKeyInput,
        load: () => Promise<T>,
        options?: { readonly ttl?: Duration | ((result: T) => Duration) },
    ): Promise<T>;
}

export interface CacheProbe extends ForwardableProbe<CacheCall, CachePendingCall> {
    on(method: CacheMethod): ForwardableSelection<CacheCall, CachePendingCall>;
}
