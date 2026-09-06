/**
 * Phase 2 tests for expect.none semantics.
 *
 * Per docs/concepts.md §"expect.none Does Not Advance Virtual Time":
 *   expect.none({ within }) waits real wall-clock time and does NOT
 *   advance virtual time as a side effect. An SUT-internal setTimeout
 *   scheduled with fake timers will NOT fire because of expect.none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, milliseconds, type Harness } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';

interface Service {
    doThing(arg: number): Promise<void>;
}

describe('expect.none does not advance virtual time', () => {
    let harness: Harness;

    beforeEach(() => {
        vi.useFakeTimers();
        harness = createHarness();
    });

    afterEach(async () => {
        await harness.close();
        vi.useRealTimers();
    });

    it('an SUT-internal setTimeout scheduled with fake timers does NOT fire as a side effect', async () => {
        const { adapter, probe } = harness.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        let sideEffectFired = false;
        setTimeout(() => {
            sideEffectFired = true;
            void adapter.doThing(7);
        }, 50);

        // expect.none waits real wall-clock 100ms. Virtual time does not advance,
        // so the SUT's setTimeout(50ms, fake) does NOT fire during this assertion.
        await expect(probe.expect.none({ within: milliseconds(100) })).resolves.toBeUndefined();

        expect(sideEffectFired).toBe(false);
    });

    it('after harness.clock.advance, expect.none({ within: ms(0) }) sees the side effect', async () => {
        const { adapter, probe } = harness.attach(createProbedMock<Service>({ methods: ['doThing'] }));

        setTimeout(() => {
            void adapter.doThing(7);
        }, 50);

        // Now we explicitly advance virtual time. The setTimeout fires.
        await harness.clock.advance(milliseconds(100));

        // expect.none({ within: ms(0) }) should now FAIL because the call arrived.
        await expect(probe.expect.none({ within: milliseconds(0) })).rejects.toThrow(/Expected no calls/);
    });
});
