/**
 * Porcelain rules for createProbedStreamMock — the async-generator-shaped
 * sibling of createProbedMock. Mirrors rules.test.ts's once()/always()
 * coverage, plus the stream-specific "yields chunks then fails" and "never
 * closes" cases that a Promise-settled mock has no equivalent for.
 */
import { describe, expect, it } from 'vitest';
import { createProbedStreamMock } from '@hochgi/test-kit-mock';

interface StreamService {
    stream(id: number): AsyncIterable<string>;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const chunk of iterable) out.push(chunk);
    return out;
}

async function collectSettled<T>(iterable: AsyncIterable<T>): Promise<{ values: T[]; error?: unknown }> {
    const values: T[] = [];
    try {
        for await (const chunk of iterable) values.push(chunk);
        return { values };
    } catch (error) {
        return { values, error };
    }
}

describe('once() — one-shot stream rules', () => {
    it('answer() replays every chunk in order then ends', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').once().answer(['a', 'b', 'c']);

        await expect(collect(adapter.stream(1))).resolves.toEqual(['a', 'b', 'c']);
    });

    it('answer() accepts an async iterable source', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        async function* source() {
            yield 'x';
            yield 'y';
        }
        probe.on('stream').once().answer(source());

        await expect(collect(adapter.stream(1))).resolves.toEqual(['x', 'y']);
    });

    it('reject() closes with an error before any chunk is pushed', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').once().reject(new Error('boom'));

        const { values, error } = await collectSettled(adapter.stream(1));
        expect(values).toEqual([]);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('boom');
    });

    it('answerWith() scripts chunks derived from the call args', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe
            .on('stream')
            .once()
            .answerWith((call) => [`chunk-for-${call.args[0]}`]);

        await expect(collect(adapter.stream(42))).resolves.toEqual(['chunk-for-42']);
    });

    it('answerWith() yielding then throwing delivers the chunks before the error', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe
            .on('stream')
            .once()
            .answerWith(async function* () {
                yield 'first';
                yield 'second';
                throw new Error('mid-stream failure');
            });

        const { values, error } = await collectSettled(adapter.stream(1));
        expect(values).toEqual(['first', 'second']);
        expect((error as Error).message).toBe('mid-stream failure');
    });

    it('a fired one-shot is removed; the next call is not auto-handled', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').once().answer(['first']);
        await expect(collect(adapter.stream(1))).resolves.toEqual(['first']);

        void collect(adapter.stream(2));
        const pending = await probe.on('stream').expect.intercept();
        expect(pending.args).toEqual([2]);
        expect(pending.settled).toBe(false);
    });

    it('two sequential one-shots fire in registration order (FIFO)', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').once().answer(['first']);
        probe.on('stream').once().answer(['second']);

        await expect(collect(adapter.stream(1))).resolves.toEqual(['first']);
        await expect(collect(adapter.stream(2))).resolves.toEqual(['second']);
    });
});

describe('always() — permanent stream rules', () => {
    it('answers every matching call', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').always().answer(['permanent']);

        await expect(collect(adapter.stream(1))).resolves.toEqual(['permanent']);
        await expect(collect(adapter.stream(2))).resolves.toEqual(['permanent']);
    });

    it('one-shot beats permanent (tier 2 > tier 3)', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').always().answer(['permanent']);
        probe.on('stream').once().answer(['override']);

        await expect(collect(adapter.stream(1))).resolves.toEqual(['override']);
        await expect(collect(adapter.stream(2))).resolves.toEqual(['permanent']);
    });

    it('park() never closes the stream — consumption hangs', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').always().park();

        const iterator = adapter.stream(1)[Symbol.asyncIterator]();
        const race = await Promise.race([
            iterator.next().then(() => 'resolved'),
            new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
        ]);
        expect(race).toBe('timed-out');
    });
});

describe('probe bookkeeping', () => {
    it('records every call with its method and args', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').always().answer([]);

        await collect(adapter.stream(1));
        await collect(adapter.stream(2));

        expect(probe.on('stream').calls).toEqual([
            { method: 'stream', args: [1] },
            { method: 'stream', args: [2] },
        ]);
    });

    it('on() throws for a method not declared in methods', () => {
        const { probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        expect(() => (probe as unknown as { on: (m: string) => unknown }).on('notDeclared')).toThrow(
            /was not declared/,
        );
    });
});
