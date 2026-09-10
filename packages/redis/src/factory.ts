// eslint-disable-next-line @typescript-eslint/naming-convention
import IoRedisMock from 'ioredis-mock';
import {
    createProbeRoot,
    emptyFilterChain,
    makeForwardablePending,
    type CallRecord,
    type Duration,
    type ForwardablePendingCall,
    type ForwardableSelection,
    type Rig,
    type ProbeRoot,
    type ProbedAdapterWithLifecycle,
} from '@vnatures/test-kit';
import { formatKey, fromStored, toStored } from './key.js';
import type { CacheAdapter, CacheCall, CacheKeyInput, CacheMethod, CachePendingCall, CacheProbe } from './types.js';

export interface CreateProbedCacheAdapterOptions {
    readonly harness: Rig;
    readonly defaultTimeout?: Duration;
}

export type ProbedCacheAdapter = ProbedAdapterWithLifecycle<CacheAdapter, CacheProbe>;

// eslint-disable-next-line max-lines-per-function -- existing factory over the published budget; extract on next touch
export function createProbedCacheAdapter(options: CreateProbedCacheAdapterOptions): ProbedCacheAdapter {
    const redis = new IoRedisMock();

    // Real (forward) implementations of each cache operation. Used by the
    // forward-rule and called via the forwardFn closure passed to recordCall.
    async function forwardGet(key: CacheKeyInput): Promise<unknown> {
        return fromStored<unknown>(await redis.get(formatKey(key)));
    }

    async function forwardSet(input: { key: CacheKeyInput; val: unknown }, ttl?: Duration): Promise<boolean> {
        const key = formatKey(input.key);
        if (ttl && ttl.milliseconds > 0) {
            const r = await redis.set(key, toStored(input.val), 'PX', ttl.milliseconds);
            return r === 'OK';
        }
        const r = await redis.set(key, toStored(input.val));
        return r === 'OK';
    }

    async function forwardDel(key: CacheKeyInput): Promise<void> {
        await redis.del(formatKey(key));
    }

    async function forwardSetnx(
        input: { key: CacheKeyInput; val: unknown },
        optsArg: { ttl: Duration },
    ): Promise<unknown> {
        const key = formatKey(input.key);
        const r = await redis.setnx(key, toStored(input.val));
        if (r === 1) {
            if (optsArg.ttl.milliseconds > 0) {
                await redis.pexpire(key, optsArg.ttl.milliseconds);
            }
            return input.val;
        }
        const existing = await redis.get(key);
        return fromStored<unknown>(existing);
    }

    async function forwardGetSet<T>(
        key: CacheKeyInput,
        load: () => Promise<T>,
        opts?: { ttl?: Duration | ((result: T) => Duration) },
    ): Promise<T> {
        const formatted = formatKey(key);
        const cached = await redis.get(formatted);
        if (cached !== null) return fromStored<T>(cached) as T;
        const value = await load();
        const ttl = typeof opts?.ttl === 'function' ? opts.ttl(value) : opts?.ttl;
        if (ttl && ttl.milliseconds > 0) {
            await redis.set(formatted, toStored(value), 'PX', ttl.milliseconds);
        } else {
            await redis.set(formatted, toStored(value));
        }
        return value;
    }

    // Probe with default-forward rule.
    const root: ProbeRoot<CacheCall, CachePendingCall> = createProbeRoot<CacheCall, CachePendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        pendingFactory: (record) => makeCachePending(record as CallRecord<CacheCall, CachePendingCall>),
        defaultRules: [
            {
                action: { kind: 'forward' },
                filter: emptyFilterChain as {
                    predicates: ReadonlyArray<{ fn: (call: CacheCall) => boolean; label: string }>;
                    label: string;
                },
            },
        ],
    });

    // The CacheProbe adds an `on(method)` typed sugar.
    const probe = root.probe as unknown as CacheProbe;
    (probe as { on: (method: CacheMethod) => unknown }).on = (method: CacheMethod) =>
        root.probe.filter(
            (call) => call.method === method,
            `method === '${method}'`,
        ) as unknown as ForwardableSelection<CacheCall, CachePendingCall>;

    // Adapter dispatches through the probe.
    const adapter: CacheAdapter = {
        get<T>(key: CacheKeyInput) {
            return root.recordCall({ method: 'get', args: [key] }, () => forwardGet(key)) as Promise<T | null>;
        },
        set<T>(input: { key: CacheKeyInput; val: T }, ttl?: Duration) {
            return root.recordCall({ method: 'set', args: [input, ttl] }, () =>
                forwardSet(input, ttl),
            ) as Promise<boolean>;
        },
        del(key: CacheKeyInput) {
            return root.recordCall({ method: 'del', args: [key] }, () => forwardDel(key)) as Promise<void>;
        },
        setnx<T>(input: { key: CacheKeyInput; val: T }, optsArg: { ttl: Duration }) {
            return root.recordCall({ method: 'setnx', args: [input, optsArg] }, () =>
                forwardSetnx(input, optsArg),
            ) as Promise<T>;
        },
        getSet<T>(
            key: CacheKeyInput,
            load: () => Promise<T>,
            optsArg?: { ttl?: Duration | ((result: T) => Duration) },
        ) {
            return root.recordCall({ method: 'getSet', args: [key, load, optsArg] }, () =>
                forwardGetSet(key, load, optsArg),
            ) as Promise<T>;
        },
    };

    return {
        adapter,
        probe,
        async reset() {
            await redis.flushall();
        },
        async close() {
            try {
                await redis.quit();
            } catch {
                // ioredis-mock's quit is best-effort
            }
            root.dispose();
        },
    };
}

function makeCachePending(record: CallRecord<CacheCall, CachePendingCall>): CachePendingCall {
    const base = makeForwardablePending<CacheCall>(
        record as CallRecord<CacheCall, ForwardablePendingCall<CacheCall>>,
        record.call.method,
    );
    const pending = Object.create(base) as ForwardablePendingCall<CacheCall>;
    Object.defineProperty(pending, 'method', {
        get: () => record.call.method,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'args', {
        get: () => record.call.args,
        enumerable: true,
        configurable: true,
    });
    return pending as CachePendingCall;
}
