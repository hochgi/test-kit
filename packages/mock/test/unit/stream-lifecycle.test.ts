/**
 * Regression coverage for the PR #32 review findings on the stream engine's
 * lifecycle paths (the channel-level findings live in
 * `packages/core/test/unit/stream-channel.test.ts`):
 *
 *   3. `pumpIntoChannel` racing another settlement path (`drainAndReject`,
 *      `close`, interactive `error()`): the unguarded push/end threw
 *      `doubleSettle` into a fire-and-forget promise — an unhandled rejection.
 *   4. `close()` left already-created channels unsettled, hanging any
 *      in-flight `for await` once its buffered chunks ran out.
 */
import { describe, expect, it } from 'vitest';
import { createProbedStreamMock } from '@hochgi/test-kit-mock';

interface StreamService {
    stream(id: number): AsyncIterable<string>;
}

describe('pump vs. competing settlement', () => {
    it('drainAndReject during an in-flight answerWith pump does not double-settle', async () => {
        const { adapter, probe } = createProbedStreamMock<StreamService>({ methods: ['stream'] });

        let releaseSecondChunk: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseSecondChunk = resolve;
        });

        probe
            .on('stream')
            .once()
            .answerWith(async function* () {
                yield 'first';
                await gate; // pump parks here while the channel gets settled elsewhere
                yield 'second';
            });

        const it = adapter.stream(1)[Symbol.asyncIterator]();
        expect(await it.next()).toEqual({ done: false, value: 'first' });

        // Settle the channel out from under the pump.
        probe.on('stream').drainAndReject(new Error('drained-early'));
        await expect(it.next()).rejects.toThrow('drained-early');

        // Un-park the pump: its push('second')/end() must silently no-op, not
        // throw doubleSettle into a fire-and-forget promise.
        releaseSecondChunk();
        await new Promise((r) => setImmediate(r));
        expect(await it.next()).toEqual({ done: true, value: undefined });
    });
});

describe('close() settles in-flight streams', () => {
    it('a parked consumer errors with rig-closed instead of hanging', async () => {
        const { adapter, probe, close } = createProbedStreamMock<StreamService>({ methods: ['stream'] });
        probe.on('stream').always().park();

        const it = adapter.stream(1)[Symbol.asyncIterator]();
        const pull = it.next();

        close();

        await expect(pull).rejects.toThrow(/Harness is closed/);
    });

    it('a consumer mid-way through buffered chunks errors once the buffer drains', async () => {
        const { adapter, probe, close } = createProbedStreamMock<StreamService>({ methods: ['stream'] });

        const pendingPromise = probe.on('stream').expect.intercept();
        const it = adapter.stream(1)[Symbol.asyncIterator]();
        const pending = await pendingPromise;
        pending.push('delivered');

        close();

        // The buffered chunk is still delivered; the next pull surfaces the
        // rig-closed error instead of hanging forever.
        expect(await it.next()).toEqual({ done: false, value: 'delivered' });
        await expect(it.next()).rejects.toThrow(/Harness is closed/);
    });
});
