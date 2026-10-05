import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRig, milliseconds, seconds, viFakeClock, type Rig } from '@hochgi/test-kit';
import { createProbedBullQueue, maxRetriesPerRequestError, type ProbedBullQueue } from '@hochgi/test-kit-bull';

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('createProbedBullQueue', () => {
    let rig: Rig;
    let queue: ProbedBullQueue<{ siteId: number }>;

    beforeEach(() => {
        rig = createRig();
        queue = rig.attach(createProbedBullQueue({ harness: rig, name: 'exports' }));
    });

    afterEach(async () => {
        await rig.close();
    });

    describe('default forward rule (in-memory backing)', () => {
        it('forwards add and returns a job handle with id', async () => {
            const job = await queue.adapter.add({ siteId: 42 });
            expect(job.id).toBeDefined();
            expect(job.data).toEqual({ siteId: 42 });
        });

        it('records add calls in probe.calls with { method, args } shape', async () => {
            await queue.adapter.add({ siteId: 1 });
            await queue.adapter.add('custom', { siteId: 2 }, { delay: 100 });

            expect(queue.probe.calls).toHaveLength(2);
            expect(queue.probe.calls[0]).toEqual({
                method: 'add',
                args: [{ siteId: 1 }],
            });
            expect(queue.probe.calls[1]).toEqual({
                method: 'add',
                args: ['custom', { siteId: 2 }, { delay: 100 }],
            });
        });

        it('probe.on("add").expect.calledTimes works on the happy path', async () => {
            await queue.adapter.add({ siteId: 7 });
            queue.probe.on('add').expect.calledTimes(1);
        });
    });

    describe('failure injection', () => {
        it('once().reject(maxRetriesPerRequestError()) rejects the next enqueue', async () => {
            queue.probe.on('add').once().reject(maxRetriesPerRequestError());

            await expect(queue.adapter.add({ siteId: 1 })).rejects.toMatchObject({
                name: 'MaxRetriesPerRequestError',
            });

            const job = await queue.adapter.add({ siteId: 2 });
            expect(job.id).toBeDefined();
        });

        it('always().reject(...) rejects every subsequent enqueue', async () => {
            queue.probe.on('add').always().reject(new Error('queue down'));

            await expect(queue.adapter.add({ siteId: 1 })).rejects.toThrow('queue down');
            await expect(queue.adapter.add({ siteId: 2 })).rejects.toThrow('queue down');
        });
    });

    describe('hang via park + clock', () => {
        it('leaves add pending when intercept is not settled', async () => {
            vi.useFakeTimers();
            const clockRig = createRig({ clock: viFakeClock() });
            try {
                const clockQueue = clockRig.attach(createProbedBullQueue({ harness: clockRig, name: 'timed' }));

                const pendingPromise = clockQueue.probe.on('add').expect.intercept();
                const addPromise = clockQueue.adapter.add({ siteId: 99 });
                const pending = await pendingPromise;

                expect(pending.args[0]).toEqual({ siteId: 99 });

                let settled = false;
                void addPromise.then(
                    () => {
                        settled = true;
                    },
                    () => {
                        settled = true;
                    },
                );

                await clockRig.clock.advance(seconds(5));
                expect(settled).toBe(false);

                pending.forward();
                const job = await addPromise;
                expect(job.id).toBeDefined();
            } finally {
                await clockRig.close();
                vi.useRealTimers();
            }
        });
    });

    describe('functional consume lifecycle', () => {
        it('processes jobs and emits completed', async () => {
            const completed = vi.fn();
            queue.adapter.on('completed', completed);

            const handler = vi.fn(async (job: { data: { siteId: number } }) => ({ ok: true, siteId: job.data.siteId }));
            await queue.adapter.process(handler);

            const job = await queue.adapter.add({ siteId: 5 });
            await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));

            expect(handler).toHaveBeenCalledWith(expect.objectContaining({ data: { siteId: 5 } }));
            expect(completed).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, state: 'completed' }), {
                ok: true,
                siteId: 5,
            });
        });

        it('emits failed when the processor throws', async () => {
            const failed = vi.fn();
            queue.adapter.on('failed', failed);

            await queue.adapter.process(async () => {
                throw new Error('processor boom');
            });
            await queue.adapter.add({ siteId: 3 });

            await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
            expect(failed).toHaveBeenCalledWith(
                expect.objectContaining({ state: 'failed', failedReason: 'processor boom' }),
                expect.any(Error),
            );
        });

        it('routes named jobs only to their matching named processor', async () => {
            const exportHandler = vi.fn(async () => 'exported');
            const reportHandler = vi.fn(async () => 'reported');

            // Multiple named processors coexist (mirrors @nestjs/bull @Process('name')).
            await queue.adapter.process('export', exportHandler);
            await queue.adapter.process('report', reportHandler);

            await queue.adapter.add('export', { siteId: 1 });
            await queue.adapter.add('report', { siteId: 2 });

            await vi.waitFor(() => {
                expect(exportHandler).toHaveBeenCalledTimes(1);
                expect(reportHandler).toHaveBeenCalledTimes(1);
            });
            expect(exportHandler).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'export', data: { siteId: 1 } }),
            );
            expect(reportHandler).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'report', data: { siteId: 2 } }),
            );
        });

        it('leaves a named job waiting when no matching processor is registered', async () => {
            const other = vi.fn(async () => 'ok');
            await queue.adapter.process('only-this', other);

            await queue.adapter.add('unhandled', { siteId: 9 });
            // Give any (incorrect) processing a chance to run.
            await new Promise((r) => setTimeout(r, 10));

            expect(other).not.toHaveBeenCalled();
            const counts = await queue.adapter.getJobCounts();
            expect(counts.waiting).toBe(1);
        });

        it('rejects re-registering a processor for the same job name', async () => {
            await queue.adapter.process('dup', async () => 'a');
            await expect(queue.adapter.process('dup', async () => 'b')).rejects.toThrow(
                /already registered for job name 'dup'/,
            );
        });
    });

    describe('job id allocation', () => {
        it('does not let an auto id overwrite an explicit jobId', async () => {
            // Explicit jobId '1' would collide with the first auto id.
            const explicit = await queue.adapter.add({ siteId: 1 }, { jobId: '1' });
            const auto = await queue.adapter.add({ siteId: 2 });

            expect(explicit.id).toBe('1');
            expect(auto.id).not.toBe('1');

            const stillThere = await queue.adapter.getJob('1');
            expect(stillThere?.data).toEqual({ siteId: 1 });
            const counts = await queue.adapter.getJobCounts();
            expect(counts.waiting).toBe(2);
        });
    });

    describe('drop-in Bull surface', () => {
        it('exposes the queue name on the adapter (matches bull.Queue.name)', () => {
            expect(queue.adapter.name).toBe('exports');
        });
    });

    describe('delayed jobs via rig.clock', () => {
        it('honors add delay before processing', async () => {
            vi.useFakeTimers();
            const clockRig = createRig({ clock: viFakeClock() });
            try {
                const clockQueue = clockRig.attach(createProbedBullQueue({ harness: clockRig, name: 'delayed' }));

                const handler = vi.fn(async () => 'done');
                await clockQueue.adapter.process(handler);
                await clockQueue.adapter.add({ siteId: 10 }, { delay: 5000 });

                expect(handler).not.toHaveBeenCalled();

                await clockRig.clock.advance(milliseconds(5000));
                await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
            } finally {
                await clockRig.close();
                vi.useRealTimers();
            }
        });
    });

    describe('unsupported Queue methods', () => {
        it('throws unsupportedForward for known Bull methods outside the v1 surface', async () => {
            const pause = (queue.adapter as { pause?: () => void }).pause;
            expect(pause).toBeDefined();
            expect(() => pause!()).toThrow(/Cannot forward Bull command 'pause'/);
        });

        it('returns undefined for framework introspection props (NestJS/Promise/matchers stay safe)', () => {
            const adapter = queue.adapter as unknown as Record<string, unknown>;
            // NestJS lifecycle scanner uses `typeof instance.hook === 'function'`.
            expect(adapter.onModuleDestroy).toBeUndefined();
            expect(adapter.onApplicationShutdown).toBeUndefined();
            expect(adapter.beforeApplicationShutdown).toBeUndefined();
            // Thenable check must not see a callable `then`.
            expect(adapter.then).toBeUndefined();
            // Test-matcher / serialization introspection.
            expect(adapter.asymmetricMatch).toBeUndefined();
            expect(adapter.toJSON).toBeUndefined();
            expect((adapter as { $$typeof?: unknown }).$$typeof).toBeUndefined();
        });
    });

    describe('reset and close', () => {
        it('reset clears job state between scenarios', async () => {
            await queue.adapter.add({ siteId: 1 });
            expect(queue.probe.calls).toHaveLength(1);

            await queue.reset();
            queue.probe.clearCalls();

            const counts = await queue.adapter.getJobCounts();
            expect(counts.waiting + counts.active + counts.completed + counts.failed + counts.delayed).toBe(0);
        });

        it('rig.close() disposes without open handles', async () => {
            await queue.adapter.add({ siteId: 1 });
            await rig.close();
            expect(() => {
                void queue.adapter.isReady();
            }).toThrow(/closed/i);
        });
    });
});
