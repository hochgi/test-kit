// eslint-disable-next-line @typescript-eslint/naming-convention
import Redis from 'ioredis-mock';

export type CacheKeyInput = string | { format: string; args?: string[] };
export type TtlResolver<T> = number | ((result: T) => number);

export function formatKey(input: CacheKeyInput): string {
    if (typeof input === 'string') {
        return input;
    }
    const args = input.args ?? [];
    if (input.format.includes('%s')) {
        let index = 0;
        return input.format.replace(/%s/g, () => {
            const value = args[index] ?? '';
            index += 1;
            return value;
        });
    }
    return args.length > 0 ? `${input.format}:${args.join(':')}` : input.format;
}

export function toStoredValue(value: unknown): string {
    return JSON.stringify(value);
}

export function fromStoredValue<T>(value: string | null): T | null {
    if (value === null) {
        return null;
    }
    try {
        return JSON.parse(value) as T;
    } catch {
        return value as T;
    }
}

export type InMemoryCache = {
    client: any;
    set<T>(input: { key: CacheKeyInput; val: T }, ttlMs?: number): Promise<boolean>;
    get<T>(key: CacheKeyInput): Promise<T | null>;
    del(key: CacheKeyInput): Promise<void>;
    setnx<T>(input: { key: CacheKeyInput; val: T }, options?: { mode?: 'PX' | 'EX'; ttl: number }): Promise<T>;
    getSet<T>(cacheKey: CacheKeyInput, apiFunc: () => Promise<T>, options?: { ttl?: TtlResolver<T> }): Promise<T>;
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function buildCacheOperations(client: any): Omit<InMemoryCache, 'client'> {
    return {
        async set<T>(input: { key: CacheKeyInput; val: T }, ttlMs?: number): Promise<boolean> {
            const key = formatKey(input.key);
            if (ttlMs && ttlMs > 0) {
                const result = await client.set(key, toStoredValue(input.val), 'PX', ttlMs);
                return result === 'OK';
            }
            const result = await client.set(key, toStoredValue(input.val));
            return result === 'OK';
        },
        async get<T>(keyInput: CacheKeyInput): Promise<T | null> {
            const value = await client.get(formatKey(keyInput));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            return fromStoredValue<T>(value);
        },
        async del(keyInput: CacheKeyInput): Promise<void> {
            await client.del(formatKey(keyInput));
        },
        async setnx<T>(
            input: { key: CacheKeyInput; val: T },
            options?: { mode?: 'PX' | 'EX'; ttl: number },
        ): Promise<T> {
            const key = formatKey(input.key);
            const ttl = options?.ttl;
            const mode = options?.mode ?? 'PX';
            const result = await client.setnx(key, toStoredValue(input.val));
            if (result === 1) {
                if (ttl && ttl > 0) {
                    if (mode === 'EX') {
                        await client.expire(key, ttl);
                    } else {
                        await client.pexpire(key, ttl);
                    }
                }
                return input.val;
            }

            const existing = await client.get(key);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            return fromStoredValue<T>(existing) as T;
        },
        async getSet<T>(
            cacheKey: CacheKeyInput,
            apiFunc: () => Promise<T>,
            options?: { ttl?: TtlResolver<T> },
        ): Promise<T> {
            const key = formatKey(cacheKey);
            const cached = await client.get(key);
            if (cached !== null) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                return fromStoredValue<T>(cached) as T;
            }

            const value = await apiFunc();
            const ttl = options?.ttl;
            const ttlMs = typeof ttl === 'function' ? ttl(value) : ttl;
            if (ttlMs && ttlMs > 0) {
                await client.set(key, toStoredValue(value), 'PX', ttlMs);
            } else {
                await client.set(key, toStoredValue(value));
            }
            return value;
        },
    };
}

export function createInMemoryCache(): InMemoryCache {
    const client = new Redis();
    return { client, ...buildCacheOperations(client) };
}
