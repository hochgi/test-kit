---
name: component-testing
description: >-
  Guide for writing component tests using @vnatures/test-kit with probed fakes.
  Covers Goldilocks boundary design, harness patterns, retry/timeout/partial-failure
  recipes, and fake-timer interop. Use when creating or refactoring component tests,
  extracting application boundaries, or writing test harnesses.
---

# Component Testing with test-kit

## When to use component tests

Use component tests when the interesting behavior IS the interaction with
external boundaries: retry logic, timeout handling, concurrent fan-out,
partial failure, error-type discrimination. If the code under test is pure
logic with no boundaries, a plain unit test is sufficient.

---

## The Goldilocks Principle for Application Boundaries

Every external dependency needs an application boundary interface — the seam
where production code meets the outside world, and where tests inject fakes.
Choosing the wrong abstraction level makes tests awkward or defeats their purpose.

### Too Thin

Raw infrastructure: HTTP client, DB driver, socket.

- Tests must construct protocol-level artifacts (raw HTTP responses, status
  codes, connection objects).
- Boundary leaks implementation details into the component.

**Example:** Injecting raw `axios` or `pg.Pool`.

### Too Fat

High-level service that bundles retry, batching, orchestration, or business rules.

- Moves the interesting logic *outside* the component under test.
- The component becomes a trivial pass-through — nothing meaningful to test.

**Example:** `IImageService.downloadWidgetImages(widgets)` that handles retry
and batching internally, or `IPostgresService` that wraps every query behind
a method.

### Just Right

The narrowest interface that hides infrastructure while leaving all application
logic (retry, timeout, validation, orchestration) inside the component.

**Example — image download:**

```typescript
interface IImageDownloader {
    download(url: string): Promise<{ buffer: Buffer; contentType: string }>;
}
```

The component still owns retry, `withTimeout()`, MIME/size validation, and
batch orchestration. Tests can program the probe without conjuring raw HTTP
responses.

**Example — Postgres with Kysely (or any ORM query builder):**

Inject `Kysely<Database>` directly (via a DI token). Too thin would be
`pg.Pool`; too fat would be `IPostgresService` wrapping queries behind methods.

A common anti-pattern is a `PostgresService` class that owns the `Kysely`
instance and exposes it (or wraps it) to repositories. This class *inlines*
the boundary: repositories depend on the wrapper instead of the query builder
itself. The tell-tale sign:

```typescript
// Anti-pattern: wrapper class that inlines the boundary
class PostgresService {
    private db: Kysely<Database>;
    async onModuleInit() { this.db = new Kysely(...); }
    get query() { return this.db; }
    async healthCheck() { await sql`SELECT 1`.execute(this.db); }
}

class WidgetRepository {
    constructor(private pg: PostgresService) {} // ← depends on wrapper
    findAll() { return this.pg.query.selectFrom('widgets')...; }
}
```

The fix: inject `Kysely<Database>` as the boundary token. Both repositories
and health checks depend on the same `Kysely<Database>` — confirming it is
the right leaf dependency. `PostgresService` becomes a provider that creates
the `Kysely` instance and exposes it through DI, but consumers never depend
on `PostgresService` itself.

**Using `test-kit-pg-kysely`:** The `@vnatures/test-kit-pg-kysely` package
provides `createProbedTestDb` which gives you a real PGlite-backed
`Kysely<Database>` plus a `DbProbe` to intercept queries. In tests, override
the DI token with the probed instance. Key APIs:

- `alwaysForward()` — pass queries through to PGlite (default happy path).
- `alwaysReject(error)` — simulate DB outage on every query.
- `whenQueried().thenReject(error)` — one-shot query failure (e.g. first
  query fails, subsequent ones succeed via `alwaysForward`).
- `expectNext()` / `expectMatching()` — intercept a query in flight, inspect
  it, then `forward()` to PGlite or `reject()`.
- Maintenance operations (`bootstrap`, `seed`, `reset`) use an unprobed
  connection so they are never affected by probe behavior.

**Example — Postgres with Knex:**

