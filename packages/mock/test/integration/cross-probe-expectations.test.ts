/**
 * Phase 2 tests for rig.expect.sequence and rig.expect.allOf.
 *
 * Per docs/concepts.md §"Cross-Probe Expectations" and
 * docs/api-surface.md §"RigExpectations":
 *   - sequence(steps, { within }) — strict order; fails on out-of-order
 *   - allOf(steps, { within })    — any order; fails on missing
 *   - observation(selection)      — wraps a step as observation-only
 *   - return type infers per-step (TPending for capture, TCall for observe)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRig, milliseconds, observation, seconds, type Rig } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';

interface Payments {
    charge(userId: number, amount: number): Promise<{ ok: boolean; txn?: string }>;
}
interface Events {
    publish(topic: string, event: unknown): Promise<void>;
}

describe('rig.expect.sequence — strict ordering', () => {
    let rig: Rig;
    beforeEach(() => {
        rig = createRig();
    });
    afterEach(async () => {
        await rig.close();
    });

    it('resolves when calls arrive in the expected order', async () => {
        const payments = rig.attach(createProbedMock<Payments>({ methods: ['charge'] }));
        const events = rig.attach(createProbedMock<Events>({ methods: ['publish'] }));

        // Trigger calls in order.
        void payments.adapter.charge(1, 100);
        queueMicrotask(() => {
            void events.adapter.publish('orders', { id: 1 });
        });

        const [chargeCall, publishCall] = await rig.expect.sequence(
            [payments.probe.on('charge'), events.probe.on('publish')],
            { within: seconds(1) },
        );

        expect(chargeCall.args).toEqual([1, 100]);
        chargeCall.answer({ ok: true, txn: 'TXN-1' });

        expect(publishCall.args[0]).toBe('orders');
        publishCall.answer(undefined);
    });

    it('fails when a later step matches before an earlier step is satisfied', async () => {
        const payments = rig.attach(createProbedMock<Payments>({ methods: ['charge'] }));
        const events = rig.attach(createProbedMock<Events>({ methods: ['publish'] }));

        // Trigger publish FIRST, before charge — wrong order.
        void events.adapter.publish('orders', { id: 1 });

        // The sequence expects charge BEFORE publish. The publish call arrives
        // first, which violates the order. The expectation should fail with a
        // diagnostic naming the unmet step.
        const seqPromise = rig.expect.sequence([payments.probe.on('charge'), events.probe.on('publish')], {
            within: milliseconds(200),
        });

        await expect(seqPromise).rejects.toThrow(/Sequence|Timed out|matched before/i);
    });
});

describe('rig.expect.allOf — any-order', () => {
    let rig: Rig;
    beforeEach(() => {
        rig = createRig();
    });
    afterEach(async () => {
        await rig.close();
    });

    it('resolves when each step has matched at least once, regardless of order', async () => {
        const payments = rig.attach(createProbedMock<Payments>({ methods: ['charge'] }));
        const events = rig.attach(createProbedMock<Events>({ methods: ['publish'] }));

        // Trigger publish first, then charge — any order is fine for allOf.
        void events.adapter.publish('orders', { id: 1 });
        queueMicrotask(() => {
            void payments.adapter.charge(1, 100);
        });

        const [chargeCall, publishCall] = await rig.expect.allOf(
            [payments.probe.on('charge'), events.probe.on('publish')],
            { within: seconds(1) },
        );

        expect(chargeCall.args).toEqual([1, 100]);
        expect(publishCall.args[0]).toBe('orders');

        chargeCall.answer({ ok: true });
        publishCall.answer(undefined);
    });

    it('mixes capture and observation steps with correctly inferred result types', async () => {
        const payments = rig.attach(createProbedMock<Payments>({ methods: ['charge'] }));
        const events = rig.attach(createProbedMock<Events>({ methods: ['publish'] }));

        // Pre-program publish with always().answer so observation works without capture.
        events.probe.on('publish').always().answer(undefined);

        void payments.adapter.charge(1, 100);
        queueMicrotask(() => {
            void events.adapter.publish('orders', { id: 1 });
        });

        const [chargeCall, publishCall] = await rig.expect.allOf(
            [payments.probe.on('charge'), observation(events.probe.on('publish'))],
            { within: seconds(1) },
        );

        // chargeCall is a pending (capture); publishCall is a call snapshot (observation).
        expect(chargeCall.args).toEqual([1, 100]);
        chargeCall.answer({ ok: true });

        expect(publishCall.args[0]).toBe('orders');
        // No settle for the observation — the always() rule already settled it.
    });
});
