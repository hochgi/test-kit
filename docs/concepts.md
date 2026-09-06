# Test-Kit Concepts

This document describes the mental model, vocabulary, and ergonomics test-kit
asks you to internalize. It is the right starting point if you are deciding
whether to adopt the library or trying to read existing tests fluently.

For the API reference, see [`api-surface.md`](api-surface.md). For the
package graph and what each module owns, see
[`architecture.md`](architecture.md).

The goal is to make probe-driven component testing feel like a small,
coherent testing language:

- Application code talks to injected test adapters.
- Test code talks to probes.
- Probes can observe calls, program behavior, and interact with pending calls.
- Some adapters are backed by local implementations and can forward calls.
- Some adapters are pure programmable mocks and can only answer or reject calls.

## Why This Library Exists

Component tests are most useful when the component under test is real but its
leaf boundary dependencies are controlled by the test.

A component with all of its leaf dependencies injected is similar to a runnable
graph: all input and output edges are known, and tests can attach probes at
those edges. The test does not merely assert after the fact; it can interact
with live boundary calls while the component is running. This is the property
that makes timeout, retry, partial-failure, and ordering tests tractable.

The TypeScript API should keep that power while staying easy to adopt for teams
that are used to Jest, Vitest, dependency injection, and normal `async`/`await`
code.

## Core Vocabulary

### Adapter

An adapter is the object injected into the component under test.

It implements the same boundary contract production code expects. Depending on
the boundary, it might be:

- a proxy object implementing a TypeScript interface,
- a `Kysely<DB>` instance,
- a cache interface,
- an `S3Client`,
- a thin wrapper around an SDK function.

Tests normally do not interact with the adapter directly after harness setup.
The adapter is for application code.

### Probe

A probe is the test-facing control surface for an adapter.

It records calls made to the adapter and lets the test:

- observe calls after they happened,
- wait for calls while the component is running,
- assert that calls did or did not happen within a time window,
- pre-program behavior for future calls,
- settle a pending call by answering, rejecting, or forwarding it.

The probe is the central concept of the library.

A probe is itself a *selection* over **all** calls made to its adapter. There
is no separate `any()` accessor: `probe.always().forward()` selects every call,
because the unfiltered probe already represents every call.

### Selection

A selection is a filtered view of a probe.

Every probe is a selection over all calls. `selection.filter(predicate)`
returns a narrower selection. Every operation that a probe supports
(`once()`, `always()`, `expect`, `calls`, `drain*()`) is defined on
selections, not on the probe specifically. The probe is just the
selection that does no filtering.

Selections are chainable:

```typescript
db.probe
    .filter(isWriteQuery)
    .filter((call) => call.parameters.includes(userId))
    .expect.atLeast(1, { within: seconds(1) });
```

A chain of `filter` calls is conjunctive: the resulting selection matches calls
that satisfy every predicate in the chain.

Selections are read-through views, not snapshots. A selection's `calls`
property reflects the current call history when read, not the history at the
moment the selection was constructed.

### Filter

A filter is a `(call) => boolean` predicate that narrows a selection.

Every domain probe ships **typed filter sugars** that wrap `filter` with
specialized type guards for ergonomics. For example, `methodProbe.on('charge')`
is equivalent to `methodProbe.filter((call) => call.method === 'charge')`, but
narrows the call type so that subsequent operations see the correct argument
and result types.

Domain sugars are **strictly optional**. Every domain probe must continue to
expose the underlying `filter` so users can express predicates the sugars
don't cover.

### Call

A call is a recorded interaction with an adapter.

Every domain package can shape calls in a way that fits the boundary:

- generic interface calls: `{ method, args }`,
- database calls: `{ sql, parameters }`,
- S3 calls: `{ commandName, command, input }`,
- cache calls: `{ method, args }`,
- HTTP calls: `{ method, url, headers, body }`,
- event bus calls: `{ method: "publish", args }`.

All call shapes must be plain, inspectable values. Tests should not need to
reach into private framework internals to understand what happened.

### Pending Call

A pending call is a live call that has reached the adapter but has not yet
been settled.

While a call is pending, the component is blocked on the returned promise.
The test can inspect the call and then decide what happens next:

```typescript
const call = await payments.probe.on('charge').expect.intercept();

expect(call.args).toEqual([userId, 500]);

call.answer({ success: true, transactionId: 'txn-1' });
```

Not settling a pending call is a valid testing technique. It lets the
component's own timeout, retry, or fallback logic fire naturally. Tests that
exercise these code paths should leave selected calls unsettled on purpose.

### Backing

A backing is an optional local implementation behind an adapter.

Examples:

- PGlite behind a Kysely adapter,
- `ioredis-mock` behind a cache adapter,
- an in-memory store behind an S3 adapter.

If an adapter has a backing, a pending call can usually be forwarded to it.
If an adapter has no backing, a pending call cannot forward and must be
answered or rejected by the test.

Backing is a capability, not the primary identity of the probe.

### Rule

A rule is pre-programmed behavior for future matching calls.

Rules can be one-shot or permanent:

- `once()` applies to the next matching call only.
- `always()` applies to all future matching calls.

Rules are optional. Tests can also interact with calls manually through
expectations and pending calls.

### Settlement

Settlement is the act of completing a pending call.

The supported settlement verbs are:

- `answer(value)`: resolve the caller's promise with a value.
- `answerWith(fn)`: compute an answer from the call.
- `reject(error)`: reject the caller's promise.
- `forward()`: execute the optional backing implementation.
- park intentionally: do not settle the call. Doing nothing achieves this; no
  explicit method on the pending call is required.

The API uses `answer` consistently for "resolve with a value." Domain
packages must not invent synonyms (`return`, `reply`, `respond`) for the same
operation.

