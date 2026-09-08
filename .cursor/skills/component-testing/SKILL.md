---
name: component-testing
description: >-
  Guide for writing Vitest tests in this repository while developing
  @vnatures/test-kit. Covers Goldilocks boundary design, createRig / Rig
  lifecycle, probed adapters, retry/timeout/sequence recipes, and fake-timer
  interop. Use when adding or refactoring tests under packages/*/test.
---

# Component testing in this repository

test-kit is the **artifact under development**, not a library you are consuming
from an app. Tests live next to the package they exercise and import by
**package name**.

## Where tests live

```
packages/<name>/test/unit/         pure logic, no backing
packages/<name>/test/integration/  exercises a real in-process backing
packages/<name>/test/types/        type-level tests (core and mock only)
```

Vitest picks up `test/**/*.test.ts` from each package's `vite.config.ts`.

## Import by package name, then build

Tests import `@vnatures/test-kit`, `@vnatures/test-kit-mock`, and friends — not
relative `../src`. That resolves through a workspace symlink into `dist/`, so
**a stale build silently tests yesterday's code**:

```bash
npm run build --workspace=packages/<name> && npm test --workspace=packages/<name>
# always build first; pglite-driver has no pretest
```

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

The component still owns retry, timeout, MIME/size validation, and batch
orchestration. Tests can program the probe without conjuring raw HTTP
responses.

**Example — Postgres with Kysely:** inject `Kysely<Database>` directly. Too
thin would be `pg.Pool`; too fat would be `IPostgresService` wrapping queries
behind methods. `@vnatures/test-kit-pg-kysely` exposes
`createProbedKyselyAdapter` (real PGlite plus a `QueryProbe`). Default rule is
`always().forward()` so bootstrap, seed, and reset run transparently.

**Example — Postgres with Knex:** inject `Knex`. `@vnatures/test-kit-pg-knex`
provides `createProbedKnexAdapter`. Pass `knexConfig` when production uses
plugins such as `knex-stringcase`.

**Example — Postgres with Sequelize:** inject `Sequelize`.
`@vnatures/test-kit-pg-sequelize` provides `createProbedSequelizeAdapter`.

**Example — streaming boundary:** a method typed `(...) => AsyncIterable<T>`
is not a Promise boundary. `createProbedMock` can't take this shape; use
`createProbedStreamMock` instead.

### Decision checklist

1. Does it expose protocol details (status codes, headers, raw buffers)?
   → too thin.
2. Does it implement retry, timeout, or orchestration?
   → too fat.
3. Can a test program the adapter without conjuring infrastructure artifacts?
   → sweet spot.
4. Keep timeout on the call site so a probe that parks genuinely triggers it.

---

## Rig Factory Pattern

Every integration test file has a companion factory that constructs the real
subject with leaf boundaries probe-faked. The lifecycle owner is a **Rig**,
created by **createRig**. Close it with **`rig.close()`**.

The type is `Rig`. The factory option key on probed mocks is still `harness`
(a deliberate keep). Optional `createRig` keys:

```typescript
import { createRig, milliseconds, seconds, viFakeClock } from '@vnatures/test-kit';

const rig = createRig({
    clock: viFakeClock(),
    defaultTimeout: seconds(5),
    safetyTimeout: milliseconds(30_000),
});
```

Correct 2.x usage:

```typescript
import { createRig, type Rig } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';

function createMyRig() {
    const rig = createRig();
    const dep1 = rig.attach(createProbedMock<IDep1>({
        harness: rig,
        methods: ['fetchThing', 'sendThing'],
    }));
    const dep2 = rig.attach(createProbedMock<IDep2>({
        harness: rig,
        methods: ['publish'],
    }));

    const service = new MyService({
        dep1: dep1.adapter,
        dep2: dep2.adapter,
    });

    return { service, dep1Probe: dep1.probe, dep2Probe: dep2.probe, rig };
}
```

```typescript
const { rig } = createMyRig();

