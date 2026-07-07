/**
 * Error message templates. Domain packages import from this central registry
 * so error wording stays consistent across boundaries. Per spec, every error
 * is a plain Error / RangeError — there is no custom error class hierarchy.
 */

export const errors = {
    timeout: (label: string, ms: number): Error =>
        new Error(`Timed out after ${ms}ms waiting for next call matching ${label}.`),

    none: (label: string, ms: number, n: number): Error =>
        new Error(`Expected no calls matching ${label} within ${ms}ms, but received ${n}.`),

    exactly: (label: string, n: number, ms: number, actual: number): Error =>
        new Error(`Expected exactly ${n} calls matching ${label} within ${ms}ms, but received ${actual}.`),

    atLeast: (label: string, n: number, ms: number, actual: number): Error =>
        new Error(`Timed out after ${ms}ms waiting for atLeast(${n}) calls matching ${label}. Got ${actual}.`),

    doubleSettle: (label: string): Error => new Error(`Pending call '${label}' is already settled.`),

    unsupportedForward: (domain: string, name: string): Error =>
        new Error(
            `Cannot forward ${domain} command '${name}': no local backing implementation supports it. Use .answer(...) or .reject(...).`,
        ),

    realClockAdvance: (): Error =>
        new Error('realClock cannot advance time. Configure the harness with a fake clock to use clock.advance().'),

    jestFakeNotActive: (): Error =>
        new Error('jestFakeClock requires jest.useFakeTimers() to be active before clock.advance() is called.'),

    viFakeNotActive: (): Error =>
        new Error('viFakeClock requires vi.useFakeTimers() to be active before clock.advance() is called.'),

    safetyTimeout: (ms: number): Error =>
        new Error(
            `Test exceeded the harness safety timeout (${ms}ms wall-clock). This usually means the test is hung; check for missing settlements or unmet expectations.`,
        ),

    harnessClosed: (): Error => new Error('Harness is closed.'),

    closeWithUnsettledWaiters: (n: number): Error => new Error(`Harness closed with ${n} unsettled waiter(s).`),

    sequenceOrder: (laterIdx: number, laterLabel: string, earlierIdx: number, earlierLabel: string): Error =>
        new Error(
            `Sequence expectation failed: step ${laterIdx} (${laterLabel}) matched before step ${earlierIdx} (${earlierLabel}) was satisfied.`,
        ),

    sequenceTimeout: (totalMs: number, satisfied: number, total: number, label: string): Error =>
        new Error(
            `Sequence expectation timed out after ${totalMs}ms. Steps satisfied: ${satisfied}/${total}. First unsatisfied step: ${label}.`,
        ),

    allOfTimeout: (totalMs: number, satisfied: number, total: number, labels: ReadonlyArray<string>): Error =>
        new Error(
            `allOf expectation timed out after ${totalMs}ms. ${satisfied}/${total} steps satisfied. Unsatisfied: [${labels.join(', ')}].`,
        ),

    cannotForwardNoBacking: (): Error => new Error('Cannot forward: this probe has no backing.'),

    syncMethodNotDeclared: (method: string): Error =>
        new Error(`Method '${method}' was not declared in the mock's methods list.`),
};

/**
 * Coerce an unknown thrown / rejected value into an Error. Symbol/null/etc.
 * are wrapped via String().
 */
export function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