This "settle once" model assumes the boundary is a Promise: one call, one
eventual value. A method typed `(...) => AsyncIterable<T>` (an `async
*stream()` generator) doesn't fit — it yields zero-or-more chunks over time,
then completes or fails. `createProbedStreamMock` (see "Stream Mock Adapter
API" in `api-surface.md`) is the sibling for that shape: the settlement
verbs become `push(chunk)` / `end()` / `error()`, and a rule describes a
sequence instead of a single value. Everything else in this document —
tiers, retroactive intercept, filters, expectations — applies unchanged;
only the verbs for "what happens to a matched call" differ.

## Test Adapter Categories

The umbrella term in general testing literature is "test double." This
library uses
"adapter" in product vocabulary because it describes how the object is used
in a hexagonal/component testing setup.

### Programmable Mock Adapter

A programmable mock adapter has no local backing implementation.

It records calls and waits for rules or explicit test control to answer or
reject them.

```typescript
const users = createProbedMock<UserService>({
    methods: ['getUser', 'updateUser'],
});

const service = new OrderService({
    users: users.adapter,
});

users.probe.on('getUser').always().answer(testUser);
```

Use this for boundaries that are plain TypeScript interfaces (REST or gRPC
clients, internal service interfaces, etc.).

### Backed Adapter

A backed adapter has a local implementation and can forward calls.

```typescript
const harness = createHarness();
const db = await harness.attach(createProbedKyselyAdapter<Database>({
    harness,
    bootstrap,
}));

const app = createApp({
    db: db.adapter,
});

// nothing else required: backed adapters install a forward rule by default.
```

Backed adapters are still probes first. The backing only defines what
`forward()` means and provides the default rule.

### Hybrid Adapter

A hybrid adapter can forward some calls and requires explicit answers for
other calls.

S3 is the canonical example. `PutObjectCommand` and `GetObjectCommand` can
forward through a local backend, while unsupported operations should fail
loudly unless the test explicitly answers them.

```typescript
const s3 = harness.attach(createProbedS3Adapter({
    harness,
    bucket: 'test-bucket',
}));

s3.probe.command(CreateMultipartUploadCommand).once().answer({
    UploadId: 'upload-1',
});
```

No hybrid adapter silently pretends to implement behavior that its backing
does not support.

### Function Boundary Adapter

Some production dependencies are standalone functions rather than objects.
An adapter can still expose an object shape if that is the cleanest
application boundary.

```typescript
const presigner = harness.attach(createProbedPresignerAdapter({ harness }));

presigner.probe.command(GetObjectCommand).always().answerWith((call) => {
    const input = call.commandInput as { Bucket: string; Key: string };
    return `https://test.local/${input.Bucket}/${input.Key}`;
});
```

If real forwarding would require credentials, network I/O, or
non-deterministic external services, the adapter must not pretend to have a
backing.

## The Root API Grammar

The grammar is:

```typescript
probe.filter(predicate).once().answer(value);
probe.filter(predicate).always().reject(error);
probe.always().forward();

const call = await probe.filter(predicate).expect.intercept({ within: seconds(1) });
await probe.filter(predicate).expect.observe({ within: seconds(1) });
await probe.filter(predicate).expect.none({ within: milliseconds(100) });
```

There are three concepts:

- `probe`: the unfiltered selection (i.e., a selection over all calls).
- `selection.filter(...)`: returns a narrower selection.
- `.once()` / `.always()`: a rule builder for future calls.
- `.expect`: expectation helpers for live and historical assertions.

Domain probes add typed filter sugars (`on(method)`, `sql(pattern)`,
`command(ctor)`) which are pure shorthands for `filter(...)` with type
narrowing.

The API does not provide both `expectSomethingWithin(...)` and
`expect.something({ within })`. Only the options-object form exists:

```typescript
await probe.expect.intercept({ within: seconds(1) });
await probe.expect.none({ within: milliseconds(100) });
```

## Rule Resolution

When a call arrives, the engine resolves it in three tiers, in this
order:

### Tier 1 — Live waiters

Tier 1 has two sub-tiers, evaluated in order:

**Tier 1a — Observers (notify-only).** Waiters registered by
`expect.observe(...)` are matched first in FIFO order. Each observer
whose filter chain matches the call is notified with the call shape.
Observers do **not** consume the call; resolution continues to tier 1b.

This means an observer registered for the same selection as a later
intercept will see the call before the intercept captures it. A common
pattern:

```typescript
// Inspect every call to charge before capturing the first one.
probe.on('charge').expect.observe(); // observer waiter; will fire first
const pending = await probe.on('charge').expect.intercept();
```

The observer fires; then the intercept captures and the test owns
settlement.

**Tier 1b — Capturing waiters (FIFO).** Waiters registered by
`expect.intercept(...)` are matched next in FIFO order. The oldest
registered intercept whose filter chain matches consumes the call and
stops resolution.

### Tier 2 — One-shot rules

All `once()` rules live in a **single global FIFO queue**, regardless
of which selection registered them. When a call reaches this tier, the
engine walks the queue from oldest to newest; the first rule whose
filter chain matches the call fires and is removed from the queue. One-
shots beat all permanent rules unconditionally.

This produces the expected sequencing for repeated registrations on the
same selection:

```typescript
products.on('getProduct').once().answer(testProducts[0]);
products.on('getProduct').once().answer(testProducts[1]);
// First getProduct call: walk queue, first rule matches, fire it
//   → testProducts[0]. The rule is consumed and removed.
// Second getProduct call: walk queue (only the second rule left now),
//   it matches, fire it → testProducts[1].
```

It also handles interleaved registrations across selections:

```typescript
products.on('getProduct').once().answer(productA);
products.on('reserveStock').once().answer(true);
products.on('getProduct').once().answer(productB);
// First getProduct call matches the productA rule (oldest matching),
//   not productB. The reserveStock rule is walked but doesn't match,
//   so it stays in the queue.
// Then a reserveStock call: matches the reserveStock rule, fires.
// Then a second getProduct call: matches productB, fires.
```

There is no notion of "per-selection queues" or "per-method
identities." The model is a single FIFO queue with predicate evaluation
at match time. This makes the model trivially extensible to arbitrary
`filter(predicate)` rules whose predicates can't be compared
structurally.

### Tier 3 — Permanent rules

`always()` rules form a **LIFO stack**. When a call reaches this tier
(no waiter consumed it; no one-shot matched), the **most recently
registered matching permanent rule wins**.

This LIFO ordering is what makes overriding a default work:

```typescript
// Backed adapter has installed db.always().forward() as a default.
db.always().reject(new Error('db down'));
// Now every query rejects, because the user's permanent rule was
// registered after the default's permanent rule.
```

The user-installed `reject` is more recent than the harness-installed
`forward`, so it wins. To restore the default, either remove the
user's rule explicitly via `clearRules()`, or register an even more
specific override.

### Default behavior if nothing matches

If no waiter consumed the call and no rule matched (in either tier 2
or tier 3):

- Programmable mock adapters **park** the call (the returned promise
  stays pending until the test settles it via `expect.intercept`, or
  until the harness safety timeout fires).
- Backed adapters do nothing extra at this point — their harness-
  installed `always().forward()` default sits in tier 3 and handles
  the call there.

### Why this tiered model (and not pure LIFO)

Pure LIFO across all rules would reverse the natural reading order of
sequential one-shots:

```typescript
// Under pure LIFO this would be backwards:
products.on('getProduct').once().answer(testProducts[0]);
products.on('getProduct').once().answer(testProducts[1]);
// Pure-LIFO behavior: first call gets testProducts[1] (newest one-shot
// wins). That contradicts every reader's expectation.
```

The tiered model preserves every relevant intuition:

- **Observers see calls before anything else acts on them** (tier 1a).
  This matches "I'm tracing what the SUT does; my observation must
  not perturb behavior."
- **Intercepts capture before rules fire** (tier 1b). This matches
  "for this specific call I want to take ownership and decide the
  outcome."
- **Sequential one-shots fire in the order they were registered**
  (FIFO at tier 2). This matches "I'm scripting a sequence of
  expected calls."
- **Defaults can be overridden by later permanents** (LIFO at tier 3).
  This matches "the harness installed a default; my test overrides it
  with a more specific behavior."
- **One-shots beat permanents** unconditionally. This matches "for
  this one specific call, do something different than the default."

There is no specificity ranking among predicates. All matching is by
predicate evaluation; ordering is the only prioritizing dimension within
each tier.

### Default Rules

Backed adapter factories install a default rule at construction time:

- `createProbedKyselyAdapter` installs `db.probe.always().forward()`.
- `createProbedCacheAdapter` installs `cache.probe.always().forward()`.
- `createProbedS3Adapter` installs `s3.probe.always().forward()` (with
  unsupported commands failing loudly when forwarded).

These defaults sit at the bottom of the tier-3 LIFO stack. User-
installed permanent rules override them naturally; user-installed
one-shots beat them via tier-2 priority. `clearRules()` (without
options) clears user-installed rules only and **preserves harness-
installed defaults**. This is the right call for almost every test
isolation scenario: `beforeEach(() => harness.reset())` removes only
what the test added, leaving the backed adapter usable as it was at
construction.

`clearRules({ includeDefaults: true })` removes the harness-installed
default rule too. After this call, a backed adapter behaves like a
programmable mock: incoming calls park (no rule, no default; tier 3
is empty). The application's awaiting promise hangs until the test
either intercepts the call or the harness safety timeout fires.

If the test wants this exact "all calls park" behavior on a backed
adapter without removing the default rule, the cleaner pattern is to
register an explicit `always().park()` rule, which sits on top of the
tier-3 stack and overrides the default forward via LIFO precedence:

```typescript
// Backed DB still has its default forward installed.
db.probe.always().park();
// Now every query parks. The default forward is still present at the
// bottom of the stack but is shadowed by the user's park rule.
```

`always().park()` is preferred over `clearRules({ includeDefaults: true })`
in almost every case. Reasons:

- Reversible: a subsequent `clearRules()` removes the user park and
  restores forward behavior, without requiring the test to re-install
  the default by hand.
- Self-documenting: the test source explicitly says "park everything,"
  rather than relying on the absence of a rule and the implicit
  programmable-mock fallback.
- Symmetric with one-shots: `selection.once().park()` and
  `selection.always().park()` use the same vocabulary.

Use `clearRules({ includeDefaults: true })` only when the test
deliberately wants to verify behavior in a state where no rule is
installed at all (rare; advanced).

There is no `defaultRule` configuration option on adapter factories.
The default is always a real rule, expressible by the user, with the
same semantics as any other rule.

## Expectations

Expectations are the testing sugar layer.

Live expectations come in two flavors with distinct semantics:

```typescript
// Capturing: waiter wins over rules. The test owns the pending call and must
// settle it (or intentionally leave it pending to test timeout behavior).
const pending = await probe.expect.intercept({ within: seconds(1) });

