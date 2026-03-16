# @vnatures/test-kit

Probe-driven component testing for TypeScript services. Test real components with full control over every external dependency — deterministically, efficiently, and without real infrastructure.

## Packages

| Package | Description | Status |
| :--- | :--- | :---: |
| `@vnatures/test-kit` | Core: probe pairs, porcelain helpers | Published |
| `@vnatures/test-kit-redis` | In-memory Redis cache (ioredis-mock wrapper) | Published |

## Install

```bash
npm install --save-dev @vnatures/test-kit
```

## Quick Start

```typescript
import { createProbePair, whenCalled } from "@vnatures/test-kit";

interface UserService {
    getUser(id: number): Promise<{ id: number; name: string }>;
}

// Create a probe pair for the dependency
const { fake: userService, probe: userProbe } = createProbePair<UserService>();

// Porcelain: pre-program a response
whenCalled(userService, "getUser").thenReturn({ id: 1, name: "Gilad" });
await expect(userService.getUser(1)).resolves.toEqual({ id: 1, name: "Gilad" });

// Plumbing: observe calls, control responses
const promise = userService.getUser(42);
const call = await userProbe.expectNext();
expect(call.method).toBe("getUser");
expect(call.args).toEqual([42]);
call.answer({ id: 42, name: "Neo" });
await expect(promise).resolves.toEqual({ id: 42, name: "Neo" });
```

## Core Concepts

### Probe Pair

A **probe pair** is `{ fake, probe }` created together for a single dependency interface.

- The **fake** implements the dependency interface via ES Proxy. Inject it into the component under test in place of the real implementation.
- The **probe** is the test-facing handle. It lets you observe what the component sent to the dependency and control what comes back.

```typescript
const { fake, probe } = createProbePair<MyService>();
```

### Dependency Seam

An interface boundary between the component's business logic and an external concern (DB, HTTP, Kafka, cache, clock). Most services already have these — e.g. `IServices` in Express apps, or Nest module providers.

### Component Harness

A per-repo setup function that wires the component with probe-backed fakes via the existing initialization path:

```typescript
function createTestHarness() {
    const { fake: users, probe: usersProbe } = createProbePair<UserService>();
    const { fake: orders, probe: ordersProbe } = createProbePair<OrderService>();

    const app = App.init({
        services: { users, orders } as IServices,
        config: testConfig,
    });

    return { app, usersProbe, ordersProbe };
}
```

### Porcelain vs Plumbing

**Porcelain** (simple, pre-programmed) — for dependencies you're not directly testing:

```typescript
whenCalled(userService, "getUser").thenReturn(testUser);
alwaysReturn(userService, "getUser", testUser);  // permanent
```

**Plumbing** (observe, then respond) — for the dependency interactions you're actually testing:

```typescript
const call = await probe.expectNext();
expect(call.args).toEqual([expectedArgs]);
call.answer(responseData);
```

## API Reference

### `createProbePair<T>()`

Creates a fake + probe pair for interface `T`.

```typescript
const { fake, probe } = createProbePair<MyService>();
```

- `fake: T` — Proxy-based object. Any method call queues the call and returns a Promise.
- `probe: TestProbe` — Test-facing handle for observing and controlling calls.

### `PendingCall`

Returned by `probe.expectNext()` and `probe.expectMatching()`.

| Property/Method | Description |
| :--- | :--- |
| `method: string` | Name of the method that was called |
| `args: unknown[]` | Arguments passed to the method |
| `settled: boolean` | Whether `answer()` or `reject()` has been called |
| `answer(value)` | Resolves the caller's Promise with `value` |
| `reject(error)` | Rejects the caller's Promise with `error` |

### `TestProbe`

| Method | Description |
| :--- | :--- |
| `expectNext(timeoutMs?)` | Returns the next unconsumed call as `PendingCall`. Blocks until a call arrives or timeout (real wall-clock time, default 5s). |
| `expectMatching(predicate, timeoutMs?)` | Returns the first unconsumed call matching `predicate`. Non-matching calls remain in the queue for later consumption. |
| `expectNoMsgWithin(ms)` | Asserts no new calls arrive within `ms` fake-clock milliseconds. Works with `jest.useFakeTimers()`. |
| `calls` | Read-only array of all recorded calls (consumed or not), for assertions. |
| `pendingCount()` | Number of unconsumed calls in the queue. |
| `drain()` | Marks all unconsumed calls as consumed (no-op on their Promises). |
| `drainWith(handler)` | Like `drain()`, but calls `handler(pendingCall)` for each unconsumed call. |
| `drainAndRejectAll(error?)` | Drains and rejects all unsettled calls. |

