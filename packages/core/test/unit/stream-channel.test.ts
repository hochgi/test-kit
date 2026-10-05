/**
 * Regression coverage for the PR #32 review findings on `createChannel`:
 *
 *   1. Concurrent parked `next()` pulls: a single `wake` slot dropped all but
 *      the latest waiter, hanging the earlier pulls forever.
 *   2. `next()` after the terminal signal: the wait loop never re-checked
 *      `closed`, so a pull after `done`/`error` hung instead of resolving
 *      `{done: true}` (async-generator completion semantics).
 *
 * The pump-race and dispose findings are covered at the mock level in
 * `packages/mock/test/unit/stream-lifecycle.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createChannel } from '@hochgi/test-kit';

describe('createChannel — waker queue', () => {
    it('wakes every parked pull, not just the most recent one', async () => {
        const ch = createChannel<string>();
        const it = ch[Symbol.asyncIterator]();

        // Two pulls parked concurrently — with a single wake slot, p1's waker
        // would be overwritten by p2's and p1 would hang forever.
        const p1 = it.next();
        const p2 = it.next();

        ch.push('a');
        ch.push('b');
        ch.end();

        expect(await p1).toEqual({ done: false, value: 'a' });
        expect(await p2).toEqual({ done: false, value: 'b' });
        expect(await it.next()).toEqual({ done: true, value: undefined });
    });

    it('wakes parked pulls on two independent iterators of the same channel', async () => {
        const ch = createChannel<string>();
        const it1 = ch[Symbol.asyncIterator]();
        const it2 = ch[Symbol.asyncIterator]();

        const p1 = it1.next();
        const p2 = it2.next();

        ch.push('x');
        ch.end();

        // Each iterator replays the buffer from the start.
        expect(await p1).toEqual({ done: false, value: 'x' });
        expect(await p2).toEqual({ done: false, value: 'x' });
    });
});

describe('createChannel — completion semantics', () => {
    it('next() after done resolves {done: true} again instead of hanging', async () => {
        const ch = createChannel<string>();
        ch.push('only');
        ch.end();

        const it = ch[Symbol.asyncIterator]();
        expect(await it.next()).toEqual({ done: false, value: 'only' });
        expect(await it.next()).toEqual({ done: true, value: undefined });
        // The regression: this third pull used to park forever.
        expect(await it.next()).toEqual({ done: true, value: undefined });
    });

    it('next() after a thrown error resolves {done: true} (error is delivered once)', async () => {
        const ch = createChannel<string>();
        ch.error(new Error('boom'));

        const it = ch[Symbol.asyncIterator]();
        await expect(it.next()).rejects.toThrow('boom');
        expect(await it.next()).toEqual({ done: true, value: undefined });
    });

    it('a pull parked before end() resolves {done: true} when the buffer is already drained by another pull', async () => {
        const ch = createChannel<string>();
        const it = ch[Symbol.asyncIterator]();
        const p1 = it.next();
        const p2 = it.next();

        // One chunk for two parked pulls: p1 takes it, p2 must see the end
        // marker (not hang) once end() lands.
        ch.push('a');
        ch.end();

        expect(await p1).toEqual({ done: false, value: 'a' });
        expect(await p2).toEqual({ done: true, value: undefined });
    });
});