// Non-capturing: rules still fire. The test observes the call shape but does
// not block the rule pipeline.
const call = await probe.expect.observe({ within: seconds(1) });
```

Use `intercept` when:

- You want to inspect the call and decide its outcome based on the inspection.
- You want to test timeout/fallback paths by intentionally not settling.
- You want to control settlement timing (e.g., resolve only after another
  call arrives, to test ordering).

Use `observe` when:

- A default rule is in place (`always().answer(...)` or `always().forward()`)
  and you only want to assert that the call happened with specific arguments.
- You want a sanity check or trace point without altering call flow.

Negative expectations assert silence:

```typescript
await probe.expect.none({ within: milliseconds(100) });
await probe.on('publish').expect.none({ within: milliseconds(100) });
```

Count expectations come in two precise flavors:

```typescript
await probe.on('getProduct').expect.atLeast(2, { within: seconds(1) });
await probe.on('getProduct').expect.exactly(2, { within: seconds(1) });
```

- `atLeast(n, { within })` resolves as soon as `n` matching calls exist, or
  rejects on timeout. Does not detect over-call.
- `exactly(n, { within })` waits the full `within` window, then asserts that
  exactly `n` matching calls were recorded. Slower; precise.

Synchronous expectations inspect the current call history:

```typescript
probe.on('publish').expect.calledTimes(1);
probe.on('publish').expect.neverCalled();
probe.on('publish').expect.called();
```

The distinction between live and synchronous expectations is firm:

- Live expectations (`intercept`, `observe`, `none`, `atLeast`, `exactly`)
  return promises and observe time.
- Synchronous expectations (`calledTimes`, `neverCalled`, `called`) inspect
  history and return synchronously.

`within` is required on all negative live expectations and on `exactly`
(both express assertions whose meaning depends on a time window). `within`
is optional on positive live expectations; the harness's default expectation
timeout applies when omitted.

## Time API

Durations are explicit values, not raw numbers.

```typescript
import { milliseconds, seconds, type Duration } from '@vnatures/test-kit';

const short = milliseconds(100);
const long = seconds(5);
```

Public timing APIs accept `Duration` only. Implementations brand the type
to prevent accidentally passing arbitrary numbers.

## Clock

Test-kit ships a `Clock` abstraction so tests can drive virtual time
forward in a way that works identically under Jest fake timers, Vitest
fake timers, Sinon fake timers, or any user-provided clock
implementation. **The Clock is for the test author's use; it does not
drive any of test-kit's internal timing.**

```typescript
import { createHarness, jestFakeClock } from '@vnatures/test-kit';

