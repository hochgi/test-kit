/**
 * Phase 2 tests for the retroactive intercept eligibility table (G4).
 *
 * Per docs/api-surface.md §"intercept" — Eligibility table:
 *
 *   | Prior state of the matching call               | Retroactive? |
 *   | ----------------------------------------------- | ------------ |
 *   | Parked because no rule matched                  | yes          |
 *   | Caught by `once().park()` or `always().park()`  | no           |
 *   | Settled by `forward()`/`answer*()`/`reject()`   | no           |
 *
 * Each test below covers one row of the table. The model is: a call is
 * retroactively interceptable iff `routed === false`. The park rule sets
 * `routed = true` (and `ruleParked = true`) without settling, so it is
 * NOT retroactively interceptable.
 */
import { describe, expect, it } from 'vitest';
import { milliseconds } from '@hochgi/test-kit';
import { createProbedMock } from '@hochgi/test-kit-mock';

interface Service {
    doThing(arg: number): Promise<string>;
}

describe('Retroactive intercept eligibility', () => {
    describe('Row 1: parked-because-no-rule-matched → eligible', () => {
        it('intercept registered after the call captures it', async () => {
            const { adapter, probe } = createProbedMock<Service>({ methods: ['doThing'] });

            // No rule installed. The call lands and parks.
            const callPromise = adapter.doThing(7);

            // Wait a tick so the call is recorded.
            await new Promise((r) => setImmediate(r));

            // Late intercept retroactively captures it.
            const pending = await probe.expect.intercept();
            expect(pending.args).toEqual([7]);

            pending.answer('captured');
            await expect(callPromise).resolves.toBe('captured');
        });
    });

    describe('Row 2a: caught by once().park() → ineligible', () => {
        it('intercept registered after the call does NOT capture it', async () => {
            const { adapter, probe } = createProbedMock<Service>({ methods: ['doThing'] });

            probe.once().park();

            // The once().park() rule fires and routes the call (routed=true,
            // ruleParked=true, settled=false). The application's promise hangs.
            void adapter.doThing(7);

            await new Promise((r) => setImmediate(r));

            // Late intercept should NOT capture; it should time out.
            await expect(probe.expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
        });
    });

    describe('Row 2b: caught by always().park() → ineligible', () => {
        it('intercept registered after the call does NOT capture it', async () => {
            const { adapter, probe } = createProbedMock<Service>({ methods: ['doThing'] });

            probe.always().park();

            void adapter.doThing(7);

            await new Promise((r) => setImmediate(r));

            await expect(probe.expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
        });
    });

    describe('Row 3: settled by answer/reject (rule fired) → ineligible', () => {
        it('intercept registered after the call does NOT capture an answered call', async () => {
            const { adapter, probe } = createProbedMock<Service>({ methods: ['doThing'] });

            probe.once().answer('settled');

            const result = await adapter.doThing(7);
            expect(result).toBe('settled');

            // The call is now routed AND settled. Late intercept can't capture it.
            await expect(probe.expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
        });

        it('intercept registered after the call does NOT capture a rejected call', async () => {
            const { adapter, probe } = createProbedMock<Service>({ methods: ['doThing'] });

            probe.once().reject(new Error('settled-reject'));

            await expect(adapter.doThing(7)).rejects.toThrow('settled-reject');

            await expect(probe.expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
        });
    });

    describe('Pre-register pattern (canonical) — intercept beats park', () => {
        it('intercept registered BEFORE the call captures it (tier 1b > tier 3)', async () => {
            const { adapter, probe } = createProbedMock<Service>({ methods: ['doThing'] });

            probe.always().park();

            // Pre-register the intercept. It beats the always().park() at tier 1b.
            const pendingPromise = probe.expect.intercept();
            const callPromise = adapter.doThing(42);

            const pending = await pendingPromise;
            expect(pending.args).toEqual([42]);
            pending.answer('captured-before-park');

            await expect(callPromise).resolves.toBe('captured-before-park');
        });
    });
});
