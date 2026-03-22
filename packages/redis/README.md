# @vnatures/test-kit-redis

An in-memory Redis cache fake for component tests, backed by `ioredis-mock`.

## Why a specific cache interface?

When testing a component that uses Redis, what is the correct "Application Boundary" to fake? We need to find the "Goldilocks" seam:

- **Too Thin (Too Low-Level):** Faking the raw Redis network protocol. This is too low-level, making tests fragile to infrastructure changes.
- **Too Fat (Too Broad):** Faking a generic `IRedisClient` (like `ioredis` or `redis` packages). This exposes hundreds of Redis-specific commands that most applications never use, making it hard to fake and test reliably, and tying your application logic to a specific Redis driver.

**Just Right:** The correct boundary is a focused, domain-agnostic caching interface that the application depends on (e.g., `get`, `set`, `del`). This package provides exactly that: an `InMemoryCache` interface and a `createProbedCache()` function to fake it.

## Install

```bash
npm install --save-dev @vnatures/test-kit-redis
```

## Quick Start

```typescript
import { createProbedCache, ProbedCache, CacheProbe } from '@vnatures/test-kit-redis';

let cache: ProbedCache;
let probe: CacheProbe;

beforeEach(() => {
    cache = createProbedCache();
    probe = cache.probe;
    // Starts in alwaysForward() mode — calls pass through to the in-memory store
});

it('stores and retrieves data', async () => {
    await cache.set({ key: 'user:1', val: { name: 'Alice' } });
    const user = await cache.get<{ name: string }>('user:1');
    expect(user).toEqual({ name: 'Alice' });
});
```

## Probed Fake Examples

Because `createProbedCache()` returns a probed fake, you can intercept cache calls to simulate network errors or race conditions.

### Simulating a Cache Error

```typescript
it('handles Redis connection errors gracefully', async () => {
    // Reject the next call to simulate a transient Redis failure
    probe.whenCalled().thenReject(new Error('Redis connection lost'));

    await expect(cache.get('user:1')).rejects.toThrow('Redis connection lost');
});
```

### Intercepting and Inspecting Calls (Plumbing)

```typescript
it('intercepts a cache set', async () => {
    probe.clearBehavior(); // Stop auto-forwarding

    // Register the waiter
    const pendingPromise = probe.expectNext();

    // Trigger the cache call (e.g., via your application)
    const setPromise = cache.set({ key: 'user:1', val: { name: 'Alice' } });

    // Inspect the intercepted call
    const pending = await pendingPromise;
    expect(pending.method).toBe('set');
    expect(pending.args[0]).toMatchObject({ key: 'user:1' });

    // Forward it to the in-memory store
    pending.forward();
    await setPromise;
});
```

## API

### `createProbedCache()`

Returns a `ProbedCache` object containing the cache implementation and its probe.

### `InMemoryCache` (The Boundary)

The interface your application should depend on:

- `get<T>(key: CacheKeyInput): Promise<T | null>`
- `set<T>(input: { key: CacheKeyInput; val: T }, ttlMs?: number): Promise<boolean>`
- `del(key: CacheKeyInput): Promise<void>`
- `setnx<T>(input: { key: CacheKeyInput; val: T }, options?: { mode?: 'PX' | 'EX'; ttl: number }): Promise<T>`
- `getSet<T>(cacheKey: CacheKeyInput, apiFunc: () => Promise<T>, options?: { ttl?: number | ((result: T) => number) }): Promise<T>`

### `CacheProbe`

The probe API follows the same Porcelain/Plumbing pattern as `DbProbe` in `@vnatures/test-kit-pg-kysely`, with method names contextualised for cache calls:

- **Porcelain:** `alwaysForward()`, `alwaysReject(error)`, `whenCalled().thenForward()`, `whenCalled().thenReject(error)`, `clearBehavior()`
- **Plumbing:** `expectNext()`, `expectMatching(predicate)`
- **Observation:** `calls`, `pendingCount()`
- **Drain helpers:** `drainAndForwardAll()`, `drainAndRejectAll(error?)`