const harness = createHarness({ clock: jestFakeClock() });
```

Built-in clock implementations:

- `realClock()`: wall-clock time. `advance()` rejects.
- `jestFakeClock()`: wraps `jest.advanceTimersByTime` and friends.
- `viFakeClock()`: wraps `vi.advanceTimersByTime` and friends.
- `sinonFakeClock(installedTimers)`: wraps a Sinon `FakeTimers` instance the
  user already owns.
- `manualClock()`: pure in-memory clock for non-Jest/Vitest contexts.

When no `clock` option is provided, `createHarness` auto-detects the test
runner's fake-timer system and falls back to `realClock()` if none is active.

The harness exposes the active clock so tests can advance time consistently:

```typescript
await harness.clock.advance(seconds(5));
```

Tests should prefer `harness.clock.advance(...)` over calling
`jest.advanceTimersByTime(...)` directly. The harness's call delegates to
the underlying fake-timer system; using the harness gives a uniform
test-author experience across timer systems.

### The Clock Does Not Drive Test-Kit's Internal Timing

This is a deliberate boundary. **Test-kit's internal timers — waiter
deadlines for `expect.intercept`/`expect.observe`/`expect.none`/etc.,
the harness safety timeout, and any internal scheduling — always use
real wall-clock time, never the active Clock.**

Why: if waiter deadlines used virtual time, then a test that forgets
to call `harness.clock.advance(...)` would hang indefinitely waiting
for a virtual-time deadline that never arrives. The user would see
the test exceed the safety timeout (30s real wall-clock), not a clean
5s "Timed out waiting for next call" failure. v1's behavior was
correct here: real wall-clock for waiters, fake clock only for the
SUT's internal timers.

The split:

- **Test-kit waiter deadlines, safety timeout**: real wall-clock,
  always. Forgetting to advance fake time produces a fast, clear
  timeout failure with a useful message.
- **SUT-internal timers**: governed by whatever timer system is
  active (Jest fake, Vitest fake, real). The user controls these via
  `harness.clock.advance(...)` (or directly via `jest.advanceTimersByTime`,
  though the harness call is preferred).

The Clock interface exists purely for the user's time-travel needs.
The probe engine's correctness does not depend on it.

### `expect.none` Does Not Advance Virtual Time

`expect.none({ within })` waits real wall-clock time for the duration
and then checks that no matching call has been recorded. It does
**not** advance virtual time as a side effect.

This is important: if `expect.none` advanced virtual time, an SUT
with an internal `setTimeout(sideEffect, 50)` would see its side
effect fire as a side effect of a `expect.none({ within: ms(100) })`
assertion. The test author wrote an assertion; they didn't ask to
move time forward. Hidden side effects are a footgun.

Performance consequence: `expect.none({ within: ms(100) })` takes
real 100ms. For tests that need fast negative checks under fake
timers, advance the clock explicitly first and then assert silence:

```typescript
await harness.clock.advance(seconds(5));
await users.on('getUser').expect.none({ within: ms(0) });
// ms(0) means "after a microtask flush": no real wait, just verify
// that no matching call has been recorded right now.
```

`within: ms(0)` is the supported idiom for "right now, after the
event loop has drained pending microtasks." It's the right choice
when the test author has already advanced virtual time explicitly
and just wants to assert the resulting silence.

## Waiter Priority

Waiters registered by `expect.intercept` (capturing) take first chance to
match incoming calls, ahead of rules. This is essential for the common
pattern where a default rule handles most calls but the test wants to inspect
a specific one:

```typescript
// Backed DB with default forward installed at construction.

const pendingPromise = db.probe
    .sql(/insert into orders/i)
    .expect.intercept();

const resultPromise = service.createOrder(input);

const pending = await pendingPromise;
expect(pending.sql).toContain('orders');
pending.forward();

await resultPromise;
```

The default forward rule handles every other query; the explicit `intercept`
captures the interesting one.

For the same pattern without taking ownership of the call (when the rule
already does the right thing), use `expect.observe`:

```typescript
const charge = await payments.probe.on('charge').expect.observe();
expect(charge.args[1]).toEqual(expectedTotal);
// no need to settle: the rule (e.g. always().answer(...)) already did.
```

## Harness Pattern

The harness is the lifecycle owner of probes and adapters. It is provided
by `@vnatures/test-kit`.

**When the harness is required:**

- Any test using a backed adapter (Kysely, Knex, Sequelize, Redis, S3,
  presigner) — these own external resources (in-memory database
  connections, file handles, mocked-Redis instances) that must be
  closed.
- Any test with multiple probed adapters — to coordinate disposal in
  reverse registration order and to share clock and safety-timeout
  configuration.

**When the harness is optional:**

- A test that uses a single `createProbedMock` and nothing else can
  skip the harness. The probed mock has no external resources to
  release, and the probe's safety timeout falls back to a sensible
  default (5s positive expectations, 30s real-wall-clock safety).
  Calling `createProbedMock(...)` directly is supported and idiomatic
  for trivial tests.

**When in doubt, use the harness.** It costs one line of construction
and one line of teardown, and it gives consistent behavior across
test files.

```typescript
import { createHarness } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';
import { createProbedKyselyAdapter } from '@vnatures/test-kit-pg-kysely';

function createTestHarness() {
    const harness = createHarness();

    const users = harness.attach(createProbedMock<UserService>({
        methods: ['getUser', 'updateUser'],
    }));
    const products = harness.attach(createProbedMock<ProductService>({
        methods: ['getProduct', 'reserveStock', 'releaseStock'],
    }));
    const payments = harness.attach(createProbedMock<PaymentGateway>({
        methods: ['charge', 'refund'],
    }));
    const events = harness.attach(createProbedMock<EventBus>({
        methods: ['publish'],
    }));

    const service = new OrderService({
        users: users.adapter,
        products: products.adapter,
        payments: payments.adapter,
        events: events.adapter,
    });

    return {
        harness,
        service,
        users: users.probe,
        products: products.probe,
        payments: payments.probe,
        events: events.probe,
    };
}

