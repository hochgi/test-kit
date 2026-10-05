/**
 * Worked extender example: a probe-driven gRPC client adapter built on
 * @hochgi/test-kit.
 *
 * Step 1 — define the call shape.
 *
 * A gRPC unary call has a service name, method name, and a request payload.
 * The shape is captured as a plain inspectable object — no SDK references.
 */
import type { PendingCallBase, Probe, ProbedAdapter, ProbedResource, Selection } from '@hochgi/test-kit';

/**
 * One recorded gRPC call.
 */
export interface GrpcCall<TRequest = unknown> {
    readonly service: string;
    readonly method: string;
    readonly request: TRequest;
}

/**
 * Step 2 — define the pending call shape. We don't have a backing here
 * (gRPC requires a real network), so we extend the non-forwardable
 * PendingCallBase. Tests must always answer or reject explicitly.
 */
export interface GrpcPendingCall<TRequest = unknown, TResponse = unknown> extends PendingCallBase<
    GrpcCall<TRequest>,
    TResponse
> {
    readonly service: string;
    readonly method: string;
    readonly request: TRequest;
}

/**
 * Step 3 — define the probe interface with typed sugars. `service(name)`
 * narrows by service; `method(name)` by method; `on({ service, method })`
 * narrows by both.
 */
export interface GrpcProbe extends Probe<GrpcCall, GrpcPendingCall> {
    service(name: string): Selection<GrpcCall, GrpcPendingCall>;
    method(name: string): Selection<GrpcCall, GrpcPendingCall>;
    on(filter: { readonly service: string; readonly method: string }): Selection<GrpcCall, GrpcPendingCall>;
}

/**
 * The application-facing client. The SUT calls
 * `client.unary({ service, method, request })`.
 */
export interface GrpcClient {
    unary<TResponse = unknown>(call: GrpcCall): Promise<TResponse>;
}

export type ProbedGrpcClient = ProbedAdapter<GrpcClient, GrpcProbe> & ProbedResource;
