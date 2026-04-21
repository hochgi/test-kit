import { realSetTimeout, realClearTimeout, realSetImmediate, type Deferred, createDeferred, toError } from './internal';

type CallInternal = {
    index: number;
    method: string;
    args: unknown[];
    deferred: Deferred<unknown>;
    settled: boolean;
};

export type ProbeCall = {
    method: string;
    args: unknown[];
};

export interface PendingCall {
    readonly method: string;
    readonly args: unknown[];
    readonly settled: boolean;
    answer(value: unknown): void;
    reject(error: unknown): void;
}

type PlannedBehavior =
    | { type: 'return'; value: unknown }
    | { type: 'reject'; error: unknown }
    | { type: 'call'; fn: (...args: unknown[]) => unknown };

type Waiter = {
    predicate: (call: ProbeCall) => boolean;
    resolve: (call: PendingCall) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof realSetTimeout>;
};

// Type utilities for type-safe porcelain methods
type MethodKeys<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];
type MethodArgs<T, K extends keyof T> = T[K] extends (...args: infer A) => any ? A : never;
type MethodReturn<T, K extends keyof T> = T[K] extends (...args: any[]) => infer R ? Awaited<R> : never;

const passthroughProps = new Set([
    'then',
    'catch',
    'finally',
    'toJSON',
    'toString',
    'valueOf',
    'toLocaleString',
    '$$typeof',
    '@@toStringTag',
    'nodeType',
    'asymmetricMatch',
    'hasAttribute',
    'constructor',
    'prototype',
    'onModuleInit',
    'onApplicationBootstrap',
    'onModuleDestroy',
    'beforeApplicationShutdown',
    'onApplicationShutdown',
]);

async function flushMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
}

function makePendingCall(internal: CallInternal): PendingCall {
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
        answer(value: unknown) {
            if (internal.settled) {
                throw new Error(`Probe call "${internal.method}" is already settled.`);
            }
            internal.settled = true;
            internal.deferred.resolve(value);
        },
        reject(error: unknown) {
            if (internal.settled) {
                throw new Error(`Probe call "${internal.method}" is already settled.`);
            }
            internal.settled = true;
            internal.deferred.reject(toError(error));
        },
    };
}

export class TestProbe<T extends object = object> {
    private readonly queue: CallInternal[] = [];

    private readonly consumed = new Set<number>();

    private readonly waiters: Waiter[] = [];

    private readonly plannedByMethod = new Map<string, PlannedBehavior[]>();

    private readonly permanentByMethod = new Map<string, PlannedBehavior>();

    private nextIndex = 0;

    // ── Observation ──────────────────────────────────────────────────────────

    recordCall(method: string, args: unknown[], deferred: Deferred<unknown>): void {
        const index = this.nextIndex;
        this.nextIndex += 1;
        const internal: CallInternal = { index, method, args, deferred, settled: false };
        this.queue.push(internal);

        const behavior = this.resolveBehavior(method);
        if (behavior) {
            this.applyBehavior(internal, behavior);
        }

        for (let i = 0; i < this.waiters.length; i += 1) {
            const waiter = this.waiters[i];
            if (waiter.predicate({ method, args })) {
                this.waiters.splice(i, 1);
                if (waiter.timer) {
                    realClearTimeout(waiter.timer);
                }
                this.consumed.add(index);
                waiter.resolve(makePendingCall(internal));
                return;
            }
        }
    }

    async expectNext(timeoutMs = 5000): Promise<PendingCall> {
        return this.expectMatching(() => true, timeoutMs);
    }