afterEach(async () => {
    await harness.close();
});
```

`harness.attach(probedAdapter)` registers an adapter for lifecycle
management. The harness:

- closes attached adapters in reverse-registration order on `harness.close()`,
- resets attached adapters AND clears probe state (rules + call history)
  on `harness.reset()` (see "Reset Semantics" below),
- cancels any in-flight waiters when closing, with a clear error
  (`"Harness closed with N unsettled waiters"`),
- enforces the safety-timeout deadline on every live expectation registered
  through any attached probe.

`attach` has two type signatures backed by a single implementation:

```typescript
attach<T extends ProbedAdapter<any, any>>(adapter: T): T;
attach<T extends ProbedAdapter<any, any>>(adapter: Promise<T>): Promise<T>;
```

When given a Promise, the implementation recurses on the resolved
value, returning a Promise that resolves to the registered adapter.
The standard usage pattern makes registration explicit in the await:

```typescript
const db = await harness.attach(createProbedKyselyAdapter<Database>({
    harness,
    bootstrap,
}));
```

Calling `harness.close()` before an in-flight async attach resolves
will cause the late registration to fail with `"Harness is closed."`.

Tests should normally interact with probes only.

### Harness Injection Into Backed Adapters

Backed-adapter factories (`createProbedKyselyAdapter`,
`createProbedKnexAdapter`, `createProbedSequelizeAdapter`,
`createProbedCacheAdapter`, `createProbedS3Adapter`,
`createProbedPresignerAdapter`) take an explicit `harness` parameter
in their options:

```typescript
const harness = createHarness();
const db = await harness.attach(createProbedKyselyAdapter<Database>({
    harness,
    bootstrap,
}));
```

The harness reference is used by the factory to wire the harness's
clock, `defaultTimeout`, and safety-timeout configuration into the
probe. The factory does **not** call `harness.attach` itself —
registration is the caller's responsibility (the standard
`await harness.attach(...)` pattern). This keeps lifecycle ownership
explicit at the call site.

`createProbedMock` does **not** take a harness parameter, because it
has no external resources and falls back to sensible defaults if no
harness is in scope. Tests that want consistent behavior can still
attach a probed mock to a harness for unified `reset`/`close` lifecycle.

### Cross-Probe Expectations

For tests that need to assert orderings across multiple boundaries
(common in saga-style components: "first the SUT calls `payments.charge`,
then it calls `events.publish`"), the harness exposes
`harness.expect.sequence(...)` and `harness.expect.allOf(...)`.

```typescript
const [charge, publish] = await harness.expect.sequence(
    [
        payments.on('charge'),     // step 0: capturing intercept
        events.on('publish'),      // step 1: capturing intercept
    ],
    { within: seconds(1) },
);

expect(charge.args[0]).toBe(userId);
charge.answer({ success: true });

expect(publish.args[0].type).toBe('order.confirmed');
publish.answer(undefined);
```

`sequence([a, b, c], { within })` resolves only if matching calls
arrive in **strict order**: first a match for `a`, then a match for
`b`, then a match for `c`. If a later step matches before an earlier
one is satisfied, the expectation fails immediately with a clear
diagnostic.

`allOf([a, b, c], { within })` resolves when each step has matched at
least once, regardless of arrival order. Useful for "these all
happened, I don't care which order."

By default, each step is a **capturing intercept** — the test owns
settlement of every captured pending call. To mark a step as
observation-only (let the rule resolve it normally), wrap the
selection with `observation(...)`:

```typescript
import { observation } from '@vnatures/test-kit';

const [chargeCall, _publishCall] = await harness.expect.sequence(
    [
        payments.on('charge'),                  // capture
        observation(events.on('publish')),      // observe (rule still fires)
    ],
    { within: seconds(1) },
);