Inject `Knex` (or your DI token for it) as the boundary — same Goldilocks idea as
Kysely: not raw `pg.Pool`, not a fat repository facade that hides every query.

**Using `test-kit-pg-knex`:** `@vnatures/test-kit-pg-knex` provides
`createProbedTestDb`, which returns a PGlite-backed `Knex` instance plus the same
`DbProbe` API as Kysely (`alwaysForward`, `alwaysReject`, `whenQueried`,
`expectNext`, `expectMatching`, `clearBehavior`). Pass `knexConfig` when production
uses plugins such as `knex-stringcase` so tests match runtime column naming.
For tests that only need an isolated in-memory DB without intercepting queries,
use `createTestDb` instead of `createProbedTestDb`.

**`DbProbe` and types:** `DbProbe`, `QueryCall`, and `PendingQuery` live in
`@vnatures/test-kit` and are re-exported from `@vnatures/test-kit-pg-kysely` and
`@vnatures/test-kit-pg-knex`. Import from the pg package that matches your stack;
import from core only if you wire a custom DB layer around `DbProbe.recordQuery`.

### Decision checklist

Before extracting a boundary, ask:

1. Does it expose protocol details (status codes, headers, raw buffers)?
   → too thin.
2. Does it implement retry, timeout, or orchestration?
   → too fat.
3. Can a test program the fake without conjuring infrastructure artifacts?
   → sweet spot.
4. Is `withTimeout()` on the call site or inside the boundary?
   Keep it on the call site so a probe that parks genuinely triggers the
   real timeout.

---

## Harness Factory Pattern

Every component test file has a companion harness that constructs the real
component with all leaf boundaries probe-faked.

```typescript
import { createProbePair } from '@vnatures/test-kit';

function createMyHarness() {
    const { fake: dep1, probe: dep1Probe } = createProbePair<IDep1>();
    const { fake: dep2, probe: dep2Probe } = createProbePair<IDep2>();

    const service = new MyService({ dep1, dep2 });

    return { service, dep1Probe, dep2Probe };
}
```

Key conventions:

- **Disposable:** each `it` block creates its own harness. No shared state
  between tests.
- **Leaf boundaries only:** probe-fake leaf dependencies (the external seams).
  Composite services that orchestrate other services are constructed from fakes,
  not faked themselves — their real logic is what you are testing.
- **Destructured return:** `const { service, dep1Probe, dep2Probe } = createMyHarness()`.

---

## Probe API Quick Reference

### Porcelain (pre-programmed happy path)

```typescript
probe.alwaysReturn('methodName', returnValue);
probe.alwaysReject('methodName', new Error('fail'));
probe.alwaysCall('methodName', (...args) => computeResult(args));
```

### Plumbing (one-shot behaviors, consumed in order)

```typescript
probe.whenCalled('methodName').thenReturn(value);
probe.whenCalled('methodName').thenReject(new Error('once'));
probe.whenCalled('methodName').thenCall((...args) => result);
```

One-shot behaviors are consumed first-in-first-out. Once exhausted, the
permanent behavior (if any) takes over.

### Interactive call control (Plumbing — in-flight inspection)

`expectNext()` and `expectMatching()` return a `PendingCall` that lets you
inspect or answer the call while it is still in flight. The component is
blocked until you respond.

```typescript
// Wait for the next call (any method) and answer it
const call = await probe.expectNext();
expect(call.method).toBe('download');
expect(call.args[0]).toBe('https://example.com/img.png');
call.answer({ buffer: Buffer.from('ok'), contentType: 'image/png' });

// Wait for a specific call by predicate
const call = await probe.expectMatching((c) => c.args[0] === 'https://example.com/specific.png');
call.answer(result);

// Reject an in-flight call to simulate a network error
const call = await probe.expectNext();
call.reject(new Error('ECONNRESET'));
```

**Timeout by not answering:** If you never call `answer()` or `reject()` on
a `PendingCall`, the component's `withTimeout()` wrapper (on the call site)
will fire after the configured duration. Combined with fake timers, this
is the cleanest way to test timeout behavior — no manual deferred-promise
plumbing needed.

