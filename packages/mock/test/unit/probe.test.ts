/**
 * Translated from v1 packages/core/test/probe.test.ts to v2 grammar.
 *
 * v1 vocabulary mapping (per docs/internal/migration-from-v1.md):
 *   createProbePair<T>()                    → createProbedMock<T>({ methods: [...] })
 *   { fake, probe }                         → { adapter, probe }
 *   probe.expectNext(ms?)                   → probe.expect.intercept({ within: milliseconds(...) })
 *   probe.expectMatching(p, ms?)            → probe.filter(p).expect.intercept({ within: milliseconds(...) })
 *   probe.expectNoMsgWithin(ms)             → probe.expect.none({ within: milliseconds(...) })
 *   probe.calls                             → probe.calls (no change)
 *   probe.pendingCount()                    → (no equivalent; dropped)
 *   probe.drainWith(handler)                → probe.drain(handler) (handler receives PendingCall)
 *   probe.drainAndRejectAll(error?)         → probe.drainAndReject(error)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, milliseconds, type Harness } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';

interface DemoService {
    getById(id: number): Promise<{ id: number }>;
    updateName(id: number, name: string): Promise<void>;
    delete(id: number): Promise<boolean>;
}

describe('createProbedMock — pending call handle', () => {
    it('expect.intercept returns a pending call with answer()', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        const promise = adapter.getById(42);
        const pending = await probe.expect.intercept();

        expect(pending.method).toBe('getById');
        expect(pending.args).toEqual([42]);
        expect(pending.settled).toBe(false);

        pending.answer({ id: 42 });

        expect(pending.settled).toBe(true);
        await expect(promise).resolves.toEqual({ id: 42 });
    });

    it("pending.reject() rejects the caller's promise", async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        const promise = adapter.updateName(12, 'neo');
        const pending = await probe.expect.intercept();
        pending.reject(new Error('failed'));

        expect(pending.settled).toBe(true);
        await expect(promise).rejects.toThrow('failed');
    });

    it('throws if answer() is called on an already-settled pending call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);
        const pending = await probe.expect.intercept();
        pending.answer({ id: 1 });

        expect(() => pending.answer({ id: 2 })).toThrow(/already settled/);
    });

    it('throws if reject() is called on an already-settled pending call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);
        const pending = await probe.expect.intercept();
        pending.answer({ id: 1 });

        expect(() => pending.reject(new Error('x'))).toThrow(/already settled/);
    });
});

describe('createProbedMock — expect.intercept (capturing)', () => {
    it('times out when no call arrives', async () => {
        const { probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        await expect(probe.expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
    });

    it('captures already-arrived calls retroactively', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);
        void adapter.getById(2);

        const c1 = await probe.expect.intercept();
        const c2 = await probe.expect.intercept();

        expect(c1.method).toBe('getById');
        expect(c1.args).toEqual([1]);
        expect(c2.args).toEqual([2]);
    });
});

describe('createProbedMock — filter() narrowing', () => {
    it('returns first call matching predicate, skipping non-matches', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);
        void adapter.updateName(2, 'alice');
        void adapter.getById(3);

        const pending = await probe.filter((c) => c.method === 'updateName').expect.intercept();

        expect(pending.method).toBe('updateName');
        expect(pending.args).toEqual([2, 'alice']);
    });

    it('skipped calls remain available for later consumption', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);
        void adapter.updateName(2, 'bob');
        void adapter.getById(3);

        await probe.filter((c) => c.method === 'updateName').expect.intercept();

        const c1 = await probe.expect.intercept();
        expect(c1.method).toBe('getById');
        expect(c1.args).toEqual([1]);

        const c2 = await probe.expect.intercept();
        expect(c2.method).toBe('getById');
        expect(c2.args).toEqual([3]);
    });

    it('blocks until a matching call arrives', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        const matchPromise = probe.on('delete').expect.intercept();

        void adapter.getById(1);
        void adapter.delete(99);

        const pending = await matchPromise;
        expect(pending.method).toBe('delete');
        expect(pending.args).toEqual([99]);
    });

    it('times out if no matching call arrives', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);

        await expect(probe.on('delete').expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
    });
});

describe('createProbedMock — expect.none', () => {
    let harness: Harness;

    beforeEach(() => {
        harness = createHarness();
    });

    afterEach(async () => {
        await harness.close();
    });

    it('succeeds if no matching calls were made', async () => {
        const { probe } = harness.attach(
            createProbedMock<DemoService>({ methods: ['getById', 'updateName', 'delete'] }),
        );

        await expect(probe.expect.none({ within: milliseconds(0) })).resolves.toBeUndefined();
    });

    it('fails if a call arrived before the assertion', async () => {
        const { adapter, probe } = harness.attach(
            createProbedMock<DemoService>({ methods: ['getById', 'updateName', 'delete'] }),
        );

        void adapter.getById(7);

        await expect(probe.expect.none({ within: milliseconds(0) })).rejects.toThrow(/Expected no calls/);
    });

    it('fails if a call arrives during the window', async () => {
        const { adapter, probe } = harness.attach(
            createProbedMock<DemoService>({ methods: ['getById', 'updateName', 'delete'] }),
        );

        setTimeout(() => {
            void adapter.getById(7);
        }, 30);

        await expect(probe.expect.none({ within: milliseconds(100) })).rejects.toThrow(/Expected no calls/);
    });
});

describe('createProbedMock — calls history', () => {
    it('records all calls regardless of consumption', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);
        void adapter.updateName(2, 'x');

        expect(probe.calls).toHaveLength(2);
        expect(probe.calls[0]).toEqual({ method: 'getById', args: [1] });
        expect(probe.calls[1]).toEqual({ method: 'updateName', args: [2, 'x'] });

        await probe.expect.intercept();
        expect(probe.calls).toHaveLength(2);
    });
});

describe('createProbedMock — drain semantics', () => {
    it('drain() marks all matching pending calls as routed without settling', () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        void adapter.getById(1);
        void adapter.getById(2);
        expect(probe.calls).toHaveLength(2);

        const drained: number[] = [];
        probe.drain((pending) => {
            drained.push(pending.args[0] as number);
        });
        expect(drained).toEqual([1, 2]);
    });

    it('drainAndReject rejects unsettled calls with the given error', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        const p1 = adapter.getById(1);
        const p2 = adapter.getById(2);

        probe.drainAndReject(new Error('shutting down'));

        await expect(p1).rejects.toThrow('shutting down');
        await expect(p2).rejects.toThrow('shutting down');
    });

    it('drainAndReject skips calls already settled by a rule', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        probe.on('getById').once().answer({ id: 1 });
        const p1 = adapter.getById(1);
        const p2 = adapter.getById(2);

        await expect(p1).resolves.toEqual({ id: 1 });

        probe.drainAndReject(new Error('drained'));
        await expect(p2).rejects.toThrow('drained');
    });

    it('drain handler can settle each pending call', async () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });

        const p1 = adapter.getById(1);
        const p2 = adapter.getById(2);

        const collected: string[] = [];
        probe.drain((pending) => {
            collected.push(pending.method);
            pending.answer({ id: 0 });
        });

        expect(collected).toEqual(['getById', 'getById']);
        await expect(p1).resolves.toEqual({ id: 0 });
        await expect(p2).resolves.toEqual({ id: 0 });
    });
});

describe('createProbedMock — Proxy trap (framework compatibility)', () => {
    it('adapter is not thenable (await adapter does not hang)', async () => {
        const { adapter } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });
        const result = await Promise.resolve(adapter);
        expect(result).toBe(adapter);
    });

    it('JSON.stringify does not trigger probe calls', () => {
        const { adapter, probe } = createProbedMock<DemoService>({
            methods: ['getById', 'updateName', 'delete'],
        });
        expect(() => JSON.stringify({ service: adapter })).not.toThrow();
        expect(probe.calls).toHaveLength(0);
    });

    it('NestJS lifecycle hooks are passthrough (return undefined)', () => {
        interface NestService {
            send(cmd: unknown): Promise<unknown>;
        }
        const { adapter, probe } = createProbedMock<NestService>({ methods: ['send'] });
        const a = adapter as unknown as Record<string, unknown>;

        expect(a.onModuleInit).toBeUndefined();
        expect(a.onApplicationBootstrap).toBeUndefined();
        expect(a.onModuleDestroy).toBeUndefined();
        expect(a.beforeApplicationShutdown).toBeUndefined();
        expect(a.onApplicationShutdown).toBeUndefined();

        expect(typeof adapter.send).toBe('function');
        void adapter.send({ foo: 'bar' });
        expect(probe.calls).toHaveLength(1);
        expect(probe.calls[0]).toEqual({ method: 'send', args: [{ foo: 'bar' }] });
    });
});