afterEach(async () => {
    await rig.close();
});
```

See `packages/mock/test/integration/rig-lifecycle.test.ts` for the real
lifecycle contract.

Key conventions:

- **Disposable:** each `it` creates its own rig. Call `rig.close()` in
  `afterEach` (or `try/finally`) so attached resources tear down LIFO. After
  close, late registration fails with `"Harness is closed."` (library error
  text — do not "fix" it).
- **Leaf boundaries only:** probe-fake leaf dependencies (the external seams).
  Composite services that orchestrate other services are constructed from
  adapters, not faked themselves — their real logic is what you are testing.
- **Explicit `methods`:** `createProbedMock` requires the async method
  allowlist on `T`. Sync methods are rejected at compile time; for sync deps,
  use the real implementation.
- **Destructured return:** keep call sites readable —
  `const { service, dep1Probe, dep2Probe, rig } = createMyRig()`.

---

## Probe API Quick Reference

`MethodProbe` and `BullQueueProbe` have `.on(method)`. QueryProbe has no .on;
it uses `.sql(...)` instead. Both inherit `filter()`. From a selection you
program a rule (porcelain) or pull a call (plumbing).

### Porcelain (pre-programmed happy path)

```typescript
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

### Interactive call control

`probe.expect.intercept()` (optionally chained off `.on(...)` or
`.filter(...)`) returns a pending call while the call is still in flight.

```typescript
import { milliseconds } from '@vnatures/test-kit';

const call = await probe.on('download').expect.intercept();
expect(call.args[0]).toBe('https://example.com/img.png');
call.answer({ buffer: Buffer.from('ok'), contentType: 'image/png' });

const specific = await probe
    .on('download')
    .filter((c) => c.args[0] === 'https://example.com/specific.png', 'url=specific.png')
    .expect.intercept({ within: milliseconds(500) });
specific.answer(result);

const failing = await probe.on('download').expect.intercept();
failing.reject(new Error('ECONNRESET'));
```

Use `expect.observe()` instead of `expect.intercept()` when you only want to
inspect the call shape and let an existing rule answer it.

**Timeout by not answering:** if you never call `answer()` or `reject()` on
a captured pending call, the component's timeout wrapper will fire.
Combined with `rig.clock.advance(...)`, this is the cleanest way to test
timeout behavior.

### Negative and cardinality assertions

`exactly` and `none` require `within`; `atLeast` may omit it.

```typescript
import { milliseconds } from '@vnatures/test-kit';

await probe.on('delete').expect.none({ within: milliseconds(100) });
await probe.on('publish').expect.atLeast(2);
await probe.on('publish').expect.exactly(3, { within: milliseconds(2_000) });
```

### Post-hoc assertions

```typescript
expect(probe.calls).toHaveLength(2);
expect(probe.calls[0].method).toBe('download');
```

### QueryProbe.sql matchers

A string matches by exact equality, a `RegExp` via `.test()`, and a function
as a predicate on the SQL text.

```typescript
db.probe.sql('SELECT * FROM users');
db.probe.sql(/INSERT INTO orders/);
db.probe.sql((sql) => sql.startsWith('INSERT'));
```

### Drain, synchronous asserts, and reset

```typescript
probe.on('publish').expect.calledTimes(1);
probe.on('publish').expect.called();
probe.on('delete').expect.neverCalled();
```

```typescript
probe.drain();
probe.drainAndReject(new Error('dropped'));
db.probe.drainAndForward();
```

```typescript
const { rig, probe } = createMyRig();
probe.clearRules();
probe.clearCalls();
probe.resetProbe();
await rig.reset({ keepRules: true });
```

---

## Streaming Boundaries: `createProbedStreamMock`

For methods shaped `(...) => AsyncIterable<TChunk>` — `createProbedMock`
requires a Promise-returning method. Use the sibling factory:

```typescript
import { createProbedStreamMock } from '@vnatures/test-kit-mock';

const rig = createRig();
const model = rig.attach(createProbedStreamMock<Model>({
    harness: rig,
    methods: ['stream'],
}));
```

### Porcelain

```typescript
model.probe.on('stream').always().answer([chunkA, chunkB]);

model.probe.on('stream').once().answerWith(async function* (call) {
    yield chunkFor(call.args[0]);
    throw new Error('connection dropped');
});

model.probe.on('stream').once().reject(new Error('unauthorized'));
model.probe.on('stream').always().park();
```

