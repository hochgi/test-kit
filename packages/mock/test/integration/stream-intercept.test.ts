/**
 * Interactive push/end/error control of an in-flight stream call — the
 * stream sibling of retroactive-intercept.test.ts. A pending stream call
 * exposes push/end/error instead of answer/reject, so a test can drive a
 * consumer's `for await` one chunk at a time, on its own schedule, then
 * decide whether to end normally or fail mid-stream.
 */
import { describe, expect, it } from 'vitest';
import { milliseconds } from '@vnatures/test-kit';
import { createProbedStreamMock } from '@vnatures/test-kit-mock';

interface StreamService {
    stream(id: number): AsyncIterable<string>;
}

describe('Interactive intercept — push/end/error', () => {
    it('pre-registered intercept receives pushed chunks as the consumer pulls them', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });

        const pendingPromise = probe.on('stream').expect.intercept();
        const iterator = adapter.stream(7)[Symbol.asyncIterator]();

        const pending = await pendingPromise;
        expect(pending.args).toEqual([7]);
        expect(pending.settled).toBe(false);

        pending.push('one');
        await expect(iterator.next()).resolves.toEqual({ done: false, value: 'one' });

        pending.push('two');
        await expect(iterator.next()).resolves.toEqual({ done: false, value: 'two' });

        pending.end();
        expect(pending.settled).toBe(true);
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it('error() after some pushes makes the next pull throw', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });

        const pendingPromise = probe.on('stream').expect.intercept();
        const iterator = adapter.stream(1)[Symbol.asyncIterator]();
        const pending = await pendingPromise;

        pending.push('partial');
        await expect(iterator.next()).resolves.toEqual({ done: false, value: 'partial' });

        pending.error(new Error('connection dropped'));
        await expect(iterator.next()).rejects.toThrow('connection dropped');
    });

    it('push()/end() after settlement throws (double-settle guard)', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });

        const pendingPromise = probe.on('stream').expect.intercept();
        void adapter.stream(1);
        const pending = await pendingPromise;

        pending.end();
        expect(() => pending.push('too-late')).toThrow(/already settled/);
        expect(() => pending.end()).toThrow(/already settled/);
    });

    it('retroactive intercept captures a call that parked with no rule installed', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });

        const iterator = adapter.stream(9)[Symbol.asyncIterator]();
        await new Promise((r) => setImmediate(r));

        const pending = await probe.on('stream').expect.intercept();
        expect(pending.args).toEqual([9]);

        pending.push('late-but-captured');
        pending.end();

        await expect(iterator.next()).resolves.toEqual({ done: false, value: 'late-but-captured' });
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it('a call caught by always().park() is NOT retroactively interceptable', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').always().park();

        void adapter.stream(1)[Symbol.asyncIterator]().next();
        await new Promise((r) => setImmediate(r));

        await expect(probe.on('stream').expect.intercept({ within: milliseconds(50) })).rejects.toThrow(/Timed out/);
    });
});