expect(chargeCall.args).toEqual([userId, total]);
chargeCall.answer({ success: true });
// _publishCall is a plain call snapshot; nothing to settle.
```

Mixing capture and observe within one sequence is supported. The
return type is correctly inferred per step.

### Reset Semantics

`harness.reset()` produces test isolation by default:

- For each attached adapter that implements `reset()` (backed adapters):
  call `adapter.reset()` to wipe data state (truncate tables, flush
  cache, empty bucket directory, etc.).
- For each attached probe: call `probe.resetProbe()` to clear
  user-installed rules and call history. Harness-installed defaults
  (the `always().forward()` rules installed by backed adapter
  factories) are preserved.

This matches the `beforeEach(() => harness.reset())` expectation: the
test starts from a clean slate. Defaults that the harness installed
at construction stay in place.

For tests that need to keep rules across resets (e.g., when running
multiple steps within a single test that share programmed rules but
need a clean data slate between steps), pass `{ keepRules: true }`:

```typescript
await harness.reset({ keepRules: true });
// adapter data is wiped; probe rules and call history are preserved.
```

`harness.close()` is unaffected by this option — close always
disposes everything.

## Examples

### Happy Path With Programmed Rules

```typescript
it('creates an order', async () => {
    const { service, users, products, payments, events } = createTestHarness();

    users.on('getUser').always().answer(testUser);
    products.on('getProduct').once().answer(testProducts[0]);
    products.on('getProduct').once().answer(testProducts[1]);
    products.on('reserveStock').always().answer(true);
    payments.on('charge').once().answer({ success: true, transactionId: 'txn-1' });
    events.on('publish').always().answer(undefined);

    const order = await service.createOrder(userId, items);

    expect(order.status).toBe('confirmed');
    events.on('publish').expect.calledTimes(1);
});
```

### Interactive Control via Intercept

```typescript
it('charges the computed total', async () => {
    const { service, users, products, payments, events } = createTestHarness();

    users.on('getUser').always().answer(testUser);
    products.on('getProduct').always().answer(testProduct);
    products.on('reserveStock').always().answer(true);
    events.on('publish').always().answer(undefined);

    const orderPromise = service.createOrder(userId, items);

    const charge = await payments.on('charge').expect.intercept({
        within: seconds(1),
    });

    expect(charge.args).toEqual([userId, expectedTotal]);

    charge.answer({ success: true, transactionId: 'txn-1' });

    await expect(orderPromise).resolves.toMatchObject({
        status: 'confirmed',
    });
});
```

### Observation Without Capture

```typescript
it('issues exactly one charge with the computed total', async () => {
    const { service, users, products, payments, events } = createTestHarness();

    users.on('getUser').always().answer(testUser);
    products.on('getProduct').always().answer(testProduct);
    products.on('reserveStock').always().answer(true);
    payments.on('charge').always().answer({ success: true, transactionId: 'txn-1' });
    events.on('publish').always().answer(undefined);

    const orderPromise = service.createOrder(userId, items);

    const charge = await payments.on('charge').expect.observe({
        within: seconds(1),
    });
    expect(charge.args).toEqual([userId, expectedTotal]);

    await orderPromise;

    payments.on('charge').expect.calledTimes(1);
});
```

### Timeout By Parking

```typescript
it('times out when payment never responds', async () => {
    const { harness, service, users, products, payments } = createTestHarness();

    users.on('getUser').always().answer(testUser);
    products.on('getProduct').always().answer(testProduct);
    products.on('reserveStock').always().answer(true);
    // No rule for payments.on('charge'). Default for a programmable mock
    // adapter is "park": calls hang until settled or until the SUT times out.

    const orderPromise = service.createOrderWithTimeout(userId, items, seconds(5));

    await payments.on('charge').expect.observe();

    await harness.clock.advance(seconds(5));

    await expect(orderPromise).rejects.toThrow('timed out');
});
```

### Explicit Park Rule Over a Default Forward

```typescript
it('lets the SUT retry when the cache is silent', async () => {
    const { harness, service, cache } = createTestHarness();

    // Default rule on the cache is forward (installed by adapter factory).
    // We want this one specific lookup to be silent so the SUT's fallback
    // path runs.
    cache.filter((call) => call.method === 'get' && call.args[0] === userKey)
        .once()
        .park();

    const result = await service.loadUser(userId);

    expect(result.source).toBe('database-fallback');
});
```

### Backed Database With One Captured Query

```typescript
it('persists the order', async () => {
    const { harness, service, db } = createTestHarness();
    // db has a default forward rule installed at construction.

    const insertPromise = db.probe
        .sql(/insert into orders/i)
        .expect.intercept({ within: seconds(1) });

    const resultPromise = service.createOrder(input);

    const insert = await insertPromise;
    expect(insert.parameters).toContain(input.userId);
    insert.forward();

    await resultPromise;
});
```

### Retry Behavior (Documented Pattern)

Test-kit does not ship a dedicated "expect retry" sugar. The pattern
below — a sequence of `intercept`/`reject`/`park`/`none`/`answer` —
exercises retry/backoff behavior with the existing primitives.

```typescript
it('retries the charge with backoff after a failure', async () => {
    const { service, payments } = createTestHarness();

    // First attempt: SUT calls charge, we reject immediately.
    const firstAttempt = service.processOrderWithRetry(input);

    const first = await payments.on('charge').expect.intercept({
        within: seconds(1),
    });
    first.reject(new ImmediateError('payment provider unreachable'));

    // SUT should now wait its backoff window before retrying.
    // We park the next call to keep the test in control of timing,
    // then assert the SUT didn't retry too eagerly.
    const second = await payments.on('charge').expect.intercept({
        within: seconds(2),
    });
    // Don't settle yet. Assert no other charge attempts during the
    // window where the SUT is supposed to be waiting on this one.
    await payments.on('charge').expect.none({
        within: milliseconds(50),
    });

    // Now answer the second attempt successfully and verify the SUT
    // returns the expected result.
    second.answer({ success: true, transactionId: 'txn-42' });

    await expect(firstAttempt).resolves.toMatchObject({
        status: 'confirmed',
        transactionId: 'txn-42',
    });
});
```

Key building blocks:

- `intercept` to capture each retry attempt one by one.
- `reject` (or specific error subclass) to simulate the failure mode
  the SUT is supposed to retry on.
- `intercept` again to capture the next attempt, with `within` sized
  to cover the SUT's backoff window.
- `expect.none({ within: small })` to assert that no additional
  attempts happen during a window when the SUT should be waiting.
- Final `answer` to let the SUT succeed and propagate the result.

If the SUT exposes its retry policy via a configurable backoff
function, inject the real backoff with shortened durations for tests.
If it uses real time-based delays, drive `harness.clock.advance(...)`
between intercepts to step through the backoff window deterministically.

### Silence Assertion

```typescript
it('does not publish an event when payment fails', async () => {
    const { service, users, products, payments, events } = createTestHarness();

    users.on('getUser').always().answer(testUser);
    products.on('getProduct').always().answer(testProduct);
    products.on('reserveStock').always().answer(true);
    products.on('releaseStock').always().answer(undefined);
    payments.on('charge').once().answer({ success: false, error: 'declined' });

    await expect(service.createOrder(userId, items)).rejects.toThrow('declined');

    await events.on('publish').expect.none({
        within: milliseconds(0),
    });
});
```

`within: milliseconds(0)` is a valid assertion: it asserts that no matching
call has been recorded by the time the microtask queue drains.

## Synchronous Dependencies: Use The Real Thing

Test-kit replaces dependencies whose real implementations cannot run
in a test process — network calls, database engines, message brokers,
external services, anything that crosses a process boundary, a network,
a disk, or another non-deterministic I/O surface. These are the **leaf
boundary dependencies** of the component under test, and they are
inherently asynchronous because crossing any of those surfaces requires
a deferred callback.

Synchronous dependencies are categorically different. A method that
returns synchronously runs entirely in-process: a clock, a UUID
generator, a JWT verifier with in-process keys, an in-memory feature
flag client, a config reader, local crypto, a pure validator, an SDK
state query. **Their real implementations can run in the test
process.** So run them.

This is the prescription, not a workaround:

> **For synchronous dependencies, use the real implementation. Do not
> double them, stub them, or push them through test-kit.**

Component tests should exercise as much of the real code path as
possible. Test-kit exists to control the parts that genuinely cannot
run in tests (network, disk, external services). Doubling a sync
dependency reduces test fidelity for no benefit:

- A test that asserts on a stubbed UUID asserts on the stub, not on
  the component's behavior.
- A test that stubs the clock to return a fixed time hides bugs that
  only manifest with realistic time values, daylight-saving
  transitions, leap seconds, time-zone surprises, etc.
- A test that stubs JWT verification to "always pass" can't catch a
  bug where the SUT forgot to call the verifier at all.
- A test that stubs feature flags to fixed values misses the
  evaluation logic that the SUT depends on.

### What Good Tests Do Instead

- **Use the real implementation with test-appropriate inputs.** A
  real `JsonWebToken` verifier with a test key pair. A real UUID
  generator. A real clock. A real feature-flag client configured
  with test values. A real config reader pointing at test config.
- **Assert on shape, not on specific stubbed values.** Use
  `expect(result.id).toMatch(uuidRegex)` rather than
  `expect(result.id).toBe('00000000-0000-0000-0000-000000000001')`.
  Use `expect(result.timestamp).toBeGreaterThan(beforeCall)` rather
  than `expect(result.timestamp).toBe(fixedTestTime)`.
- **For time-dependent behavior**, inject a real `Clock` interface
  whose production implementation reads `Date.now()` and whose test
  implementation is a real fake-clock object (an object with a
  `now()` method that returns whatever the test set; this is real
  code, not a test-kit probe). The injection point is your design;
  the fake-clock implementation is yours; test-kit stays out of it.
- **For randomness**, inject a real RNG interface whose production
  implementation reads `crypto.randomUUID()` and whose test
  implementation is a deterministic seeded RNG (also real code).

In every case, the seam is real dependency injection at design time,
and the test substitutes a real alternative implementation, not a
test double.

### What Test-Kit Refuses

`createProbedMock` will not accept sync methods at compile time. The
`methods` array is type-constrained to async-returning methods only.
Including a sync method produces a TypeScript error that names the
offending method:

```typescript
interface FlagClient {
    isEnabled(flag: string): boolean;       // sync — should be real
    refresh(): Promise<void>;               // async — leaf boundary
}

