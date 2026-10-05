import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualClock, milliseconds, realClock, seconds, viFakeClock } from '@hochgi/test-kit';

describe('realClock', () => {
    it('now() returns wall-clock ms', () => {
        const before = Date.now();
        const t = realClock().now();
        const after = Date.now();
        expect(t).toBeGreaterThanOrEqual(before);
        expect(t).toBeLessThanOrEqual(after);
    });

    it('advance() rejects with the spec error', async () => {
        await expect(realClock().advance(seconds(1))).rejects.toThrow(/realClock cannot advance/);
    });
});

describe('viFakeClock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('advance() delegates to vi.advanceTimersByTimeAsync', async () => {
        const clock = viFakeClock();
        let fired = false;
        setTimeout(() => {
            fired = true;
        }, 100);

        expect(fired).toBe(false);
        await clock.advance(milliseconds(100));
        expect(fired).toBe(true);
    });

    it('advance() throws if vi.useFakeTimers() is not active', async () => {
        vi.useRealTimers();
        const clock = viFakeClock();
        await expect(clock.advance(milliseconds(100))).rejects.toThrow(/viFakeClock requires vi\.useFakeTimers/);
    });
});

describe('manualClock', () => {
    it('now() starts at 0; advance() bumps it', async () => {
        const clock = manualClock();
        expect(clock.now()).toBe(0);
        await clock.advance(milliseconds(500));
        expect(clock.now()).toBe(500);
    });
});
