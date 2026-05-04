/**
 * Harness lifecycle owner: attach/reset/close + cross-probe expectations
 * (sequence, allOf, observation).
 *
 * Per docs/v2-tech-design.md §"Harness Implementation".
 */
import type { Duration } from './duration.js';
import { milliseconds, seconds } from './duration.js';
import { autoDetectClock, type Clock } from './clock.js';
import { errors } from './errors.js';
import type { PendingCallBase, ProbedAdapter, Selection } from './types.js';

// Helper alias: any selection regardless of pending type.
type AnySelection = Selection<unknown, PendingCallBase<unknown>>;

// ── Cross-probe expectation types ──────────────────────────────────────────

export interface Observation<TCall> {
    readonly kind: 'observe';
    readonly selection: Selection<TCall, PendingCallBase<TCall>>;
}

export function observation<TCall, TPending extends PendingCallBase<TCall>>(
    selection: Selection<TCall, TPending>,
): Observation<TCall> {
    return {
        kind: 'observe',
        selection: selection as unknown as Selection<TCall, PendingCallBase<TCall>>,
    };
}

type SequenceStep = AnySelection | Observation<unknown>;

export type SequenceResult<S extends ReadonlyArray<SequenceStep>> = {
    [K in keyof S]: S[K] extends Selection<infer _T, infer P> ? P : S[K] extends Observation<infer T> ? T : never;
};

export interface HarnessExpectations {
    sequence<S extends ReadonlyArray<SequenceStep>>(
        steps: S,
        options: { readonly within: Duration },
    ): Promise<SequenceResult<S>>;
    allOf<S extends ReadonlyArray<SequenceStep>>(
        steps: S,
        options: { readonly within: Duration },
    ): Promise<SequenceResult<S>>;
}

// ── Harness ────────────────────────────────────────────────────────────────

export interface CreateHarnessOptions {
    readonly clock?: Clock;
    readonly defaultTimeout?: Duration;
    readonly safetyTimeout?: Duration | null;
}

export interface Harness {
    readonly clock: Clock;
    readonly defaultTimeout: Duration;
    readonly safetyTimeout: Duration | null;
    readonly expect: HarnessExpectations;
    attach<T extends ProbedAdapter<unknown, unknown>>(adapter: T): T;
    attach<T extends ProbedAdapter<unknown, unknown>>(adapter: Promise<T>): Promise<T>;
    reset(options?: { keepRules?: boolean }): Promise<void>;
    close(): Promise<void>;
}

interface AttachedAdapter {
    reset?(): Promise<void> | void;
    close?(): Promise<void> | void;
    probe?: {
        resetProbe?(options?: { includeDefaults?: boolean }): void;
        clearCalls?(): void;
    };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return (
        typeof value === 'object' &&
        value !== null &&
        'then' in value &&
        typeof (value as { then?: unknown }).then === 'function'
    );
}

function isObservationStep(step: SequenceStep): step is Observation<unknown> {
    return typeof step === 'object' && step !== null && (step as Observation<unknown>).kind === 'observe';
}

export function createHarness(options?: CreateHarnessOptions): Harness {
    const clock = options?.clock ?? autoDetectClock();
    const defaultTimeout = options?.defaultTimeout ?? seconds(5);
    const safetyTimeout = options?.safetyTimeout === undefined ? seconds(30) : options.safetyTimeout;

    const adapters: AttachedAdapter[] = [];
    let closed = false;

    const expectImpl: HarnessExpectations = {
        async sequence<S extends ReadonlyArray<SequenceStep>>(
            steps: S,
            opts: { readonly within: Duration },
        ): Promise<SequenceResult<S>> {
            const start = Date.now();
            const totalMs = opts.within.milliseconds;
            const results: unknown[] = [];

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                const elapsed = Date.now() - start;
                const remaining = totalMs - elapsed;
                if (remaining <= 0) {
                    throw errors.sequenceTimeout(totalMs, i, steps.length, stepLabel(step));
                }
                const stepOptions = { within: milliseconds(remaining) };
                try {
                    if (isObservationStep(step)) {
                        results.push(await step.selection.expect.observe(stepOptions));
                    } else {
                        results.push(await (step as AnySelection).expect.intercept(stepOptions));
                    }
                } catch (err) {
                    // Repackage timeout into a sequence-level diagnostic.
                    if (err instanceof Error && /Timed out/.test(err.message)) {
                        throw errors.sequenceTimeout(totalMs, i, steps.length, stepLabel(step));
                    }
                    throw err;
                }
            }

            return results as SequenceResult<S>;
        },

        async allOf<S extends ReadonlyArray<SequenceStep>>(
            steps: S,
            opts: { readonly within: Duration },
        ): Promise<SequenceResult<S>> {
            const promises = steps.map((step) => {
                if (isObservationStep(step)) {
                    return step.selection.expect.observe({ within: opts.within });
                }
                return (step as AnySelection).expect.intercept({
                    within: opts.within,
                });
            });

            const settled = await Promise.allSettled(promises);
            const unsatisfied: string[] = [];
            let satisfied = 0;
            for (let i = 0; i < settled.length; i++) {
                if (settled[i].status === 'fulfilled') {
                    satisfied += 1;
                } else {
                    unsatisfied.push(stepLabel(steps[i]));
                }
            }
            if (unsatisfied.length > 0) {
                throw errors.allOfTimeout(opts.within.milliseconds, satisfied, steps.length, unsatisfied);
            }
            return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as SequenceResult<S>;
        },
    };

    const harness: Harness = {
        get clock() {
            return clock;
        },
        get defaultTimeout() {
            return defaultTimeout;
        },
        get safetyTimeout() {
            return safetyTimeout;
        },
        get expect() {
            return expectImpl;
        },

        attach: (<T extends ProbedAdapter<unknown, unknown>>(adapter: T | Promise<T>): T | Promise<T> => {
            if (closed) {
                throw errors.harnessClosed();
            }
            if (isPromiseLike(adapter)) {
                return adapter.then((a) => harness.attach(a));
            }
            adapters.push(adapter as unknown as AttachedAdapter);
            return adapter;
        }) as Harness['attach'],

        async reset(options?: { keepRules?: boolean }) {
            if (closed) throw errors.harnessClosed();
            const keepRules = options?.keepRules ?? false;
            for (const adapter of adapters) {
                if (typeof adapter.reset === 'function') {
                    await adapter.reset();
                }
                if (keepRules) {
                    // Only clear call history; preserve user-installed rules.
                    adapter.probe?.clearCalls?.();
                } else {
                    adapter.probe?.resetProbe?.();
                }
            }
        },

        async close() {
            if (closed) return;
            closed = true;
            // Reverse-registration order.
            const errs: unknown[] = [];
            for (let i = adapters.length - 1; i >= 0; i--) {
                const adapter = adapters[i];
                if (typeof adapter.close === 'function') {
                    try {
                        await adapter.close();
                    } catch (e) {
                        errs.push(e);
                    }
                }
            }
            if (errs.length > 0) {
                // Don't fail close on adapter errors; surface via console.
                // Test authors who want strict close behavior can wrap.
                // eslint-disable-next-line no-console
                console.error('Adapter close errors:', errs);
            }
        },
    };

    return harness;
}

function stepLabel(step: SequenceStep): string {
    // Selection has a private filter chain — we can't read its label without
    // exposing it. For now, distinguish step kind only.
    if (isObservationStep(step)) return '<observation>';
    return '<intercept>';
}