### Post-hoc assertions

```typescript
expect(probe.calls).toHaveLength(2);
expect(probe.calls[0].method).toBe('download');
expect(probe.calls[0].args[0]).toBe('https://example.com/img.png');
```

---

## When to Extract a Boundary (Refactoring Trigger)

If a component mixes calls to injected boundary services (or just regular buisiness logic like parsing/caching/validating/etc'…) with **inlined
infrastructure calls** (e.g. a private `axios.get`, a raw `fetch`, and sometimes even a direct
`fs.readFile`), the inlined call is an unfakeable seam. This blocks
component testing.

### The signal

You are writing (or want to write) a component test, and one of the external
calls cannot be probe-faked because it is hardwired inside the component:

```typescript
class MyService {
    constructor(private reportService: IReportService) {} // ← fakeable
    async doWork() {
        const report = await this.reportService.get(id); // ← fakeable
        const image = await axios.get(url);               // ← NOT fakeable
    }
}
```

### The fix

1. Define an interface at the Goldilocks level (see checklist above).
2. Create a thin production implementation that wraps the inlined call.
3. Accept the new interface in the constructor alongside existing deps.
4. Wire the production implementation in the service composition root.
5. Update existing unit tests to pass a `jest.fn()`-based mock of the new
   interface instead of using `jest.mock('module')` globally.

This is a mechanical refactoring — it does not change any behavior. The diff
should be small: one new interface, one thin class, and a constructor
parameter addition.

### Rule of thumb

Every external I/O call in a component should flow through an injected
interface. If you see `import axios`, `import fetch`, `import fs`, or similar
**inside a service that also accepts injected dependencies**, that is a
boundary extraction opportunity.

---

## Recipes

### Retry: first call fails, second succeeds

```typescript
jest.useFakeTimers();

probe.whenCalled('download').thenReject(new Error('ECONNRESET'));
probe.whenCalled('download').thenReturn(successResult);

let caught: unknown;
const promise = service.doWork().catch((e) => { caught = e; });

// Advance past the retry backoff delay
await jest.advanceTimersByTimeAsync(1000);

const result = await promise;
expect(result).toBeDefined();
expect(probe.calls).toHaveLength(2);

jest.useRealTimers();
```

### Timeout: probe parks, real withTimeout fires

```typescript
jest.useFakeTimers();

// Probe never answers — call parks indefinitely
probe.alwaysCall('download', () => new Promise<never>(() => {}));

let caught: unknown;
const promise = service.doWork().catch((e) => { caught = e; });

await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
await promise;

expect(caught).toBeInstanceOf(TimeoutError);

jest.useRealTimers();
```

This only works when `withTimeout()` wraps the probe call **on the call site**
(not inside the boundary). That is why timeouts stay outside the boundary.

### Partial failure: discriminate by argument

```typescript
probe.alwaysCall('download', (...args: unknown[]) => {
    const url = args[0] as string;
    if (url.includes('bad')) return Promise.reject(new Error('fail'));
    return Promise.resolve(successResult);
});
```

### Concurrent fan-out: independent probe programming

Each boundary is pre-programmed independently via `alwaysReturn`. Execution
order does not matter — no fragile positional `mockResolvedValueOnce` chains.

### No-retry on validation errors: assert call count

```typescript
probe.alwaysReturn('download', { buffer: oversizedBuffer, contentType: 'image/png' });

await expect(service.doWork()).rejects.toThrow();

// Validation error was not retried — only one attempt
expect(probe.calls).toHaveLength(1);
```

---

## Fake Timer Interop

- Always use `jest.advanceTimersByTimeAsync()` (not the sync version) to ensure
  microtask continuations flush between timer ticks.
- Attach a `.catch()` handler to the promise **before** advancing timers to
  prevent unhandled rejection warnings.
- Pattern:

```typescript
jest.useFakeTimers();

let caught: unknown;
const promise = service.doWork().catch((e) => { caught = e; });

await jest.advanceTimersByTimeAsync(delayMs);
await promise;

// Now assert on `caught` or the resolved value.
jest.useRealTimers();
```
