import { describe, expect, it } from 'vitest';
import { milliseconds, minutes, seconds } from '@vnatures/test-kit';

describe('Duration factories', () => {
    it('milliseconds(0) is valid', () => {
        expect(milliseconds(0).milliseconds).toBe(0);
    });

    it('milliseconds(100) returns a Duration with .milliseconds === 100', () => {
        expect(milliseconds(100).milliseconds).toBe(100);
    });

    it('seconds(1) returns 1000ms', () => {
        expect(seconds(1).milliseconds).toBe(1000);
    });

    it('minutes(2) returns 120000ms', () => {
        expect(minutes(2).milliseconds).toBe(120_000);
    });

    it('fractional values are rounded to integer milliseconds', () => {
        expect(seconds(0.001).milliseconds).toBe(1);
        expect(seconds(0.0014).milliseconds).toBe(1);
        expect(seconds(0.0015).milliseconds).toBe(2);
    });

    it('milliseconds(-1) throws RangeError', () => {
        expect(() => milliseconds(-1)).toThrow(RangeError);
        expect(() => milliseconds(-5)).toThrow(/value >= 0/);
    });

    it('seconds(-1) throws RangeError', () => {
        expect(() => seconds(-1)).toThrow(RangeError);
    });

    it('minutes(-1) throws RangeError', () => {
        expect(() => minutes(-1)).toThrow(RangeError);
    });
});