### Porcelain Helpers

**One-shot** (consumed after one call):

```typescript
whenCalled(fake, "method").thenReturn(value);
whenCalled(fake, "method").thenReject(error);
whenCalled(fake, "method").thenCall((args) => computedResult);
```

**Permanent** (repeats forever, lower priority than one-shot):

```typescript
alwaysReturn(fake, "method", value);
alwaysReject(fake, "method", error);
alwaysCall(fake, "method", (args) => computedResult);
```

## Patterns

### Testing Timeouts

```typescript
jest.useFakeTimers();

it("times out when downstream does not respond", async () => {
    const { app, sdoProbe } = await createTestHarness();

    const resPromise = supertest(app).get("/api/data").then(r => r);

    await sdoProbe.expectNext();          // observe the call, don't answer
    jest.advanceTimersByTime(30_000);     // advance past timeout

    const res = await resPromise;
    expect(res.status).toBe(500);
});
```

### Testing Retries

```typescript
it("retries after first failure", async () => {
    const { service, depProbe } = createHarness();

    const resultPromise = service.doWork().then(r => r);

    const first = await depProbe.expectNext();
    first.reject(new Error("temporary"));
    await Promise.resolve();

    jest.advanceTimersByTime(2_000);      // retry delay

    const second = await depProbe.expectNext();
    second.answer({ ok: true });

    await expect(resultPromise).resolves.toEqual({ ok: true });
});
```

### Out-of-Order Concurrent Calls

```typescript
it("handles parallel dep calls answered out of order", async () => {
    const { service, depProbe } = createHarness();

    const promise = service.fetchBoth(1, 2).then(r => r);

    // Answer call for id=2 first, then id=1
    const call2 = await depProbe.expectMatching(c => c.args[0] === 2);
    const call1 = await depProbe.expectMatching(c => c.args[0] === 1);
    call2.answer({ id: 2 });
    call1.answer({ id: 1 });

    const result = await promise;
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
});
```

### Negative Assertions

```typescript
it("does not publish event on validation failure", async () => {
    const { service, eventProbe } = createHarness();

    await expect(service.createOrder(badData)).rejects.toThrow();

    await eventProbe.expectNoMsgWithin(1_000);  // fake-clock milliseconds
});
```

### Precondition Fakes With `alwaysReturn`

```typescript
it("focuses on payment logic by pre-programming other deps", async () => {
    const { service, users, products, payments } = createHarness();

    // These are preconditions, not what we're testing
    alwaysReturn(users, "getUser", testUser);
    alwaysReturn(products, "getProduct", testProduct);
    alwaysReturn(products, "reserveStock", true);

    // This is what we're testing
    whenCalled(payments, "charge").thenReturn({ success: false, error: "declined" });

    await expect(service.createOrder(1, items)).rejects.toThrow("declined");
});
```

## Working with Fake Timers

`jest.useFakeTimers()` patches `Date`, `Date.now()`, `setTimeout`, `setInterval`, and by extension `moment()`, `date-fns`, etc.

**Key rule: never mix fake timers with real IO.** DB drivers, HTTP clients, etc. use timers internally — freezing them causes hangs.

Internal implementation details:

- `expectNext()` / `expectMatching()` timeout uses `realSetTimeout` (captured at module load) so it fires in real wall-clock time even under fake timers.
- `expectNoMsgWithin(ms)` advances fake timers by `ms`, then flushes microtasks via `realSetImmediate` before checking.
- The Proxy filters out `then`, `toJSON`, `toString`, etc. so fakes are safe to `await`, `JSON.stringify`, and `console.log`.

**Supertest gotcha:** when using plumbing probes with `supertest`, append `.then(r => r)` to start the request eagerly:

```typescript
const resPromise = supertest(app).get("/api/foo").then(r => r);
// now probe.expectNext() will see the call
```

## Redis Package

`@vnatures/test-kit-redis` provides an in-memory Redis cache backed by `ioredis-mock`:

```typescript
import { createInMemoryCache } from "@vnatures/test-kit-redis";

const cache = createInMemoryCache();
await cache.set({ key: "user:1", val: { name: "test" } });
const user = await cache.get<{ name: string }>("user:1");
```

Supports `set`, `get`, `del`, `setnx`, `getSet` with TTL and formatted keys. Fake-timer safe (no real IO).

## Development

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run build

# Test all packages
npm test

# Build/test a single package
npm run build --workspace=packages/core
npm test --workspace=packages/core
```
