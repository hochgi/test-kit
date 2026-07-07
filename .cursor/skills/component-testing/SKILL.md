---
name: component-testing
description: >-
  Guide for writing component tests using @vnatures/test-kit (v1.0.0) with
  probed adapters. Covers Goldilocks boundary design, harness patterns,
  retry/timeout/partial-failure recipes, streaming/async-generator boundaries
  (createProbedStreamMock), and fake-timer interop. Use when creating or
  refactoring component tests, extracting application boundaries, or writing
  test harnesses.
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
where production code meets the outside world, and where tests inject
adapters. Choosing the wrong abstraction level makes tests awkward or defeats
their purpose.

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

**Using `@vnatures/test-kit-pg-kysely`:** the package exposes
`createProbedKyselyAdapter` which gives you a real PGlite-backed
`Kysely<Database>` plus a `QueryProbe` to intercept queries. In tests,
override the DI token with `db.adapter`. Default rule is `always().forward()`
so bootstrap, seed, and reset run transparently. Useful idioms:

- `db.probe.always().reject(new Error('outage'))` — simulate DB outage on
  every query.
- `db.probe.once().reject(new Error('transient'))` — one-shot query failure
  before the default-forward resumes.
- `db.probe.expect.intercept()` (optionally chained off `.filter(...)`) —
  pull a query in flight, inspect it, then `forward()` to PGlite or
  `reject()`.
- `db.probe.queries` — read-only array of every recorded
  `{ sql, parameters }` for shape assertions.
- `db.seed`, `db.reset`, `db.close` use an unprobed maintenance connection
  so cleanup is never blocked by probe rules.

**Example — Postgres with Knex:**

Inject `Knex` (or your DI token for it) as the boundary — same Goldilocks idea as
Kysely: not raw `pg.Pool`, not a fat repository facade that hides every query.
`@vnatures/test-kit-pg-knex` provides `createProbedKnexAdapter` with the same
probe API as Kysely. Pass `knexConfig` when production uses plugins such as
`knex-stringcase` so tests match runtime column naming.

**Example — streaming boundary (LLM token stream, log tail, etc.):** a method
typed `(...) => AsyncIterable<T>` (often an `async *stream()` generator) is
not a Promise boundary — it yields zero or more chunks over time, then
completes or fails. `createProbedMock` can't take this shape (it settles once
via a Promise); use `createProbedStreamMock` instead. See "Streaming
Boundaries" below.

If the real dependency is a concrete class the component constructs via
`new` (not a plain interface it receives via DI), inject a thin subclass
that delegates to the mock's `adapter` — same Goldilocks idea as injecting
`Kysely` instead of wrapping it, just applied to a class-shaped seam:

```typescript
// Strands' Model is an abstract class, not an interface — createProbedStreamMock
// produces a plain object, so wrap it in a subclass that satisfies `instanceof Model`.
class ProbedModel extends Model<BaseModelConfig> {
    constructor(private readonly adapter: Pick<Model<BaseModelConfig>, 'stream'>) {
        super();
    }
    updateConfig(): void {}
    getConfig(): BaseModelConfig { return {}; }
    stream(messages: Message[], options?: StreamOptions) {
        return this.adapter.stream(messages, options);
    }
}
```

**Example — Postgres with Sequelize:**

Inject `Sequelize` as the boundary. `@vnatures/test-kit-pg-sequelize` provides
`createProbedSequelizeAdapter`; pass `models` (sequelize-typescript classes)
or a raw `bootstrap` to set up the schema, and the same `QueryProbe` API
applies.

**Probe types:** `QueryProbe`, `QueryCall`, and `QueryPendingCall` live in
`@vnatures/test-kit-sql` and are re-exported from each `pg-*` package. Import
from the pg package that matches your stack; import from `-sql` only if you
wire a custom DB layer around `SqlDriver`.

### Decision checklist

Before extracting a boundary, ask:

1. Does it expose protocol details (status codes, headers, raw buffers)?
   → too thin.
2. Does it implement retry, timeout, or orchestration?
   → too fat.
3. Can a test program the adapter without conjuring infrastructure artifacts?
   → sweet spot.
4. Is `withTimeout()` on the call site or inside the boundary?
   Keep it on the call site so a probe that parks genuinely triggers the
   real timeout.

---

## Harness Factory Pattern

Every component test file has a companion harness that constructs the real
component with all leaf boundaries probe-faked. Use a single `Harness`
instance per test for shared timeouts, lifecycle, and cross-probe
expectations.

