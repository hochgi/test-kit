import { createProbePair, extractFakes, extractProbes, PendingCall } from '../src';

type DemoService = {
    getById(id: number): Promise<{ id: number }>;
    updateName(id: number, name: string): Promise<void>;
    delete(id: number): Promise<boolean>;
};

describe('createProbePair / TestProbe', () => {
    describe('PendingCall handle', () => {
        it('expectNext returns a PendingCall with answer()', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            const promise = fake.getById(42);
            const call = await probe.expectNext();

            expect(call.method).toBe('getById');
            expect(call.args).toEqual([42]);
            expect(call.settled).toBe(false);

            call.answer({ id: 42 });

            expect(call.settled).toBe(true);
            await expect(promise).resolves.toEqual({ id: 42 });
        });

        it("PendingCall.reject() rejects the caller's promise", async () => {
            const { fake, probe } = createProbePair<DemoService>();

            const promise = fake.updateName(12, 'neo');
            const call = await probe.expectNext();
            call.reject(new Error('failed'));

            expect(call.settled).toBe(true);
            await expect(promise).rejects.toThrow('failed');
        });

        it('throws if answer() called twice on same handle', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            const call = await probe.expectNext();
            call.answer({ id: 1 });

            expect(() => call.answer({ id: 2 })).toThrow('already settled');
        });

        it('throws if reject() called on settled handle', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            const call = await probe.expectNext();
            call.answer({ id: 1 });

            expect(() => call.reject(new Error('x'))).toThrow('already settled');
        });
    });

    describe('expectNext', () => {
        it('times out when no call arrives (uses real setTimeout)', async () => {
            const { probe } = createProbePair<DemoService>();
            await expect(probe.expectNext(50)).rejects.toThrow('Timed out');
        });

        it('resolves immediately if call is already in queue', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            void fake.getById(2);

            const c1 = await probe.expectNext();
            const c2 = await probe.expectNext();

            expect(c1.method).toBe('getById');
            expect(c1.args).toEqual([1]);
            expect(c2.args).toEqual([2]);
        });
    });

    describe('expectMatching', () => {
        it('returns first call matching predicate, skipping non-matches', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            void fake.updateName(2, 'alice');
            void fake.getById(3);

            const call = await probe.expectMatching((c) => c.method === 'updateName');
            expect(call.method).toBe('updateName');
            expect(call.args).toEqual([2, 'alice']);
        });

        it('skipped calls remain available for later consumption', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            void fake.updateName(2, 'bob');
            void fake.getById(3);

            await probe.expectMatching((c) => c.method === 'updateName');

            const c1 = await probe.expectNext();
            expect(c1.method).toBe('getById');
            expect(c1.args).toEqual([1]);

            const c2 = await probe.expectNext();
            expect(c2.method).toBe('getById');
            expect(c2.args).toEqual([3]);
        });

        it('blocks until a matching call arrives', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            const matchPromise = probe.expectMatching((c) => c.method === 'delete');

            void fake.getById(1);
            void fake.delete(99);

            const call = await matchPromise;
            expect(call.method).toBe('delete');
            expect(call.args).toEqual([99]);
        });

        it('times out if no matching call arrives', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);

            await expect(probe.expectMatching((c) => c.method === 'delete', 50)).rejects.toThrow('Timed out');
        });
    });

    describe('expectNoMsgWithin', () => {
        it('succeeds if no calls were made', async () => {
            jest.useFakeTimers();
            const { probe } = createProbePair<DemoService>();
            await expect(probe.expectNoMsgWithin(1000)).resolves.toBeUndefined();
            jest.useRealTimers();
        });

        it('fails if a call arrives in the window', async () => {
            jest.useFakeTimers();
            const { fake, probe } = createProbePair<DemoService>();

            setTimeout(() => {
                void fake.getById(7);
            }, 300);

            await expect(probe.expectNoMsgWithin(1000)).rejects.toThrow('Expected no message');
            jest.useRealTimers();
        });
    });

    describe('calls history', () => {
        it('records all calls regardless of consumption', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            void fake.updateName(2, 'x');

            expect(probe.calls).toHaveLength(2);
            expect(probe.calls[0]).toEqual({ method: 'getById', args: [1] });
            expect(probe.calls[1]).toEqual({ method: 'updateName', args: [2, 'x'] });

            await probe.expectNext();
            expect(probe.calls).toHaveLength(2);
        });
    });

    describe('drain', () => {
        it('drain() marks all calls consumed', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            void fake.getById(2);
            expect(probe.pendingCount()).toBe(2);

            probe.drain();
            expect(probe.pendingCount()).toBe(0);
        });

        it('drainAndRejectAll rejects unsettled calls', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            const p1 = fake.getById(1);
            const p2 = fake.getById(2);

            probe.drainAndRejectAll(new Error('shutting down'));

            await expect(p1).rejects.toThrow('shutting down');
            await expect(p2).rejects.toThrow('shutting down');
            expect(probe.pendingCount()).toBe(0);
        });

        it('drainAndRejectAll skips already-settled calls', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            const p1 = fake.getById(1);
            const p2 = fake.getById(2);
            p2.catch(() => {}); // suppress unhandled rejection for the drained call

            const call = await probe.expectNext();
            call.answer({ id: 1 });
            await expect(p1).resolves.toEqual({ id: 1 });

            probe.drainAndRejectAll();
            expect(probe.pendingCount()).toBe(0);
        });

        it('drainWith applies custom handler', async () => {
            const { fake, probe } = createProbePair<DemoService>();

            void fake.getById(1);
            void fake.getById(2);

            const collected: string[] = [];
            probe.drainWith((call) => {
                collected.push(call.method);
                call.answer({ id: 0 });
            });

            expect(collected).toEqual(['getById', 'getById']);
            expect(probe.pendingCount()).toBe(0);
        });
    });

    describe('Proxy trap filtering', () => {
        it('fake is not thenable (await fake does not hang)', async () => {
            const { fake } = createProbePair<DemoService>();
            const result = await Promise.resolve(fake);
            expect(result).toBe(fake);
        });

        it('JSON.stringify does not trigger probe calls', () => {
            const { fake, probe } = createProbePair<DemoService>();
            expect(() => JSON.stringify({ service: fake })).not.toThrow();
            expect(probe.calls).toHaveLength(0);
        });
    });

    describe('extractFakes', () => {
        it('returns all fakes keyed by name', () => {
            const pairs = {
                alpha: createProbePair<{ greet(): string }>(),
                beta: createProbePair<{ count(): number }>(),
            };
            const fakes = extractFakes(pairs);
            expect(Object.keys(fakes)).toEqual(['alpha', 'beta']);
            expect(fakes.alpha).toBe(pairs.alpha.fake);
            expect(fakes.beta).toBe(pairs.beta.fake);
        });
    });

    describe('extractProbes', () => {
        it('returns all probes keyed by name', () => {
            const pairs = {
                alpha: createProbePair<{ greet(): string }>(),
                beta: createProbePair<{ count(): number }>(),
            };
            const probes = extractProbes(pairs);
            expect(Object.keys(probes)).toEqual(['alpha', 'beta']);
            expect(probes.alpha).toBe(pairs.alpha.probe);
            expect(probes.beta).toBe(pairs.beta.probe);
        });
    });
});
