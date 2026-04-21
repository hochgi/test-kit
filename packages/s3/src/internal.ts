// Timing helpers that remain tied to the REAL timer functions, independent of
// whether the test suite installs fake timers. Without this, a waiter's timeout
// would be frozen by jest.useFakeTimers() and never fire.

export const realSetTimeout = globalThis.setTimeout;
export const realClearTimeout = globalThis.clearTimeout;

export type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
