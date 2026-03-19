// eslint-disable-next-line @typescript-eslint/naming-convention
import Redis from 'ioredis-mock';

import { buildCacheOperations } from './cache';
import type { InMemoryCache } from './cache';

// ── Timing helpers ──────────────────────────────────────────────────────────

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

// ── Public types ────────────────────────────────────────────────────────────

export type CacheMethod = 'set' | 'get' | 'del' | 'setnx' | 'getSet';

export interface CacheCall {
    readonly method: CacheMethod;
    readonly args: unknown[];
}

export interface PendingCacheCall {
    readonly method: CacheMethod;
    readonly args: unknown[];
    readonly settled: boolean;
    forward(): void;
    reject(error: unknown): void;
}

// ── Internal state ──────────────────────────────────────────────────────────

type CallInternal = {
    index: number;
    method: CacheMethod;
    args: unknown[];
    deferred: Deferred<unknown>;
    realFn: (...a: any[]) => Promise<unknown>;
    settled: boolean;
};

type PlannedBehavior = { type: 'forward' } | { type: 'reject'; error: unknown };

type Waiter = {
    predicate: (call: CacheCall) => boolean;
    resolve: (pending: PendingCacheCall) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof realSetTimeout>;
};

// ── PendingCacheCall factory ────────────────────────────────────────────────

function makePendingCacheCall(internal: CallInternal): PendingCacheCall {
    return {
        get method() {
            return internal.method;
        },
        get args() {
            return internal.args;
        },
        get settled() {
            return internal.settled;
        },
        forward() {
            if (internal.settled) {
                throw new Error(`Cache call "${internal.method}" is already settled.`);
            }
            internal.settled = true;
            internal.realFn(...internal.args).then(
                (result) => internal.deferred.resolve(result),
                (err) => internal.deferred.reject(toError(err)),
            );
        },
        reject(error: unknown) {
            if (internal.settled) {
                throw new Error(`Cache call "${internal.method}" is already settled.`);
            }
            internal.settled = true;
            internal.deferred.reject(toError(error));
        },
    };
}

// ── CacheProbe ──────────────────────────────────────────────────────────────

export class CacheProbe {
    private readonly queue: CallInternal[] = [];

    private readonly consumed = new Set<number>();

    private readonly waiters: Waiter[] = [];

    private readonly planned: PlannedBehavior[] = [];

    private permanent: PlannedBehavior | undefined;

    private nextIndex = 0;

    /** @internal — called by the probed cache wrapper */
    recordCall(method: CacheMethod, args: unknown[], realFn: (...a: any[]) => Promise<unknown>): Promise<unknown> {
        const deferred = createDeferred<unknown>();
        const index = this.nextIndex;
        this.nextIndex += 1;

        const internal: CallInternal = {
            index,
            method,
            args,
            deferred,
            realFn,
            settled: false,
        };

        this.queue.push(internal);

        for (let i = 0; i < this.waiters.length; i += 1) {
            const waiter = this.waiters[i];
            if (waiter.predicate({ method: internal.method, args: internal.args })) {
                this.waiters.splice(i, 1);
                if (waiter.timer) realClearTimeout(waiter.timer);
                this.consumed.add(index);
                waiter.resolve(makePendingCacheCall(internal));
                return deferred.promise;
            }
        }

        const behavior = this.resolveBehavior();
        if (behavior) {
            this.applyBehavior(internal, behavior);
        }

        return deferred.promise;
    }

    // ── Plumbing: wait for calls ────────────────────────────────────────────

    async expectNext(timeoutMs = 5000): Promise<PendingCacheCall> {
        return this.expectMatching(() => true, timeoutMs);
    }

    async expectMatching(predicate: (call: CacheCall) => boolean, timeoutMs = 5000): Promise<PendingCacheCall> {
        for (const internal of this.queue) {
            if (
                !this.consumed.has(internal.index) &&
                !internal.settled &&
                predicate({ method: internal.method, args: internal.args })
            ) {
                this.consumed.add(internal.index);
                return makePendingCacheCall(internal);
            }
        }

        return new Promise<PendingCacheCall>((resolve, reject) => {
            const waiter: Waiter = { predicate, resolve, reject };
            waiter.timer = realSetTimeout(() => {
                this.removeWaiter(waiter);
                reject(new Error(`Timed out waiting for matching cache call after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    // ── Observation ─────────────────────────────────────────────────────────

    get calls(): ReadonlyArray<CacheCall> {
        return this.queue.map((c) => ({ method: c.method, args: c.args }));
    }

    pendingCount(): number {
        let count = 0;
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) count += 1;
        }
        return count;
    }

    // ── Porcelain: pre-program behavior ─────────────────────────────────────

    whenCalled(): { thenForward(): void; thenReject(error: unknown): void } {
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

    clearBehavior(): void {
        this.permanent = undefined;
        this.planned.length = 0;
    }

    // ── Drain helpers ───────────────────────────────────────────────────────

    drainWith(handler: (pending: PendingCacheCall) => void): void {
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) {
                this.consumed.add(internal.index);
                handler(makePendingCacheCall(internal));
            }
        }
    }

    drain(): void {
        this.drainWith(() => {});
    }

    drainAndForwardAll(): void {
        this.drainWith((c) => {
            if (!c.settled) c.forward();
        });
    }

    drainAndRejectAll(error?: Error): void {
        this.drainWith((c) => {
            if (!c.settled) c.reject(error ?? new Error('drained'));
        });
    }

    // ── Private ─────────────────────────────────────────────────────────────

    private resolveBehavior(): PlannedBehavior | undefined {
        if (this.planned.length > 0) {
            return this.planned.shift();
        }
        return this.permanent;
    }

    private applyBehavior(internal: CallInternal, behavior: PlannedBehavior): void {
        if (internal.settled) return;
        internal.settled = true;
        if (behavior.type === 'forward') {
            internal.realFn(...internal.args).then(
                (result) => internal.deferred.resolve(result),
                (err) => internal.deferred.reject(toError(err)),
            );
        } else {
            internal.deferred.reject(toError(behavior.error));
        }
    }

    private removeWaiter(waiter: Waiter): void {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
    }
}

// ── Probed cache factory ────────────────────────────────────────────────────

export interface ProbedCache extends InMemoryCache {
    readonly probe: CacheProbe;
}

export function createProbedCache(): ProbedCache {
    const client = new Redis();
    const probe = new CacheProbe();
    const real = buildCacheOperations(client);

    probe.alwaysForward();

    function intercept(method: CacheMethod, realFn: (...args: any[]) => Promise<any>) {
        return (...args: any[]): Promise<any> => probe.recordCall(method, args, realFn);
    }

    return {
        client,
        probe,
        set: intercept('set', real.set) as ProbedCache['set'],
        get: intercept('get', real.get) as ProbedCache['get'],
        del: intercept('del', real.del) as ProbedCache['del'],
        setnx: intercept('setnx', real.setnx) as ProbedCache['setnx'],
        getSet: intercept('getSet', real.getSet) as ProbedCache['getSet'],
    };
}
