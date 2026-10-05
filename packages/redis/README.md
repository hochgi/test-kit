# @hochgi/test-kit-redis

In-memory cache adapter for component tests, backed by `ioredis-mock`
behind a focused `CacheAdapter` interface.

## Why a focused cache interface?

The right boundary for a cache is **not** the raw Redis network
protocol (too low-level, infra-fragile) and **not** a sprawling
`IRedisClient` exposing hundreds of commands (too broad, ties your
application logic to a specific driver). The just-right seam is a
domain-agnostic interface — `get` / `set` / `del` / `setnx` / `getSet`
— that production wires into either Redis or anything else.

This package provides that interface (`CacheAdapter`) and a
probe-driven adapter for it.

## Install

```bash
npm install --save-dev @hochgi/test-kit @hochgi/test-kit-redis
```

## Quick start

```typescript
import { createRig } from "@hochgi/test-kit";
import { createProbedCacheAdapter } from "@hochgi/test-kit-redis";

const rig = createRig();
const cache = rig.attach(createProbedCacheAdapter({ harness: rig }));

// Default rule is forward — calls pass through to the in-memory store.
await cache.adapter.set({ key: "user:1", val: { name: "Alice" } });
const user = await cache.adapter.get<{ name: string }>("user:1");
expect(user).toEqual({ name: "Alice" });

await rig.close();
```

## What the adapter returns

```typescript
const { adapter, probe, close } = createProbedCacheAdapter({ harness: rig });
```

- `adapter: CacheAdapter` — inject this into production wiring. Default
  rule forwards to the in-memory store, so production code "just works"
  without any test programming.
- `probe: CacheProbe` — `.on(method)`, `.calls`,
  `.expect.*`, `.drain()`, `.drainAndReject(error)`.
- `close()` — disposes the underlying store. Handled automatically by
  `rig.close()` if attached.

## The `CacheAdapter` interface

```typescript
interface CacheAdapter {
    get<T>(key: CacheKeyInput): Promise<T | null>;
    set<T>(input: { key: CacheKeyInput; val: T }, ttl?: Duration): Promise<boolean>;
    del(key: CacheKeyInput): Promise<void>;
    setnx<T>(input: { key: CacheKeyInput; val: T }, options: { readonly ttl: Duration }): Promise<T>;
    getSet<T>(
        key: CacheKeyInput,
        load: () => Promise<T>,
        options?: { readonly ttl?: Duration | ((result: T) => Duration) },
    ): Promise<T>;
}
```

## Programming cache calls

```typescript
// Simulate a transient Redis failure for the next call.
cache.probe.on("get").once().reject(new Error("connection lost"));

// Reject every set indefinitely.
cache.probe.on("set").always().reject(new Error("read-only mode"));

// Plumbing — capture and forward manually.
const promise = cache.adapter.set({ key: "user:1", val: { name: "Alice" } });
const pending = await cache.probe.on("set").expect.intercept();
expect(pending.args[0]).toMatchObject({ key: "user:1" });
pending.forward();
await promise;
```

`cache.probe.calls` is a read-only array of every recorded call,
useful for shape assertions.

## See also

- [`@hochgi/test-kit-mock`](../mock/README.md) for non-cache
  boundaries.
- [`docs/api-surface.md`](../../docs/api-surface.md) for the full probe
  reference.
