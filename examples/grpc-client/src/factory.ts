/**
 * Step 4 — implement the adapter using `createProbeRoot`.
 *
 * The adapter dispatches every SUT call through `recordCall`, and the
 * factory exposes a `GrpcProbe` whose typed sugars compose to `filter()`.
 */
import {
    createProbeRoot,
    errors,
    makePendingBase,
    type CallRecord,
    type Duration,
    type Rig,
    type PendingCallBase,
    type ProbeRoot,
    type Selection,
} from '@vnatures/test-kit';
import type { GrpcCall, GrpcClient, GrpcPendingCall, GrpcProbe, ProbedGrpcClient } from './types.js';

export interface CreateProbedGrpcClientOptions {
    /** Optional. When provided, the probe inherits harness clock + safety. */
    readonly harness?: Rig;
    readonly defaultTimeout?: Duration;
}

export function createProbedGrpcClient(options?: CreateProbedGrpcClientOptions): ProbedGrpcClient {
    const root: ProbeRoot<GrpcCall, GrpcPendingCall> = createProbeRoot<GrpcCall, GrpcPendingCall>({
        harness: options?.harness,
        defaultTimeout: options?.defaultTimeout,
        forwardable: false, // No backing — answer/reject explicitly.
        pendingFactory: (record) => makeGrpcPending(record as CallRecord<GrpcCall, GrpcPendingCall>),
    });

    // Step 5 — typed filter sugars on the probe.
    const probe = root.probe as unknown as GrpcProbe;
    (probe as { service: (name: string) => unknown }).service = (name: string) =>
        root.probe.filter((call) => call.service === name, `service === '${name}'`) as unknown as Selection<
            GrpcCall,
            GrpcPendingCall
        >;
    (probe as { method: (name: string) => unknown }).method = (name: string) =>
        root.probe.filter((call) => call.method === name, `method === '${name}'`) as unknown as Selection<
            GrpcCall,
            GrpcPendingCall
        >;
    (probe as { on: (f: { service: string; method: string }) => unknown }).on = (f) =>
        root.probe.filter(
            (call) => call.service === f.service && call.method === f.method,
            `service='${f.service}' AND method='${f.method}'`,
        ) as unknown as Selection<GrpcCall, GrpcPendingCall>;

    // Step 6 — application-facing client.
    const adapter: GrpcClient = {
        unary<TResponse>(call: GrpcCall): Promise<TResponse> {
            return root.recordCall(call) as Promise<TResponse>;
        },
    };

    // Step 7 — lifecycle. No external resources to release; reset is a no-op,
    // close just disposes the probe (cancels in-flight waiters).
    return {
        adapter,
        probe,
        reset() {
            // No external state for this stubbed client.
            void errors; // ensure errors import isn't tree-shaken; kept for examples
        },
        close() {
            root.dispose();
        },
    };
}

function makeGrpcPending(record: CallRecord<GrpcCall, GrpcPendingCall>): GrpcPendingCall {
    const label = `${record.call.service}/${record.call.method}`;
    const base = makePendingBase<GrpcCall>(record as CallRecord<GrpcCall, PendingCallBase<GrpcCall>>, label);
    const pending = Object.create(base) as PendingCallBase<GrpcCall>;
    Object.defineProperty(pending, 'service', {
        get: () => record.call.service,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'method', {
        get: () => record.call.method,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'request', {
        get: () => record.call.request,
        enumerable: true,
        configurable: true,
    });
    return pending as GrpcPendingCall;
}
