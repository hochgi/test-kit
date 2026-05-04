import type { Duration } from './duration.js';

export interface Clock {
    /**
     * Current time in milliseconds since epoch (or virtual equivalent under
     * fake clocks).
     */
    now(): number;

    /**
     * Advance virtual time by the given duration. realClock rejects; fake
     * clocks delegate to the underlying fake-timer system.
     */
    advance(d: Duration): Promise<void>;
}

export interface ManualClock extends Clock {
    /**
     * Run every scheduled callback whose deadline has passed.
     */
    tickAll(): Promise<void>;
}

export interface SinonFakeTimers {
    readonly now: number;
    tick(ms: number): void;
    tickAsync(ms: number): Promise<void>;
}

export function realClock(): Clock {
    return {
        now: () => Date.now(),
        async advance(_d: Duration): Promise<void> {
            throw new Error(
                'realClock cannot advance time. Configure the harness with a fake clock to use clock.advance().',
            );
        },
    };
}

interface JestGlobal {
    readonly advanceTimersByTime?: (ms: number) => void;
    readonly getTimerCount?: () => number;
    readonly isMockFunction?: (fn: unknown) => boolean;
}

interface ViGlobal {
    readonly advanceTimersByTime?: (ms: number) => void;
    readonly advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
    readonly isFakeTimers?: () => boolean;
}

function getJestGlobal(): JestGlobal | undefined {
    const g = globalThis as { jest?: JestGlobal };
    return g.jest;
}

function getViGlobal(): ViGlobal | undefined {
    const g = globalThis as { vi?: ViGlobal };
    return g.vi;
}

export function jestFakeClock(): Clock {
    return {
        now: () => Date.now(),
        async advance(d: Duration): Promise<void> {
            const jest = getJestGlobal();
            if (!jest || typeof jest.advanceTimersByTime !== 'function') {
                throw new Error(
                    'jestFakeClock requires jest.useFakeTimers() to be active before clock.advance() is called.',
                );
            }
            jest.advanceTimersByTime(d.milliseconds);
            // Allow microtasks queued by fake timers to drain.
            await Promise.resolve();
        },
    };
}

export function viFakeClock(): Clock {
    return {
        now: () => Date.now(),
        async advance(d: Duration): Promise<void> {
            const vi = getViGlobal();
            const isActive = vi && typeof vi.isFakeTimers === 'function' && vi.isFakeTimers();
            if (!isActive) {
                throw new Error(
                    'viFakeClock requires vi.useFakeTimers() to be active before clock.advance() is called.',
                );
            }
            if (typeof vi.advanceTimersByTimeAsync === 'function') {
                await vi.advanceTimersByTimeAsync(d.milliseconds);
                return;
            }
            if (typeof vi.advanceTimersByTime !== 'function') {
                throw new Error(
                    'viFakeClock requires vi.useFakeTimers() to be active before clock.advance() is called.',
                );
            }
            vi.advanceTimersByTime(d.milliseconds);
            await Promise.resolve();
        },
    };
}

export function sinonFakeClock(timers: SinonFakeTimers): Clock {
    return {
        now: () => timers.now,
        async advance(d: Duration): Promise<void> {
            await timers.tickAsync(d.milliseconds);
        },
    };
}

export function manualClock(): ManualClock {
    let now = 0;
    const scheduled: Array<{ at: number; fn: () => void | Promise<void> }> = [];

    async function runDue(upTo: number): Promise<void> {
        for (;;) {
            const idx = scheduled.findIndex((s) => s.at <= upTo);
            if (idx < 0) break;
            const [entry] = scheduled.splice(idx, 1);
            await entry.fn();
        }
    }

    return {
        now: () => now,
        async advance(d: Duration): Promise<void> {
            now += d.milliseconds;
            await runDue(now);
        },
        async tickAll(): Promise<void> {
            const all = scheduled.splice(0, scheduled.length);
            for (const entry of all) {
                await entry.fn();
            }
        },
    };
}

/**
 * Auto-detect the active fake-timer system. Order:
 *   1. vi.isFakeTimers() === true → viFakeClock
 *   2. jest fake timers active (heuristic: jest.getTimerCount is callable
 *      AND timers are mocked) → jestFakeClock
 *   3. else → realClock
 *
 * Sinon does not have a global "are fake timers active?" check that can be
 * relied on, so users wanting Sinon must pass `clock: sinonFakeClock(timers)`
 * to createHarness explicitly.
 */
export function autoDetectClock(): Clock {
    const vi = getViGlobal();
    if (vi && typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
        return viFakeClock();
    }
    const jest = getJestGlobal();
    if (jest && typeof jest.getTimerCount === 'function') {
        return jestFakeClock();
    }
    return realClock();
}