createProbedMock<FlagClient>({ methods: ['isEnabled', 'refresh'] });
//                                       ~~~~~~~~~~~
// TS compile error:
//   __sync_methods_cannot_be_probed: "isEnabled"
//   __how_to_fix:
//     "For sync dependencies, use the real implementation in tests.
//      See 'Synchronous Dependencies: Use The Real Thing' in the docs."
```

The remediation is not to spread-compose stubs onto the probed mock.
The remediation is to inject the real `FlagClient` and let it run.
`refresh()` (which crosses the network) belongs in a separate async
boundary that test-kit probes; `isEnabled()` (which is in-process
evaluation) doesn't.

If your interface mixes async-leaf and sync-real concerns, that's a
design smell worth fixing: split them. The async leaf becomes a
test-kit boundary; the sync part becomes a real injectable that runs
for real in tests. This split tends to improve production code as
well — it separates "talk to the outside world" from "compute things
locally," which is good architecture independent of testing.

### Why The Library Cannot Help With Sync Methods Even If It Wanted To

Even setting aside the architectural position above, JavaScript will
not permit sync probe semantics. This is worth knowing so the question
doesn't keep coming back.

The probe model assumes a time gap between "call enters the boundary"
and "call settles." For an async method, the gap is the duration of
the returned Promise. For a sync method, the gap is zero — the call
must return a value before the test code runs. There is no way for
`expect.intercept` to step into a zero-width gap.

You might wonder: can we just block the SUT's thread until the test
provides a value? Languages with `Await.result`-style operations
(Scala, Java, Kotlin) do exactly this — one thread blocks while
another resolves the awaited value. JavaScript has one thread per
realm. If that thread blocks waiting for a Promise to resolve, the
code that would resolve the Promise (the test code, which lives on
the same thread) can never run. The result is permanent deadlock, not
synchronous waiting.

`Atomics.wait` plus `Worker` threads plus `SharedArrayBuffer` can
technically block the main thread until another thread signals. But
the useful probe operations (`intercept`, `observe`, `answerWith`
with closures over test state) inherently capture main-thread state
and cannot run on a worker. Only literal-value rules (`answer(value)`,
`reject(error)`) could survive the boundary, and those produce
synchronously-available values that need no blocking in the first
place.

So the architectural prescription and the runtime constraint converge
on the same answer: **for sync dependencies, use the real
implementation; test-kit stays out of it.**

## Methods Specification

`createProbedMock<T>({ methods })` requires an explicit `methods`
list of async-returning method names from `T`. The proxy intercepts only
the listed names; any other property access returns `undefined`.

The `methods` parameter is constrained at the type level so that:

1. Only members of `T` that exist as methods can be listed.
2. Only methods whose return type is `Promise<...>` can be listed.

Including a sync method produces a TypeScript error whose text names the
offending method explicitly and prescribes the fix:

```typescript
interface FlagClient {
    isEnabled(flag: string): boolean;       // sync — should be real
    refresh(): Promise<void>;               // async — leaf boundary
}

const fc = createProbedMock<FlagClient>({ methods: ['isEnabled', 'refresh'] });
//                                                  ~~~~~~~~~~~
// TS error:
//   __sync_methods_cannot_be_probed: "isEnabled"
//   __how_to_fix:
//     "For sync dependencies, use the real implementation in tests.
//      See 'Synchronous Dependencies: Use The Real Thing' in the docs."
```

The remediation is to inject the real `FlagClient` implementation in the
test, not to spread-stub `isEnabled` onto the probed mock's adapter.
For genuinely mixed boundaries, the design prescription is to **split
the boundary**: extract the async leaf (e.g., `refresh`) into a separate
test-kit-probed adapter, and let the sync part run for real. See
"Synchronous Dependencies: Use The Real Thing" above.

There is no runtime sync-vs-async detection. The TypeScript constraint
is the only line of defense. Users who escape it via `as any` get a
proxy that returns `undefined` from any sync method that slipped
through; the SUT will fail naturally at the first interaction
(`await undefined` returns undefined, `undefined.x` throws TypeError,
etc.).

### Framework Probe Compatibility

Because the proxy intercepts only the methods listed in `methods`, every
other property access returns `undefined`. This eliminates the v1-era
class of bugs where third-party frameworks introspected the adapter for
properties unrelated to the probed boundary:

| Framework / consumer        | Property accessed             | Behavior     |
| --------------------------- | ----------------------------- | ------------ |
| NestJS DI lifecycle scanner | `onModuleInit`,               | `undefined`  |
|                             | `onApplicationBootstrap`,     | `undefined`  |
|                             | `onModuleDestroy`,            | `undefined`  |
|                             | `beforeApplicationShutdown`,  | `undefined`  |
|                             | `onApplicationShutdown`       | `undefined`  |
| Promise interop             | `then`, `catch`, `finally`    | `undefined`  |
| JSON serialization          | `toJSON`                      | `undefined`  |
| `Object.prototype` chain    | `toString`, `valueOf`,        | `undefined`  |
|                             | `hasOwnProperty`              | `undefined`  |
| Vitest / Jest matchers      | `asymmetricMatch`             | `undefined`  |
| React reconciler            | `$$typeof`                    | `undefined`  |
| `Symbol.toPrimitive`,       | (any symbol key)              | `undefined`  |
| `Symbol.iterator`, etc.     |                               |              |
| Future framework's probe    | (any property not in methods) | `undefined`  |

No allowlist, denylist, or passthrough configuration is required. The
explicit `methods` array is itself the allowlist; everything outside of
it falls through to `undefined` automatically. New framework probes
introduced in the future will continue to see `undefined` without any
test-kit update, because the design closes the open category rather than
trying to enumerate it.

The v1 implementation maintained a hand-curated list of properties to
return `undefined` for (`then`, `nodeType`, `onModuleInit`,
`asymmetricMatch`, `$$typeof`, etc.) precisely because v1's proxy
intercepted *every* property access. Each new framework that probed
unexpected keys required an addition to the list. The shipped API inverts the model:
intercept only what's declared, pass through everything else.

## Pending Calls

The `pending` object returned by `expect.intercept` is the test's
handle on a live, unsettled call.

```typescript
const pending = await users.probe.on('getUser').expect.intercept();

