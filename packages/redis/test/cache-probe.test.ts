import { createProbedCache, CacheProbe, ProbedCache } from '../src';

describe('createProbedCache', () => {
    let cache: ProbedCache;
    let probe: CacheProbe;

    beforeEach(() => {
        cache = createProbedCache();
        probe = cache.probe;
    });

    describe('alwaysForward (default passthrough)', () => {
        it('forwards set/get through to ioredis-mock', async () => {
            const didSet = await cache.set({ key: 'greeting', val: 'hello' });
            expect(didSet).toBe(true);

            const val = await cache.get<string>('greeting');
            expect(val).toBe('hello');
        });

        it('forwards del through to ioredis-mock', async () => {
            await cache.set({ key: 'temp', val: 42 });
            await cache.del('temp');
            const val = await cache.get('temp');
            expect(val).toBeNull();
        });

        it('forwards setnx through to ioredis-mock', async () => {
            await cache.set({ key: 'lock', val: 'owner-a' });
            const result = await cache.setnx({ key: 'lock', val: 'owner-b' });
            expect(result).toBe('owner-a');
        });

        it('forwards getSet through to ioredis-mock', async () => {
            const apiCall = jest.fn(() => Promise.resolve({ items: [1, 2, 3] }));

            const first = await cache.getSet('catalog', apiCall);
            const second = await cache.getSet('catalog', apiCall);

            expect(first).toEqual({ items: [1, 2, 3] });
            expect(second).toEqual({ items: [1, 2, 3] });
            expect(apiCall).toHaveBeenCalledTimes(1);
        });

        it('records all calls for observation', async () => {
            await cache.set({ key: 'k', val: 'v' });
            await cache.get('k');

            expect(probe.calls).toHaveLength(2);
            expect(probe.calls[0].method).toBe('set');
            expect(probe.calls[1].method).toBe('get');
        });
    });

    describe('whenCalled().thenReject()', () => {
        it('rejects the next call with the given error', async () => {
            probe.whenCalled().thenReject(new Error('connection refused'));

            await expect(cache.get('any-key')).rejects.toThrow('connection refused');
        });

        it('only rejects one call, subsequent calls forward normally', async () => {
            probe.whenCalled().thenReject(new Error('transient'));

            await expect(cache.get('k')).rejects.toThrow('transient');

            await cache.set({ key: 'k', val: 'recovered' });
            const val = await cache.get<string>('k');
            expect(val).toBe('recovered');
        });
    });

    describe('alwaysReject()', () => {
        it('rejects all calls until reset to alwaysForward', async () => {
            probe.alwaysReject(new Error('redis down'));

            await expect(cache.get('a')).rejects.toThrow('redis down');
            await expect(cache.set({ key: 'b', val: 1 })).rejects.toThrow('redis down');

            probe.alwaysForward();

            const didSet = await cache.set({ key: 'c', val: 'ok' });
            expect(didSet).toBe(true);
        });
    });

    describe('expectNext() plumbing', () => {
        afterEach(() => {
            probe.alwaysForward();
        });

        it('captures the next call and allows explicit forward', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectNext();
            const getPromise = cache.get('some-key');

            const pending = await pendingPromise;
            expect(pending.method).toBe('get');
            expect(pending.settled).toBe(false);

            pending.forward();
            const result = await getPromise;
            expect(result).toBeNull();
        });

        it('captures the next call and allows explicit reject', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectNext();
            const getPromise = cache.get('some-key');

            const pending = await pendingPromise;
            pending.reject(new Error('injected failure'));

            await expect(getPromise).rejects.toThrow('injected failure');
        });

        it('throws if forward is called twice on the same call', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectNext();
            const getPromise = cache.get('k');

            const pending = await pendingPromise;
            pending.forward();
            await getPromise;

            expect(() => pending.forward()).toThrow('already settled');
        });
    });

    describe('expectMatching() plumbing', () => {
        afterEach(() => {
            probe.alwaysForward();
        });

        it('matches calls by method name', async () => {
            probe.clearBehavior();

            const pendingPromise = probe.expectMatching((c) => c.method === 'del');
            const delPromise = cache.del('target');

            const pending = await pendingPromise;
            expect(pending.method).toBe('del');

            pending.forward();
            await delPromise;
        });
    });

    describe('data flows through the probe correctly', () => {
        it('set then get returns the stored value', async () => {
            await cache.set({ key: 'user:42', val: { name: 'Alice', role: 'admin' } });

            const user = await cache.get<{ name: string; role: string }>('user:42');
            expect(user).toEqual({ name: 'Alice', role: 'admin' });
        });

        it('formatted keys work through the probe', async () => {
            await cache.set({ key: { format: 'session:%s', args: ['abc123'] }, val: { userId: 7 } });

            const session = await cache.get<{ userId: number }>('session:abc123');
            expect(session).toEqual({ userId: 7 });
        });
    });
});
