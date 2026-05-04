/**
 * Phase 2 tests for harness lifecycle: reset (default + keepRules), close
 * cancels in-flight waiters, and the safety timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, milliseconds, seconds, type Harness } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';

interface Service {
    doThing(arg: number): Promise<string>;
}

describe('harness.reset() — default behavior', () => {
    let harness: Harness;

    beforeEach(() => {
        harness = createHarness();
    });

    afterEach(async () => {
        await harness.close();
    });

    it('clears probe state by default (rules + call history) on every attached probe', async () => {
        const { adapter, probe } = harness.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        probe.on('doThing').once().answer('first');
        await expect(adapter.doThing(1)).resolves.toBe('first');
        expect(probe.calls).toHaveLength(1);

        await harness.reset();

        expect(probe.calls).toHaveLength(0);

        // Previous one-shot was consumed; new calls park.
        void adapter.doThing(2);
        const pending = await probe.expect.intercept();
        expect(pending.args).toEqual([2]);
        pending.answer('post-reset');
    });

    it('keepRules: true preserves probe rules but still resets adapter data', async () => {
        const { adapter, probe } = harness.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        probe.on('doThing').always().answer('always');
        await expect(adapter.doThing(1)).resolves.toBe('always');

        await harness.reset({ keepRules: true });

        // The always() rule should still fire after a keepRules reset.
        await expect(adapter.doThing(2)).resolves.toBe('always');
    });
});

describe('harness.reset() — preserves harness-installed defaults', () => {
    // We don't have a backed adapter here; this is exercised in the redis
    // package tests (default forward survives reset). See
    // packages/redis/test/integration/cache.test.ts.
    it('placeholder — see redis backed-rules.test.ts for the full check', () => {
        expect(true).toBe(true);
    });
});

describe('harness.close() — cancels in-flight waiters', () => {
    it('rejects pending intercept waiters with "Harness closed with N unsettled waiter(s)."', async () => {
        const harness = createHarness();
        const { probe } = harness.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        const waiterPromise = probe.expect.intercept({ within: seconds(60) });

        // Close the harness while the waiter is still pending.
        await harness.close();

        await expect(waiterPromise).rejects.toThrow(/Harness closed with 1 unsettled waiter/);
    });

    it('rejects multiple in-flight waiters with the correct count', async () => {
        const harness = createHarness();
        const { probe } = harness.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        const w1 = probe.expect.intercept({ within: seconds(60) });
        const w2 = probe.expect.observe({ within: seconds(60) });
        const w3 = probe.expect.intercept({ within: seconds(60) });

        await harness.close();

        await expect(w1).rejects.toThrow(/3 unsettled waiter/);
        await expect(w2).rejects.toThrow(/3 unsettled waiter/);
        await expect(w3).rejects.toThrow(/3 unsettled waiter/);
    });

    it('attach after close throws "Harness is closed."', async () => {
        const harness = createHarness();
        await harness.close();

        expect(() => harness.attach(createProbedMock<Service>({ methods: ['doThing'] }))).toThrow(/Harness is closed/);
    });
});

describe('Harness safety timeout', () => {
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
        const harness = createHarness({ safetyTimeout: milliseconds(80) });
        const { probe } = harness.attach(createProbedMock<Service>({ methods: ['doThing'], harness }));

        // No within: the within would be the harness defaultTimeout (5s by default).
        // The safety (80ms) fires first.
        const promise = probe.expect.intercept();

        // Don't advance virtual time. The safety timer (real wall-clock) will fire.
        await expect(promise).rejects.toThrow(/safety timeout/i);

        await harness.close();
    });
});
