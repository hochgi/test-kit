import Redis from "ioredis-mock";

type CacheKeyInput = string | { format: string; args?: string[] };
type TtlResolver<T> = number | ((result: T) => number);

function formatKey(input: CacheKeyInput): string {
  if (typeof input === "string") {
    return input;
  }
  const args = input.args ?? [];
  if (input.format.includes("%s")) {
    let index = 0;
    return input.format.replace(/%s/g, () => args[index++] ?? "");
  }
  return args.length > 0 ? `${input.format}:${args.join(":")}` : input.format;
}

function toStoredValue(value: unknown): string {
  return JSON.stringify(value);
}

function fromStoredValue<T>(value: string | null): T {
  if (value === null) {
    return value as T;
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
  get<T>(key: CacheKeyInput): Promise<T>;
  del(key: CacheKeyInput): Promise<void>;
  setnx<T>(
    input: { key: CacheKeyInput; val: T },
    options?: { mode?: "PX" | "EX"; ttl: number }
  ): Promise<T>;
  getSet<T>(
    cacheKey: CacheKeyInput,
    apiFunc: () => Promise<T>,
    options?: { ttl?: TtlResolver<T> }
  ): Promise<T>;
};

export function createInMemoryCache(): InMemoryCache {
  const client = new Redis();

  return {
    client,
    async set<T>(input: { key: CacheKeyInput; val: T }, ttlMs?: number): Promise<boolean> {
      const key = formatKey(input.key);
      if (ttlMs && ttlMs > 0) {
        const result = await client.set(key, toStoredValue(input.val), "PX", ttlMs);
        return result === "OK";
      }
      const result = await client.set(key, toStoredValue(input.val));
      return result === "OK";
    },
    async get<T>(keyInput: CacheKeyInput): Promise<T> {
      const value = await client.get(formatKey(keyInput));
      return fromStoredValue<T>(value);
    },
    async del(keyInput: CacheKeyInput): Promise<void> {
      await client.del(formatKey(keyInput));
    },
    async setnx<T>(
      input: { key: CacheKeyInput; val: T },
      options?: { mode?: "PX" | "EX"; ttl: number }
    ): Promise<T> {
      const key = formatKey(input.key);
      const ttl = options?.ttl;
      const mode = options?.mode ?? "PX";
      const result = await client.setnx(key, toStoredValue(input.val));
      if (result === 1) {
        if (ttl && ttl > 0) {
          if (mode === "EX") {
            await client.expire(key, ttl);
          } else {
            await client.pexpire(key, ttl);
          }
        }
        return input.val;
      }

      const existing = await client.get(key);
      return fromStoredValue<T>(existing);
    },
    async getSet<T>(
      cacheKey: CacheKeyInput,
      apiFunc: () => Promise<T>,
      options?: { ttl?: TtlResolver<T> }
    ): Promise<T> {
      const key = formatKey(cacheKey);
      const cached = await client.get(key);
      if (cached !== null) {
        return fromStoredValue<T>(cached);
      }

      const value = await apiFunc();
      const ttl = options?.ttl;
      const ttlMs = typeof ttl === "function" ? ttl(value) : ttl;
      if (ttlMs && ttlMs > 0) {
        await client.set(key, toStoredValue(value), "PX", ttlMs);
      } else {
        await client.set(key, toStoredValue(value));
      }
      return value;
    }
  };
}
