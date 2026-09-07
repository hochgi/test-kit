/**
 * Tests for the worked extender example.
 *
 * The point of this file is to verify that the extender contract works end-
 * to-end on top of @vnatures/test-kit. If a future change to the core
 * engine breaks the extender path, this test fails first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRig, milliseconds, type Rig } from '@vnatures/test-kit';
import { createProbedGrpcClient } from '../src/index.js';

interface ListUsersRequest {
    readonly limit: number;
}
interface ListUsersResponse {
    readonly users: ReadonlyArray<{ id: number; name: string }>;
}

describe('createProbedGrpcClient (extender example)', () => {
    let rig: Rig;

    beforeEach(() => {
        rig = createRig();
    });

    afterEach(async () => {
        await rig.close();
    });

    it('records calls with service/method/request shape', async () => {
        const grpc = createProbedGrpcClient({ harness: rig });

        void grpc.adapter.unary<ListUsersResponse>({
            service: 'users.UserService',
            method: 'ListUsers',
            request: { limit: 10 } satisfies ListUsersRequest,
        });

        const pending = await grpc.probe.expect.intercept();
        expect(pending.service).toBe('users.UserService');
        expect(pending.method).toBe('ListUsers');
        expect(pending.request).toEqual({ limit: 10 });

        pending.answer({ users: [{ id: 1, name: 'Alice' }] });
    });

    it('typed sugar — probe.on({ service, method }) narrows correctly', async () => {
        const grpc = createProbedGrpcClient({ harness: rig });

        void grpc.adapter.unary({
            service: 'users.UserService',
            method: 'GetUser',
            request: { id: 7 },
        });
        void grpc.adapter.unary({
            service: 'orders.OrderService',
            method: 'PlaceOrder',
            request: {},
        });

        const userPending = await grpc.probe.on({ service: 'users.UserService', method: 'GetUser' }).expect.intercept();
        expect(userPending.method).toBe('GetUser');
        userPending.answer({ id: 7, name: 'Alice' });

        const orderPending = await grpc.probe
            .on({ service: 'orders.OrderService', method: 'PlaceOrder' })
            .expect.intercept();
        orderPending.answer({ orderId: 'ORD-1' });
    });

    it('always().answerWith — dynamic per-call response', async () => {
        const grpc = createProbedGrpcClient({ harness: rig });

        grpc.probe
            .service('users.UserService')
            .always()
            .answerWith((call) => ({
                id: (call.request as { id: number }).id,
                name: 'Mock',
            }));

        await expect(
            grpc.adapter.unary({
                service: 'users.UserService',
                method: 'GetUser',
                request: { id: 42 },
            }),
        ).resolves.toEqual({ id: 42, name: 'Mock' });
    });

    it('intercept times out cleanly when no call arrives', async () => {
        const grpc = createProbedGrpcClient({ harness: rig });

        await expect(grpc.probe.expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
    });

    it('expect.observe is non-consuming alongside an always() answer', async () => {
        const grpc = createProbedGrpcClient({ harness: rig });

        grpc.probe.always().answer({ ok: true });

        const observePromise = grpc.probe.expect.observe();
        const callPromise = grpc.adapter.unary({
            service: 'health',
            method: 'Check',
            request: {},
        });

        const observed = await observePromise;
        expect(observed.service).toBe('health');

        await expect(callPromise).resolves.toEqual({ ok: true });
    });
});