```typescript
import { createHarness, type Harness } from '@vnatures/test-kit';
import { createProbedMock, type MethodProbe } from '@vnatures/test-kit-mock';

function createMyHarness() {
    const tk = createHarness();

    const dep1 = tk.attach(createProbedMock<IDep1>({
        harness: tk,
        methods: ['fetchThing', 'sendThing'],
    }));
    const dep2 = tk.attach(createProbedMock<IDep2>({
        harness: tk,
        methods: ['publish'],
    }));

    const service = new MyService({
        dep1: dep1.adapter,
        dep2: dep2.adapter,
    });

    return {
        service,
        dep1Probe: dep1.probe,
        dep2Probe: dep2.probe,
        harness: tk,
    };
}
```

Key conventions:

- **Disposable:** each `it` block creates its own harness. Call
  `harness.close()` in `afterEach` (or `try/finally`) so attached resources
  tear down LIFO.
- **Leaf boundaries only:** probe-fake leaf dependencies (the external seams).
  Composite services that orchestrate other services are constructed from
  adapters, not faked themselves — their real logic is what you are testing.
- **Explicit `methods`:** `createProbedMock` requires the async method
  allowlist on `T`. Sync methods are rejected at compile time with a branded
  error; for sync deps, use the real implementation.
- **Destructured return:** keep call sites readable —
  `const { service, dep1Probe, dep2Probe } = createMyHarness()`.

---

## Probe API Quick Reference

`probe.on('methodName')` returns a typed selection. From there you program a
rule (porcelain) or pull a call (plumbing).

### Porcelain (pre-programmed happy path)

```typescript
// Permanent rule — repeats indefinitely (lower priority than one-shots).
probe.on('methodName').always().answer(returnValue);
probe.on('methodName').always().reject(new Error('fail'));
probe.on('methodName').always().answerWith((c) => computeResult(c.args));
```

### Plumbing rules (one-shot, FIFO)

```typescript
probe.on('methodName').once().answer(value);
probe.on('methodName').once().reject(new Error('once'));
probe.on('methodName').once().answerWith((c) => result(c.args));
```

One-shot rules are consumed first-in-first-out. Once exhausted, any
permanent rule takes over. A one-shot always wins over a permanent rule.

### Interactive call control (plumbing — in-flight inspection)

`probe.expect.intercept()` (optionally chained off `.on(...)` or
`.filter(...)`) returns a `MethodPendingCall` while the call is still in
flight. The component is blocked until you respond.

```typescript
import { milliseconds } from '@vnatures/test-kit';

// Wait for the next call to `download` and answer it.
const call = await probe.on('download').expect.intercept();
expect(call.args[0]).toBe('https://example.com/img.png');
call.answer({ buffer: Buffer.from('ok'), contentType: 'image/png' });

// Filter a captured call by argument predicate.
const specific = await probe
    .on('download')
    .filter((c) => c.args[0] === 'https://example.com/specific.png', 'url=specific.png')
    .expect.intercept({ within: milliseconds(500) });
specific.answer(result);

// Reject an in-flight call to simulate a network error.
const failing = await probe.on('download').expect.intercept();
failing.reject(new Error('ECONNRESET'));
```

Use `expect.observe()` instead of `expect.intercept()` when you only want to
inspect the call shape and let an existing rule answer it (observers are
notify-only and fire before rules — tier 1a vs tier 2 in resolution order).

**Timeout by not answering:** if you never call `answer()` or `reject()` on
a captured pending call, the component's `withTimeout()` wrapper (on the
call site) will fire after the configured duration. Combined with
`harness.clock.advance(...)`, this is the cleanest way to test timeout
behavior — no manual deferred-promise plumbing needed.

### Negative and cardinality assertions

```typescript
import { milliseconds } from '@vnatures/test-kit';

// Fail if any call to 'delete' arrives in the next 100ms.
await probe.on('delete').expect.none({ within: milliseconds(100) });

// Cardinality.
await probe.on('publish').expect.atLeast(2);
await probe.on('publish').expect.exactly(3);
```

### Post-hoc assertions

```typescript
expect(probe.calls).toHaveLength(2);
expect(probe.calls[0].method).toBe('download');
expect(probe.calls[0].args[0]).toBe('https://example.com/img.png');
```

---

## Streaming Boundaries: `createProbedStreamMock`

For methods shaped `(...) => AsyncIterable<TChunk>` — `createProbedMock`
requires a Promise-returning method and rejects generator methods at
compile time. Use the sibling factory from `@vnatures/test-kit-mock`:

```typescript
import { createProbedStreamMock } from '@vnatures/test-kit-mock';

const model = tk.attach(createProbedStreamMock<Model>({
    harness: tk,
    methods: ['stream'],
}));
```

### Porcelain

```typescript
// Replay a scripted sequence, then end normally.
model.probe.on('stream').always().answer([chunkA, chunkB]);

// Derive chunks from the call; yield then throw to simulate a mid-stream
// failure (e.g. a provider disconnect) after some chunks were delivered.
model.probe.on('stream').once().answerWith(async function* (call) {
    yield chunkFor(call.args[0]);
    throw new Error('connection dropped');
});

// Fail before any chunk is pushed.
model.probe.on('stream').once().reject(new Error('unauthorized'));

// Never close — consumption hangs (for timeout tests, paired with clock.advance).
model.probe.on('stream').always().park();
```

