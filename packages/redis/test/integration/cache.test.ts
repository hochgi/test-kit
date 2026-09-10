/**
 * Translated from v1 packages/redis/test/cache.test.ts and
 * v1 packages/redis/test/cache-probe.test.ts to v2 grammar.
 *
 * Exercises createProbedCacheAdapter against ioredis-mock: default forward,
 * once+reject, always+reject, expect.intercept with forward/reject,
 * cache.on(method) typed sugar, formatted keys, getSet caching behavior.
 *
 * v1 mapping:
 *   createInMemoryCache()             → rig.attach(createProbedCacheAdapter({ harness: rig }))
 *                                       (default forward; behaves as in-memory cache)
 *   createProbedCache()               → same factory
 *   probe.alwaysForward()             → (default; no call needed)
 *   probe.alwaysReject(error)         → probe.always().reject(error)
 *   probe.whenCalled().thenReject(e)  → probe.once().reject(e)
 *   probe.expectNext(ms?)             → probe.expect.intercept({ within })
 *   probe.expectMatching(p, ms?)      → probe.filter(p).expect.intercept({ within })
 *                                       or probe.on(method).expect.intercept(...)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRig, type Rig } from '@vnatures/test-kit';
import { createProbedCacheAdapter, type ProbedCacheAdapter } from '@vnatures/test-kit-redis';

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('createProbedCacheAdapter', () => {
    let rig: Rig;
    let cache: ProbedCacheAdapter;

    beforeEach(() => {
        rig = createRig();
        cache = rig.attach(createProbedCacheAdapter({ harness: rig }));
    });

    afterEach(async () => {
        await rig.close();
    });

    describe('default forward rule (in-memory ioredis-mock)', () => {
        it('forwards set/get through to ioredis-mock', async () => {
            const didSet = await cache.adapter.set({ key: 'greeting', val: 'hello' });
            expect(didSet).toBe(true);

            const val = await cache.adapter.get<string>('greeting');
            expect(val).toBe('hello');
        });

        it('forwards del through to ioredis-mock', async () => {
            await cache.adapter.set({ key: 'temp', val: 42 });
            await cache.adapter.del('temp');
            const val = await cache.adapter.get('temp');
            expect(val).toBeNull();
        });

        it('setnx stores only when missing; returns existing value otherwise', async () => {
            await cache.adapter.set({ key: 'lock', val: 'owner-a' });
            const result = await cache.adapter.setnx(
                { key: 'lock', val: 'owner-b' },
                { ttl: { milliseconds: 60000 } as never },
            );
            expect(result).toBe('owner-a');
        });

        it('getSet caches result and reuses it on second call', async () => {
            const apiCall = vi.fn(() => Promise.resolve({ items: [1, 2, 3] }));

            const first = await cache.adapter.getSet('catalog', apiCall);
            const second = await cache.adapter.getSet('catalog', apiCall);

            expect(first).toEqual({ items: [1, 2, 3] });
            expect(second).toEqual({ items: [1, 2, 3] });
            expect(apiCall).toHaveBeenCalledTimes(1);
        });

        it('records every call in probe.calls', async () => {
            await cache.adapter.set({ key: 'k', val: 'v' });
            await cache.adapter.get('k');

            expect(cache.probe.calls).toHaveLength(2);
            expect(cache.probe.calls[0].method).toBe('set');
            expect(cache.probe.calls[1].method).toBe('get');
        });
    });

    describe('once().reject', () => {
        it('rejects the next call with the given error', async () => {
            cache.probe.once().reject(new Error('connection refused'));

            await expect(cache.adapter.get('any-key')).rejects.toThrow('connection refused');
        });

        it('only rejects one call; subsequent calls forward normally', async () => {
            cache.probe.once().reject(new Error('transient'));

            await expect(cache.adapter.get('k')).rejects.toThrow('transient');

            await cache.adapter.set({ key: 'k', val: 'recovered' });
            const val = await cache.adapter.get<string>('k');
            expect(val).toBe('recovered');
        });
    });

    describe('always().reject', () => {
        it('rejects all calls until clearRules', async () => {
            cache.probe.always().reject(new Error('redis down'));

            await expect(cache.adapter.get('a')).rejects.toThrow('redis down');
            await expect(cache.adapter.set({ key: 'b', val: 1 })).rejects.toThrow('redis down');

            cache.probe.clearRules();

            const didSet = await cache.adapter.set({ key: 'c', val: 'ok' });
            expect(didSet).toBe(true);
        });
    });

    describe('expect.intercept (capturing)', () => {
        it('captures the next call and allows explicit forward', async () => {
            cache.probe.always().park();

            const pendingPromise = cache.probe.expect.intercept();
            const getPromise = cache.adapter.get('some-key');

            const pending = await pendingPromise;
            expect(pending.method).toBe('get');
            expect(pending.settled).toBe(false);

            pending.forward();
            const result = await getPromise;
            expect(result).toBeNull();
        });

        it('captures the next call and allows explicit reject', async () => {
            cache.probe.always().park();

            const pendingPromise = cache.probe.expect.intercept();
            const getPromise = cache.adapter.get('some-key');

            const pending = await pendingPromise;
            pending.reject(new Error('injected failure'));

            await expect(getPromise).rejects.toThrow('injected failure');
        });

        it('throws if forward is called twice on the same pending', async () => {
            cache.probe.always().park();

            const pendingPromise = cache.probe.expect.intercept();
            const getPromise = cache.adapter.get('k');

            const pending = await pendingPromise;
            pending.forward();
            await getPromise;

            expect(() => pending.forward()).toThrow(/already settled/);
        });
    });

    describe('cache.probe.on(method) typed sugar', () => {
        it('matches calls by method name', async () => {
            cache.probe.always().park();

            const pendingPromise = cache.probe.on('del').expect.intercept();
            const delPromise = cache.adapter.del('target');

            const pending = await pendingPromise;
            expect(pending.method).toBe('del');

            pending.forward();
            await delPromise;
        });
    });

    describe('formatted keys', () => {
        it('format/args keys are interpolated and stored', async () => {
            await cache.adapter.set({
                key: { format: 'session:%s', args: ['abc123'] },
                val: { userId: 7 },
            });

            const session = await cache.adapter.get<{ userId: number }>('session:abc123');
            expect(session).toEqual({ userId: 7 });
        });

        it('format/args keys with multiple args', async () => {
            await cache.adapter.set({
                key: { format: 'site:%s:user:%s', args: ['123', '7'] },
                val: 'ok',
            });
            await expect(cache.adapter.get<string>('site:123:user:7')).resolves.toBe('ok');
        });
    });

    describe('object values', () => {
        it('round-trips structured values through the cache', async () => {
            await cache.adapter.set({
                key: 'user:42',
                val: { name: 'Alice', role: 'admin' },
            });

            const user = await cache.adapter.get<{ name: string; role: string }>('user:42');
            expect(user).toEqual({ name: 'Alice', role: 'admin' });
        });
    });
});
