/**
 * Branded Duration type. Public timing APIs accept Duration only — never raw
 * numbers. The brand prevents accidentally passing `{ milliseconds: 100 }`
 * literals from another module; only the factory functions can mint a
 * Duration.
 */
declare const durationBrand: unique symbol;

export type Duration = {
    readonly milliseconds: number;
    readonly [durationBrand]: true;
};

function makeDuration(value: number): Duration {
    return { milliseconds: Math.round(value) } as Duration;
}

export function milliseconds(value: number): Duration {
    if (value < 0) {
        throw new RangeError(`milliseconds(...) requires value >= 0, got ${value}`);
    }
    return makeDuration(value);
}

export function seconds(value: number): Duration {
    if (value < 0) {
        throw new RangeError(`seconds(...) requires value >= 0, got ${value}`);
    }
    return makeDuration(value * 1000);
}

export function minutes(value: number): Duration {
    if (value < 0) {
        throw new RangeError(`minutes(...) requires value >= 0, got ${value}`);
    }
    return makeDuration(value * 60_000);
}