### Plumbing — interactive push/end/error

The pending call exposes `push`/`end`/`error` instead of `answer`/`reject`,
so a test can drive the consumer's `for await` one chunk at a time:

```typescript
const pending = await model.probe.on('stream').expect.intercept();
expect(pending.args[0]).toEqual(expectedMessages);

pending.push(chunkA);
// ...assert on whatever side effect the SUT produced from chunkA...
pending.push(chunkB);
pending.end(); // or pending.error(new Error('...')) for a mid-stream failure
```

`pending.settled` flips to `true` only after `end()`/`error()` — `push()`
remains legal (and required, for chunks after the first) until then.
Everything else — `.filter(...)`, retroactive `intercept()`, `expect.none`,
`expect.atLeast`/`exactly`, cross-probe `harness.expect.sequence` — works
identically to the Promise-based probe; only the settlement verbs differ.

## When to Extract a Boundary (Refactoring Trigger)

If a component mixes calls to injected boundary services (or just regular
business logic like parsing/caching/validating/etc.) with **inlined
infrastructure calls** (e.g. a private `axios.get`, a raw `fetch`, and
sometimes even a direct `fs.readFile`), the inlined call is an unfakeable
seam. This blocks component testing.

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
try {
    probe.on('download').once().reject(new Error('ECONNRESET'));
    probe.on('download').once().answer(successResult);

    let caught: unknown;
    const promise = service.doWork().catch((e) => { caught = e; });

    // Advance past the retry backoff delay
    await jest.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBeDefined();
    expect(probe.calls).toHaveLength(2);
} finally {
    jest.useRealTimers();
}
```

### Timeout: probe parks, real withTimeout fires

```typescript
jest.useFakeTimers();
try {
    // Probe never answers — call parks indefinitely
    probe.on('download').always().answerWith(() => new Promise<never>(() => {}));

    let caught: unknown;
    const promise = service.doWork().catch((e) => { caught = e; });

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
    await promise;

    expect(caught).toBeInstanceOf(TimeoutError);
} finally {
    jest.useRealTimers();
}
```

This only works when `withTimeout()` wraps the probe call **on the call site**
(not inside the boundary). That is why timeouts stay outside the boundary.

### Partial failure: discriminate by argument

```typescript
probe.on('download').always().answerWith((c) => {
    const url = c.args[0] as string;
    if (url.includes('bad')) return Promise.reject(new Error('fail')) as never;
    return Promise.resolve(successResult) as never;
});
```

### Concurrent fan-out: independent probe programming

Each boundary is pre-programmed independently via `on(method).always().answer(...)`.
Execution order does not matter — no fragile positional `mockResolvedValueOnce`
chains. For order-sensitive scenarios, capture each call with
`.filter(...).expect.intercept()` and answer them in any order.

### No-retry on validation errors: assert call count

```typescript
probe.on('download').always().answer({ buffer: oversizedBuffer, contentType: 'image/png' });

await expect(service.doWork()).rejects.toThrow();

// Validation error was not retried — only one attempt
expect(probe.calls).toHaveLength(1);
```

### Cross-probe ordering

```typescript
import { milliseconds } from '@vnatures/test-kit';

// Wait for a sequence across probes; fails fast on out-of-order or missing.
await harness.expect.sequence([
    authProbe.on('verifyToken'),
    usersProbe.on('getUser'),
    paymentsProbe.on('charge'),
], { within: milliseconds(2_000) });
```

---

## Fake Timer Interop

- The harness auto-detects `vi.useFakeTimers()` and `jest.useFakeTimers()`.
  Use `harness.clock.advance(duration)` (or the test runner's
  `advanceTimersByTimeAsync`) to drive the SUT's timers.
- `expect.intercept` / `expect.observe` deadlines run on real wall-clock
  time, so a forgotten `clock.advance` produces a clean timeout diagnostic
  instead of a 30-second hang.
- Always use the **async** advance variant
  (`jest.advanceTimersByTimeAsync` / `harness.clock.advance`) so microtask
  continuations flush between timer ticks.
- Attach a `.catch()` handler (or set up the `.rejects.toThrow` assertion)
  on the promise **before** advancing timers, otherwise the rejection can
  surface as a transient unhandled rejection between the timer firing and
  the test's `await`.

```typescript
jest.useFakeTimers();
try {
    let caught: unknown;
    const promise = service.doWork().catch((e) => { caught = e; });

    await jest.advanceTimersByTimeAsync(delayMs);
    await promise;

    // Now assert on `caught` or the resolved value.
} finally {
    jest.useRealTimers();
}
```
