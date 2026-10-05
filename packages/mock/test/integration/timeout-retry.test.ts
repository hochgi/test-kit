/**
 * Translated from v1 packages/core/test/integration.test.ts to v2 grammar.
 *
 * Demonstrates intercept + reject/answer + rig.clock.advance for testing
 * timeout and retry semantics. Uses Vitest fake timers via the rig.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRig, seconds, type Rig } from '@hochgi/test-kit';
import { createProbedMock } from '@hochgi/test-kit-mock';

interface Dep {
    request(input: { siteId: number }): Promise<{ ok: boolean }>;
}

function callWithTimeout(dep: Dep, timeoutMs: number): Promise<{ ok: boolean }> {
    // Single Promise (not Promise.race) so the timer's rejection is owned by
    // exactly one subscriber and won't surface as an unhandled rejection if
    // the SUT call never settles (intercepted-and-not-answered).
    return new Promise<{ ok: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('call has been timed out')), timeoutMs);
        dep.request({ siteId: 1 }).then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e: unknown) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            },
        );
    });
}

async function callWithRetry(dep: Dep, retryDelayMs: number): Promise<{ ok: boolean }> {
    try {
        return await dep.request({ siteId: 1 });
    } catch {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        return dep.request({ siteId: 1 });
    }
}

describe('integration: probes + rig fake clock', () => {
    let rig: Rig;

    beforeEach(() => {
        vi.useFakeTimers();
        rig = createRig();
    });

    afterEach(async () => {
        await rig.close();
        vi.useRealTimers();
    });

    it('times out when downstream call is not answered', async () => {
        const { adapter, probe } = rig.attach(createProbedMock<Dep>({ methods: ['request'] }));

        const resultPromise = callWithTimeout(adapter, 30_000);
        // Attach the assertion's .catch eagerly. The timer fires synchronously
        // inside `rig.clock.advance` below, and without an already-attached
        // handler vitest's microtask cycle reports the rejection as unhandled
        // before our `await` here installs one.
        const expectTimeout = expect(resultPromise).rejects.toThrow('call has been timed out');

        const pending = await probe.expect.intercept();
        expect(pending.method).toBe('request');
        expect(pending.args).toEqual([{ siteId: 1 }]);

        await rig.clock.advance(seconds(30));
        await expectTimeout;
    });

    it('retries after first failure and succeeds on the second response', async () => {
        const { adapter, probe } = rig.attach(createProbedMock<Dep>({ methods: ['request'] }));

        const resultPromise = callWithRetry(adapter, 2_000);

        const first = await probe.expect.intercept();
        first.reject(new Error('temporary failure'));
        await Promise.resolve();

        await rig.clock.advance(seconds(2));

        const second = await probe.expect.intercept();
        second.answer({ ok: true });

        await expect(resultPromise).resolves.toEqual({ ok: true });
    });

    it('multiple concurrent calls answered out of order', async () => {
        const { adapter, probe } = rig.attach(createProbedMock<Dep>({ methods: ['request'] }));

        const p1 = adapter.request({ siteId: 1 });
        const p2 = adapter.request({ siteId: 2 });

        const call2 = await probe.filter((c) => (c.args[0] as { siteId: number }).siteId === 2).expect.intercept();
        const call1 = await probe.filter((c) => (c.args[0] as { siteId: number }).siteId === 1).expect.intercept();

        call2.answer({ ok: true });
        call1.answer({ ok: false });

        await expect(p1).resolves.toEqual({ ok: false });
        await expect(p2).resolves.toEqual({ ok: true });
    });

    // The "expect.none rejects when a call arrives during the window"
    // scenario is exercised in packages/mock/test/unit/probe.test.ts (without
    // fake timers, so a real-time setTimeout can actually fire) and in
    // packages/core/test/integration/expect-none.test.ts (which explicitly
    // verifies expect.none does NOT advance virtual time under fake timers).
});
