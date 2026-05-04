import type { CacheKeyInput } from './types.js';

export function formatKey(input: CacheKeyInput): string {
    if (typeof input === 'string') return input;
    const args = input.args ?? [];
    if (input.format.includes('%s')) {
        let i = 0;
        return input.format.replace(/%s/g, () => {
            const v = args[i] ?? '';
            i += 1;
            return String(v);
        });
    }
    return args.length > 0 ? `${input.format}:${args.join(':')}` : input.format;
}

export function toStored(value: unknown): string {
    return JSON.stringify(value);
}

export function fromStored<T>(value: string | null): T | null {
    if (value === null) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return value as T;
    }
}