pending.method;     // 'getUser' (typed as the literal)
pending.args;       // typed args tuple
pending.settled;    // false until a settlement verb is called
pending.answer(user);
// or: pending.reject(new Error('boom'));
// or (only on backed pending calls): pending.forward();
```

Calling any settlement verb after settlement throws synchronously
(`"Pending call 'getUser' is already settled."`).

A pending call has no `.park()` method. Doing nothing leaves the call
unsettled, which is the correct way to test timeout, retry, and fallback
paths in the SUT. If the test wants to declare intent without doing
anything, a code comment is sufficient.

## Probe API Summary

The full API of every probe and selection:

```typescript
interface Selection<TCall, TPending> {
    // narrowing
    filter(predicate: (call: TCall) => boolean, label?: string): Selection<TCall, TPending>;
    filter<TNarrow extends TCall>(
        predicate: (call: TCall) => call is TNarrow,
        label?: string,
    ): Selection<TNarrow, NarrowPending<TPending, TNarrow>>;

    // rules
    once(): RuleBuilder<TCall, TPending>;
    always(): RuleBuilder<TCall, TPending>;

    // expectations
    readonly expect: Expectations<TCall, TPending>;

    // observation (read-only snapshot of matching call history)
    readonly calls: ReadonlyArray<TCall>;

    // bulk control over still-open matching calls
    drain(handler?: (call: TPending) => void): void;
    drainAndReject(error?: unknown): void;
}

// Selections whose pending type supports forwarding additionally expose:
interface ForwardableSelection<TCall, TPending> extends Selection<TCall, TPending> {
    drainAndForward(): void;
}

type Probe<TCall, TPending> = Selection<TCall, TPending> & ProbeAdmin;

interface ProbeAdmin {
    clearRules(options?: { includeDefaults?: boolean }): void;
    clearCalls(): void;
    resetProbe(options?: { includeDefaults?: boolean }): void;
}
```

`clearRules`, `clearCalls`, and `resetProbe` exist only on the probe root,
not on selections. They are admin operations: rare in normal tests.

## Domain Filter Sugars

Domain probes provide typed shorthands. These are pure sugar over `filter`
and exist because they enable type narrowing the user can't easily write
themselves.

### Method probes (`@vnatures/test-kit-mock`)

```typescript
methodProbe.on('getUser');
// ≡ methodProbe.filter((call): call is TypedMethodCall<T, 'getUser'> => call.method === 'getUser', "method === 'getUser'")
```

### Query probes (`@vnatures/test-kit-pg-*`)

```typescript
queryProbe.sql(/insert into orders/i);
// ≡ queryProbe.filter((call) => /insert into orders/i.test(call.sql), "sql matches /insert into orders/i")
queryProbe.sql('select 1');
// matches by exact-string equality on the SQL text
queryProbe.sql((sql) => sql.startsWith('SELECT'));
// matches by predicate
```

### Cache probes (`@vnatures/test-kit-redis`)

```typescript
cacheProbe.on('get');
// ≡ cacheProbe.filter((call): call is GetCall => call.method === 'get', "method === 'get'")
```

### S3 probes (`@vnatures/test-kit-s3`)

```typescript
s3Probe.command(GetObjectCommand);
// ≡ s3Probe.filter((call) => call.command instanceof GetObjectCommand, 'command is GetObjectCommand')
s3Probe.command('GetObjectCommand');
// matches by command name (string)
```

Domain packages **must** also re-export the underlying `filter` so users
who hit a case the sugars don't cover have an escape hatch.

## Boundaries In And Out Of Scope

Test-kit replaces dependencies at the **typed boundary** between the
component under test and the outside world. This is a deliberate
architectural choice with consequences for which packages are in scope.

### In scope

- Database (Kysely, Knex, Sequelize, future: TypeORM, Drizzle).
- Cache (Redis-shaped boundary, future: Memcached).
- Object storage (S3, future: GCS, Azure Blob).
- HTTP clients (typed clients like generated OpenAPI clients, future:
  fetch-shaped HTTP boundary).
- Message buses and queues (Kafka, SQS, EventBridge, GCP Pub/Sub) at the
  typed-publisher/consumer boundary.
- gRPC clients at the typed-stub boundary.
- Anything else exposed to the SUT as an injected typed object.

### Out of scope

- **Transport-layer interception.** Tools like msw, nock, and similar work
  at the HTTP/socket layer because they assume the SUT directly calls
  `fetch`/`http.request`. Test-kit's position is that this is an
  architectural smell: the SUT should consume a typed boundary
  (`UserApiClient`, etc.) which in turn calls `fetch`. With a typed
  boundary, a probed mock is strictly more precise than transport
  interception and does not depend on URLs or wire format being stable.
  If the SUT lacks a typed boundary, the recommended fix is to introduce
  one rather than add transport interception.
- **Code paths inside third-party libraries.** If a third-party library
  internally calls `fetch` or other I/O without offering a typed seam,
  test-kit cannot help. Wrap the library or accept that this code is not
  covered by component tests.

## Design Rules

1. Use "adapter" for the injected object and "probe" for the test handle.
2. Use "answer" as the standard successful settlement verb.
3. Treat forwarding as an optional capability of pending calls.
4. Keep call shapes plain and domain-appropriate.
5. Prefer one expectation grammar: `expect.intercept({ within })`,
   `expect.observe({ within })`, `expect.none({ within })`,
   `expect.atLeast(n, { within })`, `expect.exactly(n, { within })`.
6. Use `intercept` when the test owns the outcome; use `observe` when a
   rule already handles the outcome.
7. Rule resolution has four ordered tiers: observers (notify-only,
   FIFO) → capturing waiters (intercept, FIFO) → one-shot rules
   (single global FIFO queue) → permanent rules (LIFO). Observers
   never consume; intercepts and rules consume on first match. One-
   shots beat permanents unconditionally. There is no specificity
   ranking among predicates.
8. Default behavior on a backed adapter is itself a rule installed at
   construction time, not a separate concept.
9. Use the `Clock` abstraction. Never call `jest.advanceTimersByTime`
   directly from tests; call `harness.clock.advance` instead.
10. Make explicit `methods` lists mandatory for `createProbedMock`,
    constrained at the type level to async-returning methods only. No
    open-ended Proxy passthrough lists. No runtime sync/async detection.
    No support for sync methods: sync dependencies should use real
    implementations in tests, not test doubles.
11. Avoid global monkeypatching such as `Number.prototype`.
12. Keep domain packages thin wrappers over the same core probe engine.
13. Prefer `filter(predicate)` as the universal narrowing primitive. Domain
    sugars are typed shorthands, not a separate API.
