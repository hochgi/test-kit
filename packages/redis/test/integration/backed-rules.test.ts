/**
 * Phase 2 tests exercised through a backed (cache) adapter:
 *   - LIFO permanent overriding rig-installed default forward.
 *   - always().park() shadowing default forward.
 *   - clearRules() preserves rig-installed defaults.
 *   - clearRules({ includeDefaults: true }) removes them too.
 *
 * Per docs/concepts.md §"Default Rules" and §"Rule Resolution".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { milliseconds, createRig, type Rig } from '@hochgi/test-kit';
import { createProbedCacheAdapter, type ProbedCacheAdapter } from '@hochgi/test-kit-redis';

describe('Backed adapter — default forward + LIFO permanent overrides', () => {
    let rig: Rig;
    let cache: ProbedCacheAdapter;

    beforeEach(() => {
        rig = createRig();
        cache = rig.attach(createProbedCacheAdapter({ harness: rig }));
    });

    afterEach(async () => {
        await rig.close();
    });

    it('user-installed always().reject overrides rig-installed default forward (LIFO)', async () => {
        // Default forward is at the bottom of the tier-3 stack.
        // Adding a user permanent reject puts a newer entry on top → wins.
        cache.probe.always().reject(new Error('user override'));

        await expect(cache.adapter.get('k')).rejects.toThrow('user override');
    });

    it('always().park() shadows default forward — calls park, no settlement', async () => {
        cache.probe.always().park();

        let settled = false;
        void cache.adapter.get('parked').then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        // Wait briefly; the call should not settle because of always().park().
        await new Promise((r) => setTimeout(r, 30));
        expect(settled).toBe(false);

        // Drain to clean up the parked call before the rig closes.
        cache.probe.drainAndReject(new Error('cleanup'));
    });

    it('clearRules() preserves the rig-installed default forward', async () => {
        cache.probe.always().reject(new Error('user override'));
        await expect(cache.adapter.get('k')).rejects.toThrow('user override');

        cache.probe.clearRules();

        // After clearRules, the user rule is gone but the rig default forward
        // remains. A get() should now return null (forwarded to ioredis-mock).
        const val = await cache.adapter.get('k');
        expect(val).toBeNull();
    });

    it('clearRules({ includeDefaults: true }) removes default forward too — calls park', async () => {
        cache.probe.clearRules({ includeDefaults: true });

        let settled = false;
        void cache.adapter.get('parked').then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await new Promise((r) => setTimeout(r, 30));
        expect(settled).toBe(false);

        // Late intercept retroactively captures (no rule fired → routed=false).
        const pending = await cache.probe.expect.intercept({ within: milliseconds(100) });
        pending.answer(null as never);
    });
});

describe('rig.reset() — preserves rig-installed defaults', () => {
    let rig: Rig;
    let cache: ProbedCacheAdapter;

    beforeEach(() => {
        rig = createRig();
        cache = rig.attach(createProbedCacheAdapter({ harness: rig }));
    });

    afterEach(async () => {
        await rig.close();
    });

    it('after rig.reset(), default forward is still in place; user rules are gone', async () => {
        cache.probe.always().reject(new Error('user override'));
        await expect(cache.adapter.get('k')).rejects.toThrow('user override');

        await rig.reset();

        // User rule cleared; default forward survives.
        const val = await cache.adapter.get('k');
        expect(val).toBeNull();
    });
});
