import {
    createProbeRoot,
    errors,
    makePendingBase,
    type CallRecord,
    type Duration,
    type HarnessRef,
    type PendingCallBase,
    type ProbeRoot,
    type Selection,
} from '@vnatures/test-kit';
import type {
    AsyncMethodName,
    CheckedMethods,
    MethodCall,
    MethodPendingCall,
    MethodProbe,
    MethodSelection,
    ProbedMock,
} from './types.js';

export interface CreateProbedMockOptions<T extends object, M extends ReadonlyArray<string>> {
    readonly methods: CheckedMethods<T, M>;
    readonly defaultTimeout?: Duration;
    /**
     * Optional harness reference. When provided, the mock inherits the
     * harness's defaultTimeout / safetyTimeout / clock instead of using the
     * stand-alone fallback. Safe to omit for trivial single-mock tests.
     */
    readonly harness?: HarnessRef;
}

/**
 * `methods` constraint is intentionally loose (`readonly string[]`) so that
 * `CheckedMethods<T, M>` runs at the parameter position with the full M and
 * can produce its branded error. The default value `readonly AsyncMethodName<T>[]`
 * makes single-type-parameter calls type-check naturally.
 */
export function createProbedMock<
    T extends object,
    const M extends ReadonlyArray<string> = ReadonlyArray<AsyncMethodName<T>>,
>(options: CreateProbedMockOptions<T, M>): ProbedMock<T> {
    const methodList = options.methods as unknown as ReadonlyArray<string>;
    const methodSet = new Set<string>(methodList);

    const root: ProbeRoot<MethodCall<string>, MethodPendingCall<string>> = createProbeRoot<
        MethodCall<string>,
        MethodPendingCall<string>
    >({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: false,
        pendingFactory: (record) => makeMethodPending(record),
    });

    // Add `on(method)` typed sugar onto the probe.
    const probeWithSugar = root.probe as unknown as MethodProbe<T>;
    (probeWithSugar as { on: (method: string) => unknown }).on = (method: string) => {
        if (!methodSet.has(method)) {
            throw errors.syncMethodNotDeclared(method);
        }
        return root.probe.filter((call) => call.method === method, `method === '${method}'`) as unknown as Selection<
            MethodCall<string>,
            MethodPendingCall<string>
        >;
    };

    // Build the Proxy adapter. ALL non-listed property access returns
    // undefined; this is the v2 contract that closes the framework-probe
    // category (NestJS lifecycle hooks, Promise interop, JSON.stringify, etc.).
    const adapter = new Proxy({} as T, {
        get(_target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (!methodSet.has(prop)) return undefined;
            return (...args: ReadonlyArray<unknown>) => {
                const call: MethodCall<string> = { method: prop, args };
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

function makeMethodPending(
    record: CallRecord<MethodCall<string>, MethodPendingCall<string>>,
): MethodPendingCall<string> {
    const base = makePendingBase<MethodCall<string>>(
        record as CallRecord<MethodCall<string>, PendingCallBase<MethodCall<string>>>,
        record.call.method,
    );
    // Inherit from base so the live getters (call, settled) propagate through
    // mutation. Spreading or Object.assign would freeze the getters into static
    // values at construction time.
    const pending = Object.create(base) as PendingCallBase<MethodCall<string>>;
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
    return pending as MethodPendingCall<string>;
}

// Re-export MethodSelection for advanced consumers.
export type { MethodSelection };
