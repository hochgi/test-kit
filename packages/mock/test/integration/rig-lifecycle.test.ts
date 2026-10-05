/**
 * Phase 2 tests for rig lifecycle: reset (default + keepRules), close
 * cancels in-flight waiters, and the safety timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRig, milliseconds, seconds, type ProbedAdapterWithLifecycle, type Rig } from '@hochgi/test-kit';
import { createProbedMock } from '@hochgi/test-kit-mock';

interface Service {
    doThing(arg: number): Promise<string>;
}

/**
 * A minimally-typed attachable resource that records the order in which the
 * rig closed it. Used for the reverse-registration-order scenario.
 */
function recordingResource(label: string, closed: string[]): ProbedAdapterWithLifecycle<object, object> {
    return {
        adapter: {},
        probe: {},
        async reset() {},
        async close() {
            closed.push(label);
        },
    };
}

describe('rig.reset() — default behavior', () => {
    let rig: Rig;

    beforeEach(() => {
        rig = createRig();
    });

    afterEach(async () => {
        await rig.close();
    });

    it('clears probe state by default (rules + call history) on every attached probe', async () => {
        const { adapter, probe } = rig.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        probe.on('doThing').once().answer('first');
        await expect(adapter.doThing(1)).resolves.toBe('first');
        expect(probe.calls).toHaveLength(1);

        await rig.reset();

        expect(probe.calls).toHaveLength(0);

        // Previous one-shot was consumed; new calls park.
        void adapter.doThing(2);
        const pending = await probe.expect.intercept();
        expect(pending.args).toEqual([2]);
        pending.answer('post-reset');
    });

    it('keepRules: true preserves probe rules but still resets adapter data', async () => {
        const { adapter, probe } = rig.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        probe.on('doThing').always().answer('always');
        await expect(adapter.doThing(1)).resolves.toBe('always');

        await rig.reset({ keepRules: true });

        // The always() rule should still fire after a keepRules reset.
        await expect(adapter.doThing(2)).resolves.toBe('always');
    });
});

describe('rig.reset() — preserves rig-installed defaults', () => {
    // We don't have a backed adapter here; this is exercised in the redis
    // package tests (default forward survives reset). See
    // packages/redis/test/integration/cache.test.ts.
    it('placeholder — see redis backed-rules.test.ts for the full check', () => {
        expect(true).toBe(true);
    });
});

describe('rig.close() — cancels in-flight waiters', () => {
    it('rejects pending intercept waiters with "Harness closed with N unsettled waiter(s)."', async () => {
        const rig = createRig();
        const { probe } = rig.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        const waiterPromise = probe.expect.intercept({ within: seconds(60) });

        // Close the rig while the waiter is still pending.
        await rig.close();

        await expect(waiterPromise).rejects.toThrow(/Harness closed with 1 unsettled waiter/);
    });

    it('rejects multiple in-flight waiters with the correct count', async () => {
        const rig = createRig();
        const { probe } = rig.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        const w1 = probe.expect.intercept({ within: seconds(60) });
        const w2 = probe.expect.observe({ within: seconds(60) });
        const w3 = probe.expect.intercept({ within: seconds(60) });

        await rig.close();

        await expect(w1).rejects.toThrow(/3 unsettled waiter/);
        await expect(w2).rejects.toThrow(/3 unsettled waiter/);
        await expect(w3).rejects.toThrow(/3 unsettled waiter/);
    });

    it('attach after close throws "Harness is closed."', async () => {
        const rig = createRig();
        await rig.close();

        expect(() => rig.attach(createProbedMock<Service>({ methods: ['doThing'] }))).toThrow(/Harness is closed/);
    });
});

// Delta P02+P03 → "Scenario: behaviour is unchanged by the rename"
// (acceptance item 3). The reset/keepRules and closed-rig halves live in the
// describes above and below; these cover attach and close ordering.
describe('rig.attach() / rig.close() — behaviour is unchanged by the rename', () => {
    it('attach returns the adapter it was given', () => {
        const rig = createRig();
        try {
            const probed = createProbedMock<Service>({ methods: ['doThing'], harness: rig });
            expect(rig.attach(probed)).toBe(probed);
        } finally {
            void rig.close();
        }
    });

    it('attach returns a promise for a promised adapter', async () => {
        const rig = createRig();
        try {
            const probed = createProbedMock<Service>({ methods: ['doThing'], harness: rig });
            const attached = rig.attach(Promise.resolve(probed));
            expect(attached).toBeInstanceOf(Promise);
            await expect(attached).resolves.toBe(probed);
        } finally {
            await rig.close();
        }
    });

    it('close runs attached adapters in reverse registration order', async () => {
        const rig = createRig();
        const closed: string[] = [];
        rig.attach(recordingResource('first', closed));
        rig.attach(recordingResource('second', closed));
        rig.attach(recordingResource('third', closed));

        await rig.close();

        expect(closed).toEqual(['third', 'second', 'first']);
    });

    it('reset on a closed rig rejects', async () => {
        const rig = createRig();
        await rig.close();

        await expect(rig.reset()).rejects.toThrow(/Harness is closed/);
    });
});

describe('Rig safety timeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('safety timeout fires when a fake clock is not advanced', async () => {
        // The safety timer is a real wall-clock timer, NOT subject to vitest fake
        // timers. So even with vi.useFakeTimers() active, the safety timer still
        // fires after its real-wall-clock duration. We use a short safety window
        // so the test is fast.
        const rig = createRig({ safetyTimeout: milliseconds(80) });
        const { probe } = rig.attach(createProbedMock<Service>({ methods: ['doThing'], harness: rig }));

        // No within: the within would be the rig defaultTimeout (5s by default).
        // The safety (80ms) fires first.
        const promise = probe.expect.intercept();

        // Don't advance virtual time. The safety timer (real wall-clock) will fire.
        await expect(promise).rejects.toThrow(/safety timeout/i);

        await rig.close();
    });
});