### Plumbing — interactive push/end/error

```typescript
const pending = await model.probe.on('stream').expect.intercept();
expect(pending.args[0]).toEqual(expectedMessages);

pending.push(chunkA);
pending.push(chunkB);
pending.end(); // or pending.error(new Error('...'))
```

`pending.settled` flips to `true` only after `end()`/`error()`. Cross-probe
`rig.expect.sequence` works the same as for Promise-based probes; only the
settlement verbs differ.

---

## Recipes

In-repo recipes use **Vitest**. The library auto-detects Jest timers for
*consumers*; do not copy consumer Jest timer helpers into this repository.

### Retry: first call fails, second succeeds

```typescript
const { service, probe, rig } = createMyRig();

vi.useFakeTimers();
try {
    probe.on('download').once().reject(new Error('ECONNRESET'));
    probe.on('download').once().answer(successResult);

    const promise = service.doWork();
    await rig.clock.advance(milliseconds(1000));

    const result = await promise;
    expect(result).toBeDefined();
    expect(probe.calls).toHaveLength(2);
} finally {
    vi.useRealTimers();
}
```

### Timeout: probe parks, real timeout fires

```typescript
const { service, probe, rig } = createMyRig();

vi.useFakeTimers();
try {
    probe.on('download').always().answerWith(() => new Promise<never>(() => {}));

    let caught: unknown;
    const promise = service.doWork().catch((e) => {
        caught = e;
    });

    await rig.clock.advance(milliseconds(TIMEOUT_MS + 100));
    await promise;

    expect(caught).toBeInstanceOf(TimeoutError);
} finally {
    vi.useRealTimers();
}
```

Attach a `.catch()` handler (or set up `.rejects.toThrow`) **before**
advancing timers, otherwise the rejection can surface as unhandled.

### Partial failure: discriminate by argument

```typescript
probe.on('download').always().answerWith((c) => {
    const url = c.args[0] as string;
    if (url.includes('bad')) return Promise.reject(new Error('fail')) as never;
    return Promise.resolve(successResult) as never;
});
```

### Cross-probe ordering

```typescript
import { milliseconds, observation } from '@vnatures/test-kit';

const { rig, authProbe, usersProbe, paymentsProbe, eventsProbe } = createMyRig();

eventsProbe.on('publish').always().answer(undefined);

await rig.expect.sequence(
    [
        authProbe.on('verifyToken'),
        usersProbe.on('getUser'),
        observation(eventsProbe.on('publish')),
        paymentsProbe.on('charge'),
    ],
    { within: milliseconds(2_000) },
);

await rig.expect.allOf(
    [paymentsProbe.on('charge'), eventsProbe.on('publish')],
    { within: milliseconds(2_000) },
);
```

See `packages/mock/test/integration/cross-probe-expectations.test.ts` and
`packages/mock/test/integration/timeout-retry.test.ts`.

---

## Fake Timer Interop

- Call `vi.useFakeTimers()` in `beforeEach` for in-repo tests. The rig
  auto-detects that (and, for consumers, Jest's fake timers). Drive in-repo
  SUTs with `rig.clock.advance(duration)`.
- `expect.intercept` / `expect.observe` deadlines run on real wall-clock
  time, so a forgotten `clock.advance` produces a clean timeout diagnostic
  instead of a hang.
- The two fake clocks are not interchangeable. `jestFakeClock().advance`
  uses synchronous `advanceTimersByTime` plus one `Promise.resolve()` (a
  single microtask tick). `viFakeClock().advance` prefers
  `advanceTimersByTimeAsync`. Jest consumers whose SUT chains `await`s
  between timers must `await jest.advanceTimersByTimeAsync(ms)` rather than
  relying on `rig.clock.advance` to drain those continuations.

```typescript
import { createRig, type Rig } from '@vnatures/test-kit';

let rig: Rig;

beforeEach(() => {
    vi.useFakeTimers();
    rig = createRig();
});

afterEach(async () => {
    await rig.close();
    vi.useRealTimers();
});
```
