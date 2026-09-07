import {
    createStreamProbeRoot,
    errors,
    makeStreamPendingBase,
    type Duration,
    type RigRef,
    type StreamPendingCallBase,
    type StreamProbeRoot,
    type StreamRecord,
    type StreamSelection,
} from '@vnatures/test-kit';
import type {
    CheckedStreamMethods,
    StreamMethodCall,
    StreamMethodName,
    StreamMethodPendingCall,
    StreamMethodProbe,
    StreamMethodSelection,
    ProbedStreamMock,
} from './stream-types.js';

export interface CreateProbedStreamMockOptions<T extends object, M extends ReadonlyArray<string>> {
    readonly methods: CheckedStreamMethods<T, M>;
    readonly defaultTimeout?: Duration;
    /** Optional harness reference; see {@link CreateProbedMockOptions.harness}. */
    readonly harness?: RigRef;
}

/**
 * Fakes an interface whose methods return `AsyncIterable<...>` (typically an
 * `async *method()` generator) — the shape a `createProbedMock` can't take,
 * since that factory settles each call once via a single Promise. Here each
 * call gets a `push`/`end`/`error`-driven channel instead: `.answer([...])`
 * replays a scripted chunk sequence then ends; `.expect.intercept()` hands
 * back a pending call you can push/end/error interactively while the
 * consumer's `for await` is in flight.
 */
export function createProbedStreamMock<
    T extends object,
    const M extends ReadonlyArray<string> = ReadonlyArray<StreamMethodName<T>>,
>(options: CreateProbedStreamMockOptions<T, M>): ProbedStreamMock<T> {
    const methodList = options.methods as unknown as ReadonlyArray<string>;
    const methodSet = new Set<string>(methodList);

    const root: StreamProbeRoot<StreamMethodCall<string>, StreamMethodPendingCall<string>> = createStreamProbeRoot<
        StreamMethodCall<string>,
        StreamMethodPendingCall<string>
    >({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        pendingFactory: (record) => makeStreamMethodPending(record),
    });

    // Add `on(method)` typed sugar onto the probe (same v2 contract as createProbedMock).
    const probeWithSugar = root.probe as unknown as StreamMethodProbe<T>;
    (probeWithSugar as { on: (method: string) => unknown }).on = (method: string) => {
        if (!methodSet.has(method)) {
            throw errors.syncMethodNotDeclared(method);
        }
        return root.probe.filter(
            (call) => call.method === method,
            `method === '${method}'`,
        ) as unknown as StreamSelection<StreamMethodCall<string>, StreamMethodPendingCall<string>>;
    };

    // Build the Proxy adapter. Every listed method returns the synchronous
    // async-iterable channel from `recordCall` directly — NOT a Promise — so
    // `for await (const x of adapter.method())` works immediately, matching
    // the shape of a real async generator method.
    const adapter = new Proxy({} as T, {
        get(_target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (!methodSet.has(prop)) return undefined;
            return (...args: ReadonlyArray<unknown>) => {
                const call: StreamMethodCall<string> = { method: prop, args };
                return root.recordCall(call);
            };
        },
        has(_target, prop) {
            if (typeof prop !== 'string') return false;
            return methodSet.has(prop);
        },
    });

    return {
        adapter,
        probe: probeWithSugar,
        reset() {
            root.probe.clearCalls();
        },
        close() {
            root.dispose();
        },
    };
}

function makeStreamMethodPending(
    record: StreamRecord<StreamMethodCall<string>, unknown>,
): StreamMethodPendingCall<string> {
    const base = makeStreamPendingBase<StreamMethodCall<string>>(record, record.call.method);
    // Inherit from base so the live getters (call, settled) propagate through
    // mutation. Spreading or Object.assign would freeze the getters into static
    // values at construction time.
    const pending = Object.create(base) as StreamPendingCallBase<StreamMethodCall<string>>;
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
    return pending as StreamMethodPendingCall<string>;
}

// Re-export StreamMethodSelection for advanced consumers.
export type { StreamMethodSelection };