    async expectMatching(predicate: (call: ProbeCall) => boolean, timeoutMs = 5000): Promise<PendingCall> {
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index) && predicate({ method: internal.method, args: internal.args })) {
                this.consumed.add(internal.index);
                return makePendingCall(internal);
            }
        }

        return new Promise<PendingCall>((resolve, reject) => {
            const waiter: Waiter = { predicate, resolve, reject };
            waiter.timer = realSetTimeout(() => {
                this.removeWaiter(waiter);
                reject(new Error(`Timed out waiting for matching probe call after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    async expectNoMsgWithin(ms: number): Promise<void> {
        const before = this.queue.length;
        advanceVirtualTime(ms);
        await flushMicrotasks();
        if (this.queue.length > before) {
            throw new Error(`Expected no message within ${ms}ms, but received one.`);
        }
    }

    get calls(): ReadonlyArray<ProbeCall> {
        return this.queue.map((c) => ({ method: c.method, args: c.args }));
    }

    pendingCount(): number {
        let count = 0;
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) count += 1;
        }
        return count;
    }

    drainWith(handler: (call: PendingCall) => void): void {
        for (const internal of this.queue) {
            if (!this.consumed.has(internal.index)) {
                this.consumed.add(internal.index);
                handler(makePendingCall(internal));
            }
        }
    }

    drain(): void {
        this.drainWith(() => {});
    }

    drainAndRejectAll(error?: Error): void {
        this.drainWith((call) => {
            if (!call.settled) {
                call.reject(error ?? new Error('drained'));
            }
        });
    }

    // ── Porcelain (pre-programming) ───────────────────────────────────────────

    whenCalled<K extends MethodKeys<T>>(
        method: K,
    ): {
        thenReturn(value: MethodReturn<T, K>): void;
        thenReject(error: unknown): void;
        thenCall(fn: (...args: MethodArgs<T, K>) => MethodReturn<T, K> | Promise<MethodReturn<T, K>>): void;
    } {
        const methodName = String(method);
        return {
            thenReturn: (value: MethodReturn<T, K>): void => {
                this.addPlannedBehavior(methodName, { type: 'return', value });
            },
            thenReject: (error: unknown): void => {
                this.addPlannedBehavior(methodName, { type: 'reject', error });
            },
            thenCall: (fn: (...args: MethodArgs<T, K>) => MethodReturn<T, K> | Promise<MethodReturn<T, K>>): void => {
                this.addPlannedBehavior(methodName, {
                    type: 'call',
                    fn: (...args) => fn(...(args as MethodArgs<T, K>)),
                });
            },
        };
    }

    alwaysReturn<K extends MethodKeys<T>>(method: K, value: MethodReturn<T, K>): void {
        this.permanentByMethod.set(String(method), { type: 'return', value });
    }

    alwaysReject<K extends MethodKeys<T>>(method: K, error: unknown): void {
        this.permanentByMethod.set(String(method), { type: 'reject', error });
    }

    alwaysCall<K extends MethodKeys<T>>(
        method: K,
        fn: (...args: MethodArgs<T, K>) => MethodReturn<T, K> | Promise<MethodReturn<T, K>>,
    ): void {
        this.permanentByMethod.set(String(method), {
            type: 'call',
            fn: (...args) => fn(...(args as MethodArgs<T, K>)),
        });
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private addPlannedBehavior(method: string, behavior: PlannedBehavior): void {
        const list = this.plannedByMethod.get(method) ?? [];
        list.push(behavior);
        this.plannedByMethod.set(method, list);
    }

    private resolveBehavior(method: string): PlannedBehavior | undefined {
        const list = this.plannedByMethod.get(method);
        if (list && list.length > 0) {
            const behavior = list.shift();
            if (list.length === 0) this.plannedByMethod.delete(method);
            return behavior;
        }
        return this.permanentByMethod.get(method);
    }

    private applyBehavior(call: CallInternal, behavior: PlannedBehavior): void {
        if (call.settled) return;
        call.settled = true;
        if (behavior.type === 'return') {
            call.deferred.resolve(behavior.value);
        } else if (behavior.type === 'reject') {
            call.deferred.reject(toError(behavior.error));
        } else {
            try {
                const result = behavior.fn(...call.args);
                if (result && typeof (result as any).then === 'function') {
                    (result as Promise<unknown>).then(
                        (v) => call.deferred.resolve(v),
                        (e) => call.deferred.reject(toError(e)),
                    );
                } else {
                    call.deferred.resolve(result);
                }
            } catch (error) {
                call.deferred.reject(toError(error));
            }
        }
    }

    private removeWaiter(waiter: Waiter): void {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
    }
}

function getAdvanceByTimeFn(): ((ms: number) => void) | undefined {
    const jestGlobal = (globalThis as { jest?: { advanceTimersByTime?: (ms: number) => void } }).jest;
    if (jestGlobal?.advanceTimersByTime) return jestGlobal.advanceTimersByTime.bind(jestGlobal);

    try {
        const jestFromModule = require('@jest/globals')?.jest as
            | { advanceTimersByTime?: (ms: number) => void }
            | undefined;
        if (jestFromModule?.advanceTimersByTime) return jestFromModule.advanceTimersByTime.bind(jestFromModule);
    } catch {
        // not running under jest globals module
    }

    const viGlobal = (globalThis as { vi?: { advanceTimersByTime?: (ms: number) => void } }).vi;
    if (viGlobal?.advanceTimersByTime) return viGlobal.advanceTimersByTime.bind(viGlobal);

    return undefined;
}

function advanceVirtualTime(ms: number): void {
    if (ms <= 0) return;
    const advanceByTime = getAdvanceByTimeFn();
    if (advanceByTime) {
        try {
            advanceByTime(ms);
        } catch {
            // fake timers not active — no-op
        }
    }
}

export function createProbePair<T extends object>(): { fake: T; probe: TestProbe<T> } {
    const probe = new TestProbe<T>();
    const fake = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop === 'symbol' || passthroughProps.has(prop)) {
                    return undefined;
                }
                return (...args: unknown[]) => {
                    const deferred = createDeferred<unknown>();
                    probe.recordCall(prop, args, deferred);
                    return deferred.promise;
                };
            },
        },
    ) as T;

    return { fake, probe };
}

export type ProbePairMap<T> = {
    [K in keyof T]: T[K] extends object ? { fake: T[K]; probe: TestProbe<T[K]> } : never;
};

export function extractFakes<T extends Record<string, { fake: unknown }>>(pairs: T): { [K in keyof T]: T[K]['fake'] } {
    return Object.fromEntries(Object.entries(pairs).map(([k, { fake }]) => [k, fake])) as {
        [K in keyof T]: T[K]['fake'];
    };
}

export function extractProbes<T extends Record<string, { probe: unknown }>>(
    pairs: T,
): { [K in keyof T]: T[K]['probe'] } {
    return Object.fromEntries(Object.entries(pairs).map(([k, { probe }]) => [k, probe])) as {
        [K in keyof T]: T[K]['probe'];
    };
}
