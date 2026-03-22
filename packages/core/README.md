# @vnatures/test-kit (Core)

This is the core package of the test-kit ecosystem. It provides the foundational `createProbePair` utility for creating probed fakes of standard TypeScript interfaces, as well as the Porcelain and Plumbing helpers used to control them.

Use this package to fake application boundaries like external REST APIs, third-party services, or internal domain services.

## Install

```bash
npm install --save-dev @vnatures/test-kit
```

## Quick Start

```typescript
import { createProbePair } from "@vnatures/test-kit";

interface UserService {
    getUser(id: number): Promise<{ id: number; name: string }>;
}

// Create a probe pair for the dependency
const { fake: userService, probe: userProbe } = createProbePair<UserService>();

// Porcelain: pre-program a response
userProbe.whenCalled("getUser").thenReturn({ id: 1, name: "Gilad" });
await expect(userService.getUser(1)).resolves.toEqual({ id: 1, name: "Gilad" });

// Plumbing: observe calls, control responses
const promise = userService.getUser(42);
const call = await userProbe.expectNext();
expect(call.method).toBe("getUser");
expect(call.args).toEqual([42]);
call.answer({ id: 42, name: "Neo" });
await expect(promise).resolves.toEqual({ id: 42, name: "Neo" });
```

## Building a Component Harness

A component harness wires your real application with test-kit fakes. This pattern allows you to test the actual application logic while maintaining full control over its boundaries.

```typescript
import { createProbePair } from "@vnatures/test-kit";
import supertest from "supertest";
import { App } from "../src/app";
import { IUserService, IPaymentService } from "../src/interfaces";

// 1. Define a harness creation function
export async function createTestHarness() {
    // Create probe pairs for external boundaries
    const { fake: users, probe: usersProbe } = createProbePair<IUserService>();
    const { fake: payments, probe: paymentsProbe } = createProbePair<IPaymentService>();

    // Inject fakes into the real application wiring
    const app = App.init({
        services: { users, payments }
    });

    // Return the app and the probes
    return { app, usersProbe, paymentsProbe };
}

// 2. Use the harness in your tests
it("tests the component checkout flow", async () => {
    const { app, usersProbe, paymentsProbe } = await createTestHarness();
    
    // Pre-program the user service (Porcelain) — Alice will be returned for any getUser call
    usersProbe.alwaysReturn("getUser", { id: 1, name: "Alice" });
    
    // Trigger the application
    const reqPromise = supertest(app).post("/checkout").send({ userId: 1, amount: 100 }).then(r => r);
    
    // Intercept the payment call (Plumbing)
    const paymentCall = await paymentsProbe.expectNext();
    expect(paymentCall.method).toBe("charge");
    expect(paymentCall.args[0]).toBe(100);
    
    // Provide a response
    paymentCall.answer({ success: true });
    
    // Await the final application response
    const response = await reqPromise;
    expect(response.status).toBe(200);
});
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

### Porcelain Methods on `TestProbe`

**One-shot** (consumed after one call):

```typescript
probe.whenCalled("method").thenReturn(value);
probe.whenCalled("method").thenReject(error);
probe.whenCalled("method").thenCall((...args) => computedResult);
```

**Permanent** (repeats forever, lower priority than one-shot):

```typescript
probe.alwaysReturn("method", value);
probe.alwaysReject("method", error);
probe.alwaysCall("method", (...args) => computedResult);
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
    const { service, usersProbe, productsProbe, paymentsProbe } = createHarness();

    // These are preconditions, not what we're testing
    usersProbe.alwaysReturn("getUser", testUser);
    productsProbe.alwaysReturn("getProduct", testProduct);
    productsProbe.alwaysReturn("reserveStock", true);

    // This is what we're testing — a one-shot rejection for the next charge call
    paymentsProbe.whenCalled("charge").thenReturn({ success: false, error: "declined" });

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
