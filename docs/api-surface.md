# Test-Kit API Surface

This document is the exhaustive API reference for test-kit. Use it to look
up exact type signatures, matching semantics, and error contracts. For the
mental model and vocabulary, start with [`concepts.md`](concepts.md).

## Package Names

Test-kit ships as a small family of packages:

- `@vnatures/test-kit`: generic probe engine, `Selection` / `RuleBuilder` /
  `Expectations`, `Clock`, `Harness`, shared types.
- `@vnatures/test-kit-mock`: Proxy-based programmable mock adapters.
- `@vnatures/test-kit-pg-kysely`: Kysely + PGlite backed adapter.
- `@vnatures/test-kit-pg-knex`: Knex + PGlite backed adapter.
- `@vnatures/test-kit-pg-sequelize`: Sequelize v6 + PGlite backed adapter.
- `@vnatures/test-kit-redis`: cache adapter backed by a Redis-compatible fake.
- `@vnatures/test-kit-bull`: Bull `Queue` adapter with an in-memory backing.
- `@vnatures/test-kit-s3`: S3 and presigner adapters.
- `@vnatures/test-kit-sqs`: SQS adapter with a functional in-memory backing.
- `@vnatures/test-kit-kafka`: Kafka producer adapter with an in-memory topic log.
- `@vnatures/test-kit-mysql`: real MySQL 8 via Testcontainers behind the `test-kit-sql` probe seam.

## Design Overview

Every adapter factory returns an object with at least:

```typescript
type ProbedAdapter<TAdapter, TProbe> = {
    readonly adapter: TAdapter;
    readonly probe: TProbe;
};
```

The adapter is injected into the component. The probe is returned to the
test.

Adapters with lifecycle additionally implement `ProbedResource`:

```typescript
interface ProbedResource {
    reset(): Promise<void> | void;
    close(): Promise<void> | void;
}

type ProbedAdapterWithLifecycle<A, P> = ProbedAdapter<A, P> & ProbedResource;
```

Domain packages may expose additional helpers (e.g., `seed`, `bucket`,
`localDirectory`) but the `ProbedResource` shape is mandatory for any adapter
that owns external resources (database connections, file handles, in-memory
fakes that need teardown).

## Duration

```typescript
declare const durationBrand: unique symbol;

export type Duration = {
    readonly milliseconds: number;
    readonly [durationBrand]: true;
};

export function milliseconds(value: number): Duration;
export function seconds(value: number): Duration;
export function minutes(value: number): Duration;
```

Rules:

- All factory functions require `value >= 0`. They throw
  `RangeError("milliseconds(...) requires value >= 0, got -5")` for
  negative input.
- Fractional values are normalized to integer milliseconds via `Math.round`.
- Public timing APIs accept `Duration` only. They never accept raw numbers.
- The brand prevents accidental cross-package use of `{ milliseconds: 100 }`
  literals; only the factory functions can mint a `Duration`.

## Clock

The `Clock` is a user-facing abstraction for driving virtual time
forward in a way that is uniform across timer systems. **It does not
drive any of test-kit's internal timing.** All test-kit waiter
deadlines and the harness safety timeout use real wall-clock,
unconditionally.

```typescript
export interface Clock {
    /**
     * Current time as milliseconds since epoch (or virtual equivalent
     * under fake clocks).
     */
    now(): number;

    /**
     * Advance virtual time by the given duration. For real clocks this
     * rejects (real time can't be advanced); for fake clocks this
     * delegates to the underlying fake-timer system.
     */
    advance(d: Duration): Promise<void>;
}

export function realClock(): Clock;
export function jestFakeClock(): Clock;
export function viFakeClock(): Clock;
export function sinonFakeClock(timers: SinonFakeTimers): Clock;
export function manualClock(): Clock & { tickAll(): Promise<void> };
```

The Clock interface is intentionally minimal. It does **not** expose
`setTimeout`/`clearTimeout` because the probe engine does not use the
Clock for its own scheduling — it uses real wall-clock timers directly
via `globalThis.setTimeout`. Adding scheduler methods to Clock would
imply (incorrectly) that the probe consults the active Clock for
internal timing.

Behavior:

- `realClock().advance(d)` rejects with `Error("realClock cannot advance
  time. Configure the harness with a fake clock to use clock.advance().")`.
- `jestFakeClock()` and `viFakeClock()` reject `advance` calls with
  `Error("jestFakeClock requires jest.useFakeTimers() to be active before
  clock.advance() is called.")` if their respective fake-timer systems
  aren't active.
- `sinonFakeClock(timers)` requires the user to pass an installed
  `FakeTimers` instance. The clock takes ownership of advancing it but
  does not install or uninstall it.
- `manualClock()` is a pure in-memory clock with no test-runner
  integration. `tickAll()` runs every scheduled callback whose deadline
  has passed. Useful for non-Jest/Vitest contexts.

`createHarness` auto-detects the active fake-timer system in this order:

1. `vi.isFakeTimers()` returns true → `viFakeClock()`.
2. `jest.isMockFunction(setTimeout)` or `jest.getTimerCount` is callable →
   `jestFakeClock()`.
3. otherwise → `realClock()`.

Tests using Sinon must pass `sinonFakeClock(timers)` explicitly because
Sinon does not expose a global "are fake timers active?" check that can
be relied upon.

### What The Clock Is Not Used For

- **Waiter deadlines for `expect.intercept`/`expect.observe`/`expect.atLeast`/
  `expect.exactly`** are real wall-clock timers, set with the underlying
  runtime's `setTimeout`. A forgotten `clock.advance` produces a clean
  timeout failure in the user-specified `within`, not a 30s hang.
- **The `none` assertion's wait** is a real wall-clock wait, not a
  virtual-time advance. See "expect.none" in the Expectations section
  for details.
- **The harness safety timeout** is a real wall-clock timer that
  catches genuinely hung tests as a last-resort failsafe.

The Clock exists to give the user a uniform API to drive SUT-internal
timers (the SUT's `setTimeout`s, scheduled tasks, retry loops). It
does not exist to control test-kit's own scheduling.

## Harness

```typescript
export interface Harness {
    readonly clock: Clock;
    readonly defaultTimeout: Duration;

    /**
     * Cross-probe expectations for asserting orderings across multiple
     * boundaries. See `HarnessExpectations` below.
     */
    readonly expect: HarnessExpectations;

    /**
     * Register an adapter for lifecycle management.
     *
     * Two overloads, single implementation: when given a Promise, the
     * implementation recurses on the resolved value, returning a
     * Promise that resolves to the registered adapter. The standard
     * usage pattern (`const db = await harness.attach(createProbedKyselyAdapter(...))`)
     * makes registration explicit in the await.
     *
     * Implementation sketch:
     *
     *     attach(adapter) {
     *         if (isClosed) throw new Error('Harness is closed.');
     *         if (isPromise(adapter)) return adapter.then((a) => this.attach(a));
     *         this.registered.push(adapter);
     *         return adapter;
     *     }
     */
    attach<T extends ProbedAdapter<any, any>>(adapter: T): T;
    attach<T extends ProbedAdapter<any, any>>(adapter: Promise<T>): Promise<T>;

    reset(options?: { keepRules?: boolean }): Promise<void>;
    close(): Promise<void>;
}

/**
 * Cross-probe expectations for asserting orderings across multiple
 * boundaries. Each entry in the array can be either an existing
 * Selection (capturing semantics) or an Observation (notify-only).
 *
 * Both helpers fail fast on out-of-order or missing observations: if
 * the expected sequence is not satisfied within `within`, the returned
 * Promise rejects with a clear diagnostic naming which step was
 * unmet.
 *
 * Each step's pending result has the same shape as if the user had
 * called `selection.expect.intercept` (for capturing steps) or
 * `selection.expect.observe` (for observation steps) on that
 * selection directly. The harness coordinator simply orchestrates
 * the ordering.
 */
export interface HarnessExpectations {
    /**
     * Wait for matching calls across selections in **strict order**.
     * Resolves with an array of pending captures / observations in the
     * same order as the input.
     *
     * Each step is one of:
     * - A `Selection<T, P>`: capturing intercept; the resolved entry is
     *   `P` (a pending call the test owns).
     * - An `Observation<T>`: non-capturing observation; the resolved
     *   entry is `T` (a snapshot of the call shape).
     *
     * Use `observation(selection)` to mark a step as non-capturing.
     */
    sequence<S extends ReadonlyArray<Selection<any, any> | Observation<any>>>(
        steps: S,
        options: RequiredWithinOptions,
    ): Promise<SequenceResult<S>>;

    /**
     * Wait for matching calls across selections in **any order**.
     * Resolves with an array of pending captures / observations in the
     * same order as the input.
     *
     * Same step shape as `sequence`. The harness considers the
     * expectation satisfied when each input step has matched at least
     * one call, regardless of arrival order across steps.
     */
    allOf<S extends ReadonlyArray<Selection<any, any> | Observation<any>>>(
        steps: S,
        options: RequiredWithinOptions,
    ): Promise<SequenceResult<S>>;
}

/**
 * Wraps a Selection to indicate "this step is observation-only, not
 * capture." Constructed via `observation(selection)`.
 */
export type Observation<TCall> = { readonly kind: 'observe'; readonly selection: Selection<TCall, any> };

export function observation<TCall>(selection: Selection<TCall, any>): Observation<TCall>;

/**
 * Maps each step in the input array to its result type:
 * - capturing Selection → its pending type
 * - Observation → its call shape
 */
export type SequenceResult<S extends ReadonlyArray<Selection<any, any> | Observation<any>>> = {
    [K in keyof S]:
        S[K] extends Selection<any, infer P> ? P :
        S[K] extends Observation<infer T> ? T :
        never;
};

export type CreateHarnessOptions = {
    readonly clock?: Clock;
    readonly defaultTimeout?: Duration;        // default seconds(5)
    readonly safetyTimeout?: Duration | null;  // default seconds(30); null disables
};

export function createHarness(options?: CreateHarnessOptions): Harness;
```

Behavior:

- `attach` is a single implementation with two type signatures (sync
  and Promise overloads). The sync path registers and returns the
  adapter unchanged. The Promise path recurses on the resolved value
  (`adapter.then((a) => this.attach(a))`), returning a Promise that
  resolves to the registered adapter. Standard usage is
  `const db = await harness.attach(createProbedKyselyAdapter(...))`,
  which makes registration explicit in the await.
- If `attach` is called after `close()`, it throws `Error("Harness is
  closed.")` synchronously (sync path) or rejects (Promise path).
- `reset(options?)`:
  - Calls `reset()` on every attached adapter (in registration order)
    that implements it. Adapters without `reset()` are skipped.
  - Calls `resetProbe()` on every attached probe by default, clearing
    user-installed rules and call history. Harness-installed default
    rules (e.g., backed-adapter `always().forward()`) are preserved.
  - With `{ keepRules: true }`, skips the `resetProbe()` step. Adapter
    `reset()` calls still run. Use this when a multi-step test wants
    a clean data slate but to keep its programmed rules.
- `close()` calls `close()` on every attached adapter in **reverse**
  registration order. After `close`, the harness:
  - cancels every in-flight live expectation registered through any
    attached probe with the error
    `"Harness closed with N unsettled waiter(s)."`,
  - rejects subsequent calls to `attach`/`reset`/`close` with the error
    `"Harness is closed."`.
- The `safetyTimeout` is a real-wall-clock failsafe, separate from
  per-expectation `within` deadlines. Every live expectation is raced
  against `globalThis.setTimeout(fail, safetyTimeout.milliseconds)`.
  If it fires, the expectation rejects with
  `"Test exceeded the harness safety timeout (30000ms wall-clock).
  This usually means the test is hung; check for missing settlements
  or unmet expectations."`. Set `safetyTimeout: null` to disable
  (not recommended).
- Per-expectation deadlines (`within`) also use real wall-clock,
  unconditionally. A forgotten `harness.clock.advance(...)` produces a
  fast `Timed out after Nms waiting for ...` failure rather than
  hanging until the safety timeout.

## Core Call Types

```typescript
export type CallMatcher<TCall> = (call: TCall) => boolean;
export type CallTypeGuard<TCall, TNarrow extends TCall> = (call: TCall) => call is TNarrow;

export type ExpectOptions = {
    readonly within?: Duration;
};

export type RequiredWithinOptions = {
    readonly within: Duration;
};
```

Positive expectations may omit `within` and use the harness `defaultTimeout`.
Negative expectations and `exactly` must require `within`.

## Selection

`Selection` is the unified read/write/observe interface. A probe **is** a
selection over all calls. There is no separate `Probe` type that wraps a
selection; the probe is the root selection.

```typescript
export interface Selection<TCall, TPending extends PendingCallBase<TCall>> {
    /**
     * Narrow the selection by a predicate.
     *
     * The optional label is used in timeout/assertion error messages
     * (`"Timed out waiting for call matching {label}"`). If omitted, the
     * label defaults to the predicate's `.name` if non-empty, else
     * "<anonymous predicate>".
     */
    filter(predicate: CallMatcher<TCall>, label?: string): Selection<TCall, TPending>;
    filter<TNarrow extends TCall>(
        predicate: CallTypeGuard<TCall, TNarrow>,
        label?: string,
    ): Selection<TNarrow, NarrowPending<TPending, TNarrow>>;

    /**
     * Program a one-shot rule for the next matching call.
     */
    once(): RuleBuilder<TCall, TPending>;

    /**
     * Program a permanent rule for matching calls.
     */
    always(): RuleBuilder<TCall, TPending>;

    /**
     * Expectations scoped to this selection.
     */
    readonly expect: Expectations<TCall, TPending>;

    /**
     * Historical calls matching this selection.
     *
     * Each access returns a fresh ReadonlyArray snapshot of the matching
     * calls in registration order. Mutating the returned array does not
     * affect probe state. Re-reading after new calls arrive returns a new
     * array reflecting the updated history.
     *
     * The history is unbounded by design. Tests are expected to be short-
     * lived and to construct a fresh harness per test (or per `it` block);
     * call accumulation across many tests is not a concern. If a single
     * test generates a very large number of calls and history size matters,
     * call `clearCalls()` periodically.
     */
    readonly calls: ReadonlyArray<TCall>;

    /**
     * Drain matching unsettled calls without settling them.
     *
     * The handler, if provided, receives each pending call in arrival
     * order. Already-settled calls (ones a rule has already resolved or
     * rejected) are skipped: drain operates on the still-open subset.
     */
    drain(handler?: (call: TPending) => void): void;

    /**
     * Drain and reject matching unsettled calls. Already-settled calls
     * are skipped.
     */
    drainAndReject(error?: unknown): void;
}

/**
 * Selections whose pending type supports forwarding gain `drainAndForward`.
 * Implemented by a conditional type so it appears only on backed
 * selections.
 */
export interface ForwardableSelection<TCall, TPending extends ForwardablePendingCall<TCall>>
    extends Selection<TCall, TPending> {
    once(): ForwardableRuleBuilder<TCall, TPending>;
    always(): ForwardableRuleBuilder<TCall, TPending>;
    drainAndForward(): void;
}
```

Probe root adds admin operations not available on chained selections:

```typescript
export type Probe<TCall, TPending extends PendingCallBase<TCall>> =
    Selection<TCall, TPending> & ProbeAdmin;

export interface ProbeAdmin {
    /**
     * Clear user-installed rules. Does not clear call history.
     *
     * `includeDefaults: true` also clears harness-installed default rules
     * (e.g., the implicit forward rule on backed adapters). Default false.
     */
    clearRules(options?: { includeDefaults?: boolean }): void;

    /**
     * Clear call history and consumed markers. Does not clear rules.
     */
    clearCalls(): void;

    /**
     * Equivalent to clearRules(options) + clearCalls().
     */
    resetProbe(options?: { includeDefaults?: boolean }): void;
}
```

Helper type:

```typescript
export type NarrowPending<TPending, TNarrow> =
    TPending extends PendingCallBase<infer TCall, infer TResult>
        ? TNarrow extends TCall
            ? PendingCallBase<TNarrow, TResult>
            : never
        : never;
```

## Rule Builder

`RuleBuilder` programs behavior for future matching calls.

```typescript
export interface RuleBuilder<TCall, TPending extends PendingCallBase<TCall>> {
    /**
     * Resolve matching calls with a fixed value.
     */
    answer(value: PendingAnswer<TPending>): void;

    /**
     * Resolve matching calls with a value computed from the call.
     *
     * The function may return a Promise; the engine awaits it.
     *
     * Failure modes propagate to the application's awaiting promise:
     * - `fn` throws synchronously → the application's promise rejects
     *   with the thrown value.
     * - `fn` returns a Promise that rejects → the application's
     *   promise rejects with the same reason.
     * - `fn` returns a Promise that hangs forever → the application's
     *   promise also hangs. This is treated as a user error: the test
     *   author wrote a non-resolving rule. The harness safety timeout
     *   eventually fires and fails the test with the standard hung-
     *   test message; the `answerWith` failure is not specially
     *   diagnosed.
     *
     * Garbage in, garbage out. The library does not attempt to detect
     * or rescue malformed `answerWith` functions.
     */
    answerWith(
        fn: (call: TCall) => PendingAnswer<TPending> | Promise<PendingAnswer<TPending>>,
    ): void;

    /**
     * Reject matching calls with the given error.
     */
    reject(error: unknown): void;

    /**
     * Match the call but never settle it. Use to silence a default rule
     * (e.g., a backed adapter's default forward) for a specific selection
     * while leaving the SUT to handle the silence (timeout, retry, etc.).
     */
    park(): void;
}

export interface ForwardableRuleBuilder<TCall, TPending extends ForwardablePendingCall<TCall>>
    extends RuleBuilder<TCall, TPending> {
    /**
     * Forward matching calls to the backing implementation.
     */
    forward(): void;
}
```

`PendingAnswer<TPending>` extracts the successful resolved value type:

```typescript
export type PendingAnswer<TPending> =
    TPending extends PendingCallBase<unknown, infer TResult>
        ? Awaited<TResult>
        : unknown;
```

Summary of rule resolution (full details in "Rule Matching Semantics"
below):

- **Tier 1a — observers (notify-only, FIFO)**: matching observers are
  notified first. Observers do not consume. Resolution continues.
- **Tier 1b — capturing waiters (intercept, FIFO)**: oldest matching
  intercept consumes the call. Resolution stops.
- **Tier 2 — one-shot rules (single global FIFO queue)**: oldest
  matching `once()` rule fires and is removed. One-shots beat all
  permanents.
- **Tier 3 — permanent rules (LIFO stack)**: newest matching `always()`
  rule fires. Harness-installed defaults sit at the bottom.
- **Default**: no match in any tier → call parks. Tests can settle it
  retroactively via `expect.intercept`, or the harness safety timeout
  fires.

Filter chains attached to selections are conjunctive: a call must
satisfy every predicate in the chain to count as a match for any rule
registered on that selection.

## Expectations

```typescript
export interface Expectations<TCall, TPending extends PendingCallBase<TCall>> {
    /**
     * Wait for the next matching call and capture it. The intercept wins
     * over rules: when a matching call arrives in the future, it
     * becomes a pending call owned by the test, and no rule (one-shot
     * or permanent) fires for that call.
     *
     * Retroactive matching: an `intercept` registered after a matching
     * call has already arrived may capture it retroactively, **iff the
     * call is unclaimed** — meaning it parked because no rule of any
     * kind matched it. Calls that any rule has fired against are not
     * retroactively interceptable.
     *
     * Eligibility table:
     *
     * | Prior state of the matching call               | Retroactive? |
     * | ----------------------------------------------- | ------------ |
     * | Parked because no rule matched                  | yes          |
     * | Caught by `once().park()` or `always().park()`  | no           |
     * | Settled by `forward()`/`answer*()`/`reject()`   | no           |
     *
     * Rule-parked calls are excluded because the park rule is the
     * user's explicit declaration that the call is intentionally
     * hanging; a later intercept silently overriding that intent would
     * be confusing. If the test wants both "park by default" and
     * "intercept on demand," it should pre-register the intercept
     * (which beats all rules at tier 1b) instead of using a park rule.
     *
     * Settled calls are excluded because the application's awaiting
     * promise has already resolved or rejected; there is no ownership
     * to hand to the test.
     *
     * There is no race condition between concurrent `intercept` and
     * `forward()` (or any other settlement). JavaScript's
     * single-threaded execution makes call routing deterministic: if
     * the test pre-registers the intercept (in source order before
     * the SUT triggers the call), tier 1b captures and the rule
     * doesn't fire. If the test registers the intercept after the
     * SUT has triggered the call and a rule has already fired, the
     * call is no longer eligible — the test must use the pre-register
     * pattern instead.
     *
     * Uses the harness `defaultTimeout` when `within` is omitted.
     */
    intercept(options?: ExpectOptions): Promise<TPending>;

    /**
     * Wait for the next matching call without capturing it. The matching
     * rule still fires; the returned object is a read-only view of the
     * call shape (the same `TCall` shape as `selection.calls[i]`).
     *
     * Uses the harness `defaultTimeout` when `within` is omitted.
     */
    observe(options?: ExpectOptions): Promise<TCall>;

    /**
     * Assert that no matching call arrives within the given time window.
     *
     * Implemented as a real wall-clock wait of `within` milliseconds
     * followed by a microtask flush and a history check. Does **not**
     * advance virtual time; the SUT's fake-time-scheduled side effects
     * are not triggered by this assertion.
     *
     * For fast negative checks under fake timers, advance the clock
     * explicitly first and then assert silence with `within: ms(0)`:
     *
     *     await harness.clock.advance(seconds(5));
     *     await probe.expect.none({ within: ms(0) });
     *
     * `within: ms(0)` means "after a microtask flush": no real wait,
     * just verify that no matching call has been recorded right now.
     *
     * `within` is required.
     */
    none(options: RequiredWithinOptions): Promise<void>;

    /**
     * Resolve as soon as `n` matching calls have been recorded, or reject
     * on timeout. Does not detect over-call.
     */
    atLeast(n: number, options: ExpectOptions): Promise<ReadonlyArray<TCall>>;

    /**
     * Wait the full `within` window, then assert that exactly `n` matching
     * calls have been recorded. Slower; precise.
     *
     * `within` is required.
     */
    exactly(n: number, options: RequiredWithinOptions): Promise<ReadonlyArray<TCall>>;

    /**
     * Synchronous: assert that the current matching call count equals `n`.
     */
    calledTimes(n: number): void;

    /**
     * Synchronous: assert that no matching calls exist in the current
     * history.
     */
    neverCalled(): void;

    /**
     * Synchronous: assert that at least one matching call exists in the
     * current history.
     */
    called(): void;
}
```

Expectation naming rules:

- Use `intercept`/`observe`/`none`/`atLeast`/`exactly` only.
- Do not provide `.within(...)` chain syntax.
- Do not invent `nextWithin`, `noCallWithin`, `expectNWithin` aliases.
- There is no `expect.next` alias. The canonical name is `intercept`.

## Pending Calls

```typescript
export interface PendingCallBase<TCall, TResult = unknown> {
    readonly call: TCall;
    readonly settled: boolean;

    answer(value: Awaited<TResult>): void;
    answerWith(fn: (call: TCall) => Awaited<TResult> | Promise<Awaited<TResult>>): void;
    reject(error: unknown): void;
}

export interface ForwardablePendingCall<TCall, TResult = unknown>
    extends PendingCallBase<TCall, TResult> {
    forward(): void;
}
```

There is no `park()` method on pending calls. Doing nothing achieves the
same effect, and the documentary value of an explicit no-op method is
not worth the API surface.

Domain pending calls expose call properties directly for ergonomic tests:

```typescript
export interface MethodPendingCall<
    TMethod extends string = string,
    TArgs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
    TResult = unknown,
> extends PendingCallBase<MethodCall<TMethod, TArgs>, TResult> {
    readonly method: TMethod;
    readonly args: TArgs;
}

export interface QueryPendingCall<TResult = unknown>
    extends ForwardablePendingCall<QueryCall, TResult> {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
}
```

Pending call rules:

- Calling any settlement method after settlement throws
  `Error("Pending call '{label}' is already settled.")` synchronously,
  where `{label}` is the domain-specific identifier (method name, command
  name, SQL excerpt, etc.).
- Settlement methods are synchronous from the test perspective. The
  application's awaiting promise resolves or rejects on the next microtask
  per normal JavaScript semantics.
- `forward()` on a hybrid backed adapter must throw a clear error if the
  call is one the backing does not support, e.g.:
  `"Cannot forward S3 command 'CreateMultipartUploadCommand': no local
  backing implementation supports it. Use .answer(...) or .reject(...)."`.

## Mock Adapter API

Package: `@vnatures/test-kit-mock`.

```typescript
export type MethodCall<
    TMethod extends string = string,
    TArgs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
> = {
    readonly method: TMethod;
    readonly args: TArgs;
};

/**
 * All method names on T (sync and async). Used internally by other
 * helpers; not the constraint applied to `methods`.
 */
export type MethodName<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => any ? Extract<K, string> : never;
}[keyof T];

/**
 * Method names on T that return `Promise<...>` directly. This is the
 * constraint applied to the `methods` parameter of createProbedMock.
 *
 * Methods returning `T`, `T | Promise<T>`, `[Promise<T>, U]`,
 * `Observable<T>`, `AsyncIterable<T>`, etc. are all considered sync for
 * proxy purposes — only direct `Promise<X>` returns are async.
 */
export type AsyncMethodName<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => Promise<unknown>
        ? Extract<K, string>
        : never;
}[keyof T];

/**
 * Method names on T that exist as methods but do NOT return Promise<...>.
 * Used in compile-time error messages to name offending methods.
 */
export type SyncMethodName<T> = Exclude<MethodName<T>, AsyncMethodName<T>>;

export type MethodArgs<T, K extends MethodName<T>> =
    T[K] extends (...args: infer A) => any ? A : never;

export type MethodResolvedReturn<T, K extends MethodName<T>> =
    T[K] extends (...args: any[]) => infer R ? Awaited<R> : never;

/**
 * Compile-time guard applied to the `methods` parameter. If every name in
 * `M` is async, returns `M` unchanged. Otherwise, returns a branded error
 * type whose property names are visible in the TS diagnostic.
 */
export type CheckedMethods<T, M extends ReadonlyArray<string>> =
    Exclude<M[number], AsyncMethodName<T>> extends never
        ? M
        : ReadonlyArray<AsyncMethodName<T>> & {
              readonly __test_kit_error: 'createProbedMock requires methods that return Promise<...>';
              readonly __sync_methods_cannot_be_probed: Exclude<M[number], AsyncMethodName<T>>;
              readonly __how_to_fix:
                  "For sync dependencies, use the real implementation in tests. See 'Synchronous Dependencies: Use The Real Thing' in the docs.";
          };

export interface MethodProbe<T extends object>
    extends Probe<MethodCall<AsyncMethodName<T>>, MethodPendingCall<AsyncMethodName<T>>> {
    on<K extends AsyncMethodName<T>>(method: K): MethodSelection<T, K>;
}

export interface MethodSelection<T extends object, K extends AsyncMethodName<T>>
    extends Selection<
        MethodCall<K, MethodArgs<T, K>>,
        MethodPendingCall<K, MethodArgs<T, K>, MethodResolvedReturn<T, K>>
    > {
    once(): RuleBuilder<
        MethodCall<K, MethodArgs<T, K>>,
        MethodPendingCall<K, MethodArgs<T, K>, MethodResolvedReturn<T, K>>
    >;
    always(): RuleBuilder<
        MethodCall<K, MethodArgs<T, K>>,
        MethodPendingCall<K, MethodArgs<T, K>, MethodResolvedReturn<T, K>>
    >;
}

export type ProbedMock<T extends object> = ProbedAdapter<T, MethodProbe<T>> & ProbedResource;

export type CreateProbedMockOptions<T extends object, M extends readonly string[]> = {
    /**
     * Required: explicit list of async methods on T that the proxy will
     * intercept. The CheckedMethods<T, M> conditional type produces a
     * branded error type when M contains any sync method names, causing
     * a TypeScript compile error whose diagnostic names the offending
     * method explicitly. Any property access not in M returns undefined.
     */
    readonly methods: CheckedMethods<T, M>;

    /**
     * Override the harness's defaultTimeout for expectations on this probe.
     */
    readonly defaultTimeout?: Duration;
};

/**
 * The constraint on M is intentionally loose (`readonly string[]`) so
 * that `CheckedMethods<T, M>` runs at the parameter position with the
 * full inferred M and can produce its branded error. A tighter
 * constraint (e.g. `M extends readonly AsyncMethodName<T>[]`) would
 * cause TypeScript to reject sync methods at the constraint check
 * before CheckedMethods sees them, producing a generic and unhelpful
 * diagnostic.
 *
 * The default (`readonly AsyncMethodName<T>[]`) makes single-type-
 * parameter calls (`createProbedMock<UserService>({ methods: [...] })`)
 * work without explicit M.
 */
export function createProbedMock<
    T extends object,
    const M extends readonly string[] = readonly AsyncMethodName<T>[],
>(options: CreateProbedMockOptions<T, M>): ProbedMock<T>;
```

Behavior:

- The proxy's `get` trap returns a function only for keys in `methods`.
  For symbol keys and string keys not in `methods`, returns `undefined`.
  This applies unconditionally and requires no allowlist or
  passthrough configuration — see "Framework Probe Compatibility" in the
  concepts document for the consequences.
- Calls to listed methods always return a `Promise`. Without a matching
  rule, the call parks (the returned promise stays pending until the
  test settles it via `expect.intercept` or until the harness safety
  timeout fires).
- `reset()` is implemented as `clearCalls()` on the probe.
  `close()` is implemented as `clearRules({ includeDefaults: true })` +
  `clearCalls()`.

Type behavior on sync methods:

```typescript
interface FlagClient {
    isEnabled(flag: string): boolean;       // sync — should be real
    refresh(): Promise<void>;               // async — leaf boundary
}

createProbedMock<FlagClient>({ methods: ['isEnabled', 'refresh'] });
//                                       ~~~~~~~~~~~
// TS error:
//   Type 'readonly ["isEnabled", "refresh"]' is not assignable to parameter
//   of type 'readonly AsyncMethodName<FlagClient>[] & {
//     __test_kit_error: 'createProbedMock requires methods that return Promise<...>';
//     __sync_methods_cannot_be_probed: "isEnabled";
//     __how_to_fix: "For sync dependencies, use the real implementation in tests...";
//   }'.

createProbedMock<FlagClient>({ methods: ['refresh'] }); // OK
```

The fix is not to omit `isEnabled` from the list while spread-composing
a stub onto the adapter — the fix is to inject a real `FlagClient`
implementation in the test. See "Synchronous Dependencies: Use The Real
Thing" in the concepts document.

There is no runtime sync/async detection. The TypeScript constraint is
the only line of defense. Users who escape it via `as any` get a proxy
that returns `undefined` from any sync method that slipped through, and
the SUT will fail naturally at the first interaction.

Usage:

```typescript
interface UserService {
    getUser(id: number): Promise<{ id: number; name: string }>;
    updateUser(id: number, patch: Partial<User>): Promise<User>;
}

const users = createProbedMock<UserService>({
    methods: ['getUser', 'updateUser'],
});

users.probe.on('getUser').always().answer({ id: 1, name: 'Alice' });

const pending = await users.probe.on('getUser').expect.intercept();
expect(pending.args).toEqual([1]);
pending.answer({ id: 1, name: 'Bob' });
```

For boundaries that mix sync and async members, the design prescription
is to **split the boundary**, not to stub the sync members in tests. The
async leaf becomes the test-kit boundary; the sync part becomes a
separate injectable that runs for real in tests. See "Synchronous
Dependencies: Use The Real Thing" in the concepts document for the full
rationale and examples.

### Why `methods` Is Not Auto-Derived From `T`

A recurring proposal: rather than ask the user to enumerate methods,
infer them from `T` automatically (a `methods: 'all'` mode, or a
zero-config default that intercepts every async method on `T`). This is
not implemented in v2, and the design rejects it for v2.+.

TypeScript types are erased at compile time. `T` in
`createProbedMock<T>()` is a phantom that does not survive to runtime.
There is no portable way to materialize the list of `T`'s methods inside
the running mock factory. Every mechanism that has been considered fails
on at least one of: portability, framework compatibility, or correctness.

| Approach | Why rejected |
| --- | --- |
| Default to "intercept every property; allowlist known framework probes to undefined" | Reintroduces the v1 whack-a-mole. Every new framework, decorator, or runtime that probes the proxy with an unanticipated property breaks the mock until we add the property to a maintained list. The `methods` array exists precisely to close this category. |
| `Object.getOwnPropertyNames(T.prototype)` for class-typed `T` | Most leaf boundaries are typed as interfaces, not classes. Adding a class-only fast path is API complexity for a minority case and pulls in inherited members and non-method properties. |
| Reflect from a sample instance the user passes in | Most boundaries don't have a cheap default constructor. Forcing the user to construct one is a worse burden than the methods array. |
| `reflect-metadata` decorators on the boundary interface | Only works on decorated classes (e.g., NestJS-style). Plain interfaces cannot carry decorators. Imposes a runtime metadata dependency on every consumer of test-kit. |
| Custom Babel/SWC/TypeScript transformer to inject the list at build time | Has to work uniformly across tsc, swc, esbuild, Vite, ts-node, Bun, ts-jest, and Vitest's esbuild path. Adoption nightmare. The test-kit OSS audience cannot converge on a single bundler. |
| `ts-morph` code generation step | Requires a separate generation pass; users must re-run it after editing interfaces; CI must verify generated artifacts are fresh. Heavy build-tool burden. |
| `methods: 'all'` runtime sentinel | Requires a runtime list of method names; we don't have one. Either the proxy intercepts everything (whack-a-mole) or it intercepts nothing (broken). |

The explicit `methods` array is not a placeholder for a future
auto-derivation. It is the ceiling of what is portable in TypeScript
today. The cost is a few entries per probed mock; the benefit is zero
allowlist maintenance, immunity to future framework probes, no build-
tool requirement, and a self-documenting record at every test of which
boundary surface the test exercises.

If a future TC39 proposal ships runtime type information that survives
type erasure, the design can be revisited.

## Stream Mock Adapter API

Package: `@vnatures/test-kit-mock`. Sibling of the Mock Adapter API above,
for boundaries shaped `(...) => AsyncIterable<TChunk>` (typically an
`async *stream()` generator method) rather than `(...) => Promise<T>`. A
Promise settles once; a stream yields zero-or-more chunks over time and
then completes or fails — `createProbedMock`'s `AsyncMethodName<T>`
constraint rejects generator methods at compile time by design (see "Mock
Adapter API" above), so this is a separate factory, not an option flag.

```typescript
export type StreamMethodCall<
    TMethod extends string = string,
    TArgs extends ReadonlyArray<unknown> = ReadonlyArray<unknown>,
> = {
    readonly method: TMethod;
    readonly args: TArgs;
};

/** Method names on T whose return type is `AsyncIterable<...>`. This is the constraint applied to `methods`. */
export type StreamMethodName<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => AsyncIterable<any> ? Extract<K, string> : never;
}[keyof T];

export type StreamMethodArgs<T, K extends keyof T> = T[K] extends (...args: infer A) => any ? A : never;

/** The chunk type yielded by T[K] — e.g. `ModelStreamEvent` for `stream(...): AsyncIterable<ModelStreamEvent>`. */
export type StreamMethodChunk<T, K extends keyof T> =
    T[K] extends (...args: any[]) => AsyncIterable<infer C> ? C : never;

/** Same branded-error mechanism as `CheckedMethods` — see that entry for the rationale. */
export type CheckedStreamMethods<T, M extends ReadonlyArray<string>> =
    Exclude<M[number], StreamMethodName<T>> extends never
        ? M
        : ReadonlyArray<StreamMethodName<T>> & {
              readonly __test_kit_error: 'createProbedStreamMock requires methods that return AsyncIterable<...> (e.g. an async generator method)';
              readonly __non_stream_methods_cannot_be_probed: Exclude<M[number], StreamMethodName<T>>;
              readonly __how_to_fix: 'For Promise-returning methods use createProbedMock. For sync dependencies, use the real implementation in tests.';
          };

export interface StreamMethodProbe<T extends object>
    extends StreamProbe<StreamMethodCall<StreamMethodName<T>>, StreamMethodPendingCall<StreamMethodName<T>>> {
    on<K extends StreamMethodName<T>>(method: K): StreamMethodSelection<T, K>;
}

export interface StreamMethodSelection<T extends object, K extends StreamMethodName<T>>
    extends StreamSelection<
        StreamMethodCall<K, StreamMethodArgs<T, K>>,
        StreamMethodPendingCall<K, StreamMethodArgs<T, K>, StreamMethodChunk<T, K>>
    > {
    once(): StreamRuleBuilder<StreamMethodCall<K, StreamMethodArgs<T, K>>, StreamMethodChunk<T, K>>;
    always(): StreamRuleBuilder<StreamMethodCall<K, StreamMethodArgs<T, K>>, StreamMethodChunk<T, K>>;
}

export type ProbedStreamMock<T extends object> = ProbedAdapter<T, StreamMethodProbe<T>> & ProbedResource;

export type CreateProbedStreamMockOptions<T extends object, M extends readonly string[]> = {
    readonly methods: CheckedStreamMethods<T, M>;
    readonly defaultTimeout?: Duration;
    /** Optional harness reference; inherits defaultTimeout / safetyTimeout / clock when provided. */
    readonly harness?: HarnessRef;
};

export function createProbedStreamMock<
    T extends object,
    const M extends readonly string[] = readonly StreamMethodName<T>[],
>(options: CreateProbedStreamMockOptions<T, M>): ProbedStreamMock<T>;
```

Behavior:

- The adapter's proxied methods return the consumer-facing async iterable
  **synchronously** — never a Promise — so `for await (const x of
  adapter.method())` works immediately, matching a real generator method's
  calling convention.
- `StreamRuleBuilder` replaces `answer`/`answerWith`/`reject` semantics with
  a sequence: `.answer(chunks)` pushes every chunk then ends; `.answerWith(fn)`
  does the same with a call-derived source, and if that source throws
  partway through, the consumer's iteration throws at that point instead of
  completing — this is how "yields N chunks then fails" is expressed.
  `.reject(error)` fails before any chunk is pushed. `.park()` never closes
  (the consumer's `next()` hangs; pair with `expect.intercept` timeouts or
  `harness.clock`).
- The pending call from `expect.intercept()` exposes `push`/`end`/`error`
  instead of `answer`/`reject`, so a test can interactively drive the
  consumer's iteration one chunk at a time. `settled` flips to `true` only
  on `end()`/`error()` — `push()` remains legal until then.
- Built on a parallel core engine (`createStreamProbeRoot`), not a
  generalization of `createProbeRoot`: see `stream-probe-engine.ts`'s header
  comment for why the two settlement models (single Promise vs. multi-value
  channel) aren't unified.
- If the real dependency is a concrete class (e.g. an SDK's abstract `Model`
  base class) rather than a plain interface, wrap the mock's `adapter` in a
  thin subclass that delegates to it — see the `component-testing` skill's
  "Streaming Boundaries" section for a worked example.

Usage:

```typescript
interface Model {
    stream(prompt: string): AsyncIterable<{ text: string }>;
}

const model = createProbedStreamMock<Model>({ methods: ['stream'] });
model.probe.on('stream').always().answer([{ text: 'hel' }, { text: 'lo' }]);

for await (const chunk of model.adapter.stream('hi')) {
    // chunk.text: "hel", then "lo"
}
```

## Backed Database Adapters

Packages: `@vnatures/test-kit-pg-kysely`, `@vnatures/test-kit-pg-knex`, `@vnatures/test-kit-pg-sequelize`.

All three packages share the same probe surface, defined in `@vnatures/test-kit`
(or a sibling `@vnatures/test-kit-sql` package). What differs across them is the
`adapter` type (Kysely, Knex, Sequelize instance) and the construction
mechanics (which underlying driver wraps PGlite, how schema bootstrap is
expressed). The probe API is identical.

### Shared probe types

```typescript
export type QueryCall = {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
};

export interface QueryPendingCall<TResult = unknown>
    extends ForwardablePendingCall<QueryCall, TResult> {
    readonly sql: string;
    readonly parameters: ReadonlyArray<unknown>;
}

export interface QueryProbe extends Probe<QueryCall, QueryPendingCall> {
    /**
     * Typed sugar over filter for SQL matching. Strings match by exact
     * equality; RegExps by .test(); functions by predicate.
     */
    sql(match: string | RegExp | ((sql: string) => boolean)): ForwardableSelection<QueryCall, QueryPendingCall>;
}
```

### Per-ORM factory shapes

```typescript
// @vnatures/test-kit-pg-kysely
export type ProbedKyselyAdapter<DB> = ProbedAdapter<Kysely<DB>, QueryProbe> & ProbedResource & {
    seed<Table extends keyof DB & string>(
        table: Table,
        rows: ReadonlyArray<Insertable<DB[Table]>>,
    ): Promise<void>;
};

export type CreateProbedKyselyAdapterOptions<DB> = {
    readonly harness: Harness;
    readonly bootstrap: (db: Kysely<DB>) => Promise<void>;
    readonly extensions?: Record<string, unknown>;
    readonly defaultTimeout?: Duration;
};

export function createProbedKyselyAdapter<DB>(
    options: CreateProbedKyselyAdapterOptions<DB>,
): Promise<ProbedKyselyAdapter<DB>>;

// @vnatures/test-kit-pg-knex
export type ProbedKnexAdapter = ProbedAdapter<Knex, QueryProbe> & ProbedResource & {
    seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
};

export type CreateProbedKnexAdapterOptions = {
    readonly harness: Harness;
    readonly bootstrap: (knex: Knex) => Promise<void>;
    readonly defaultTimeout?: Duration;
};

export function createProbedKnexAdapter(
    options: CreateProbedKnexAdapterOptions,
): Promise<ProbedKnexAdapter>;

// @vnatures/test-kit-pg-sequelize
export type ProbedSequelizeAdapter = ProbedAdapter<Sequelize, QueryProbe> & ProbedResource & {
    seed<M extends Model>(
        modelClass: ModelStatic<M>,
        rows: ReadonlyArray<Partial<M['_attributes']>>,
    ): Promise<void>;
};

export type CreateProbedSequelizeAdapterOptions = {
    readonly harness: Harness;
    readonly bootstrap: (sequelize: Sequelize) => Promise<void>;
    readonly defaultTimeout?: Duration;
};

export function createProbedSequelizeAdapter(
    options: CreateProbedSequelizeAdapterOptions,
): Promise<ProbedSequelizeAdapter>;
```

The differences across factories are confined to:

1. The `adapter` type (typed instance of the ORM).
2. The `bootstrap` callback's signature (typed for the ORM).
3. The `seed` helper's input shape (typed for the ORM's idiom).

Everything else — `harness`, `defaultTimeout`, the returned `probe`, the
`reset`/`close` lifecycle — is identical. This consistency means that a
test author who knows one of the three knows the others.

### Behavior (shared)

- Each factory installs a default rule: `probe.always().forward()` at the
  bottom of the rule stack.
- `reset()` truncates all user tables (the bootstrap-defined schema is
  preserved). Equivalent to dropping and recreating the data, not the
  schema. The exact mechanism is ORM-specific (Kysely/Knex use raw
  truncate; Sequelize uses model-level `destroy({ truncate: true })` or
  raw truncate via the underlying driver).
- `close()` shuts down the underlying PGlite instance and the ORM's
  connection pool. After `close()`, all probe operations throw.
- Bootstrap, `seed`, and `reset` use a maintenance connection that
  bypasses the probe entirely (calls made by these helpers are **not**
  recorded in call history and are **not** subject to user rules).
- Application queries through `adapter` are recorded by the probe and
  subject to rule resolution.
- The factory accepts a `harness` parameter and wires the harness's
  clock, `defaultTimeout`, and safety-timeout configuration into the
  probe. The factory does NOT call `harness.attach` itself; callers do
  `await harness.attach(createProbedKyselyAdapter({ harness, ... }))`
  to register the result for lifecycle.

### Usage

```typescript
const harness = createHarness();
const db = await harness.attach(createProbedKyselyAdapter<Database>({
    harness,
    bootstrap,
}));

const insert = db.probe
    .sql(/insert into orders/i)
    .expect.intercept({ within: seconds(1) });

const resultPromise = service.createOrder(input);

const pending = await insert;
expect(pending.parameters).toContain(input.userId);
pending.forward();

await resultPromise;

afterAll(() => harness.close());
```

## Cache Adapter API

Package: `@vnatures/test-kit-redis`.

```typescript
export type CacheKeyInput = string | { format: string; args: ReadonlyArray<string | number> };

export interface CacheAdapter {
    get<T>(key: CacheKeyInput): Promise<T | null>;
    set<T>(input: { key: CacheKeyInput; val: T }, ttl?: Duration): Promise<boolean>;
    del(key: CacheKeyInput): Promise<void>;
    setnx<T>(input: { key: CacheKeyInput; val: T }, options: { ttl: Duration }): Promise<T>;
    getSet<T>(
        key: CacheKeyInput,
        load: () => Promise<T>,
        options?: { ttl?: Duration | ((result: T) => Duration) },
    ): Promise<T>;
}

export type CacheMethod = 'get' | 'set' | 'del' | 'setnx' | 'getSet';

export type CacheCall = {
    readonly method: CacheMethod;
    readonly args: ReadonlyArray<unknown>;
};

export interface CachePendingCall<TResult = unknown>
    extends ForwardablePendingCall<CacheCall, TResult> {
    readonly method: CacheMethod;
    readonly args: ReadonlyArray<unknown>;
}

export interface CacheProbe extends Probe<CacheCall, CachePendingCall> {
    on(method: CacheMethod): ForwardableSelection<CacheCall, CachePendingCall>;
}

export type ProbedCacheAdapter = ProbedAdapter<CacheAdapter, CacheProbe> & ProbedResource;

export type CreateProbedCacheAdapterOptions = {
    readonly harness: Harness;
    readonly defaultTimeout?: Duration;
};

export function createProbedCacheAdapter(
    options: CreateProbedCacheAdapterOptions,
): ProbedCacheAdapter;
```

Behavior:

- The factory installs a default `probe.always().forward()` rule.
- `reset()` flushes the underlying `ioredis-mock` instance.
- `close()` disposes the underlying instance.

Usage:

```typescript
const cache = harness.attach(createProbedCacheAdapter({ harness }));

cache.probe.on('get').once().reject(new Error('redis down'));
```

## Bull Queue Adapter API

Package: `@vnatures/test-kit-bull`.

```typescript
export type BullQueueMethod = 'add' | 'process';

export type BullQueueCall = {
    readonly method: BullQueueMethod;
    readonly args: ReadonlyArray<unknown>;
};

export interface BullQueuePendingCall<TResult = unknown>
    extends ForwardablePendingCall<BullQueueCall, TResult> {
    readonly method: BullQueueMethod;
    readonly args: ReadonlyArray<unknown>;
}

export interface BullQueueProbe extends ForwardableProbe<BullQueueCall, BullQueuePendingCall> {
    on(method: BullQueueMethod): ForwardableSelection<BullQueueCall, BullQueuePendingCall>;
}

export type ProbedBullQueue<TData = unknown> = ProbedAdapter<Queue<TData>, BullQueueProbe> &
    ProbedResource & { readonly name: string };

// Job options accepted by `add` (and `defaultJobOptions`). `delay` and `jobId`
// are honored by the in-memory backing; other Bull options are recorded but
// not interpreted.
export type AddOptions = {
    readonly delay?: number;
    readonly jobId?: string | number;
    readonly [key: string]: unknown;
};

export type CreateProbedBullQueueOptions<TData = unknown> = {
    readonly harness: Harness;
    readonly name?: string;
    readonly defaultJobOptions?: AddOptions;
    readonly defaultTimeout?: Duration;
    // Inject a custom/pre-seeded in-memory backing (advanced; defaults to a
    // fresh InMemoryBullQueue).
    readonly backing?: InMemoryBullQueue<TData>;
};

export function createProbedBullQueue<TData = unknown>(
    options: CreateProbedBullQueueOptions<TData>,
): ProbedBullQueue<TData>;

export function maxRetriesPerRequestError(message?: string): Error;
```

Behavior:

- The factory installs a default `probe.always().forward()` rule.
- `add` is the primary probed seam for failure/hang injection.
- `process` supports unnamed and named handlers (`process(name, handler)`);
  named jobs are consumed only by their matching processor, as in Bull. The
  `concurrency` overload arg is accepted but ignored (no observable effect in a
  deterministic in-memory runner).
- The adapter exposes `name` (the queue identifier), matching `bull.Queue`.
- Unsupported `Queue` methods throw `errors.unsupportedForward('Bull', method)`.
- `reset()` empties the in-memory queue.
- `close()` disposes the backing.

Usage:

```typescript
const queue = harness.attach(createProbedBullQueue({ harness, name: 'exports' }));

queue.probe.on('add').once().reject(maxRetriesPerRequestError());
```

## S3 Adapter API

Package: `@vnatures/test-kit-s3`.

```typescript
export type S3Call<TCommand = unknown> = {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
};

export interface S3PendingCall<TCommand = unknown, TResult = unknown>
    extends ForwardablePendingCall<S3Call<TCommand>, TResult> {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
}

export type S3CommandConstructor = new (...args: any[]) => {
    readonly input: unknown;
};

export interface S3Probe extends Probe<S3Call, S3PendingCall> {
    /**
     * Typed sugar. When given a constructor, returns a selection narrowed
     * to that command's instance type. When given a string, matches by
     * commandName.
     */
    command<C extends S3CommandConstructor>(
        ctor: C,
    ): ForwardableSelection<S3Call<InstanceType<C>>, S3PendingCall<InstanceType<C>>>;
    command(name: string): ForwardableSelection<S3Call, S3PendingCall>;
}

export type ProbedS3Adapter = ProbedAdapter<S3Client, S3Probe> & ProbedResource & {
    readonly bucket: string;
    readonly localDirectory: string;
};

export type CreateProbedS3AdapterOptions = {
    readonly harness: Harness;
    readonly bucket: string;
    readonly localDirectory?: string;
    readonly defaultTimeout?: Duration;
};

export function createProbedS3Adapter(options: CreateProbedS3AdapterOptions): ProbedS3Adapter;
```

Behavior:

- The factory installs a default `probe.always().forward()` rule.
- Commands the local backing does not support fail loudly when forwarded:
  `"Cannot forward S3 command '{commandName}': no local backing
  implementation supports it. Use .answer(...) or .reject(...)."`
- Tests can answer unsupported commands explicitly (no fallback to the real
  AWS SDK).
- `reset()` empties the local directory's content for the configured
  bucket.
- `close()` removes the temporary local directory if the factory created it.

## Presigner Adapter API

Package: `@vnatures/test-kit-s3` (alongside the S3 client adapter).

The presigner is **not** backed: real signing requires real credentials and
real AWS semantics, which test-kit does not emulate.

```typescript
export interface PresignerAdapter {
    signUrl: typeof getSignedUrl;
}

export type PresignCall = {
    readonly commandName: string;
    readonly commandInput: unknown;
    readonly options: RequestPresigningArguments | undefined;
};

export interface PresignPendingCall<TResult = string>
    extends PendingCallBase<PresignCall, TResult> {
    readonly commandName: string;
    readonly commandInput: unknown;
    readonly options: RequestPresigningArguments | undefined;
}

export interface PresignerProbe extends Probe<PresignCall, PresignPendingCall> {
    command<C extends S3CommandConstructor>(
        ctor: C,
    ): Selection<PresignCall, PresignPendingCall>;
    command(name: string): Selection<PresignCall, PresignPendingCall>;
}

export type ProbedPresignerAdapter = ProbedAdapter<PresignerAdapter, PresignerProbe> & ProbedResource;

export type CreateProbedPresignerAdapterOptions = {
    readonly harness: Harness;
    readonly defaultTimeout?: Duration;
};

export function createProbedPresignerAdapter(
    options: CreateProbedPresignerAdapterOptions,
): ProbedPresignerAdapter;
```

Behavior:

- No default rule is installed. Presign calls park by default until the
  test answers or rejects them.
- Selections do not implement `forward()`; the pending type is not
  `ForwardablePendingCall`.

## SQS Adapter API

Package: `@vnatures/test-kit-sqs`.

```typescript
export type SqsCall<TCommand = unknown> = {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
};

export interface SqsPendingCall<TCommand = unknown, TResult = unknown>
    extends ForwardablePendingCall<SqsCall<TCommand>, TResult> {
    readonly commandName: string;
    readonly command: TCommand;
    readonly input: unknown;
}

export type SqsCommandConstructor = new (...args: any[]) => {
    readonly input: unknown;
};

export interface SqsProbe extends ForwardableProbe<SqsCall, SqsPendingCall> {
    command<C extends SqsCommandConstructor>(
        ctor: C,
    ): ForwardableSelection<SqsCall<InstanceType<C>>, SqsPendingCall<InstanceType<C>>>;
    command(name: string): ForwardableSelection<SqsCall, SqsPendingCall>;
}

export type ProbedSqsAdapter = ProbedAdapterWithLifecycle<SQSClient, SqsProbe> & {
    readonly queueUrl: string;
    readonly queueName: string;
};

export type CreateProbedSqsAdapterOptions = {
    readonly harness: Harness;
    readonly queueName?: string;            // default "test-queue"
    readonly queueUrl?: string;             // default derived from queueName
    readonly defaultVisibilityTimeoutSeconds?: number; // default 30
    readonly defaultTimeout?: Duration;
};

export function createProbedSqsAdapter(options: CreateProbedSqsAdapterOptions): ProbedSqsAdapter;
```

Behavior:

- The factory installs a default `probe.always().forward()` rule.
- Supported commands: `SendMessageCommand`, `ReceiveMessageCommand`,
  `DeleteMessageCommand`, `ChangeMessageVisibilityCommand`,
  `GetQueueUrlCommand`, `CreateQueueCommand`. Any other command fails
  loudly with the templated `unsupportedForward` error on `forward`.
- The in-memory backing implements real standard-queue semantics:
  visibility timeout (received message invisible until timeout, then
  redelivered with incremented `ApproximateReceiveCount`), long-poll
  receive (`WaitTimeSeconds` parks until a message arrives or the wait
  elapses), `DeleteMessage` by current receipt handle (stale handle after
  redelivery is a no-op), `ChangeMessageVisibility` (reschedules; `0` =
  immediately visible), and `DelaySeconds` on send. FIFO is not
  implemented.
- Timing is fake-timer friendly: scheduling uses the ambient `setTimeout`
  and deadlines use `harness.clock.now()`. Drive expiry with
  `harness.clock.advance(...)` under fake timers.
- `reset()` empties every queue and cancels pending timers.
- `close()` disposes the backing.

## Kafka Producer Adapter API

Package: `@vnatures/test-kit-kafka`.

```typescript
export type KafkaMethod = 'send' | 'sendBatch' | 'connect' | 'disconnect';

export interface KafkaProducer {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(record: ProducerRecord): Promise<RecordMetadata[]>;
    sendBatch(batch: ProducerBatch): Promise<RecordMetadata[]>;
}

export interface KafkaCall {
    readonly method: KafkaMethod;
    readonly topic: string | undefined;
    readonly messages: ReadonlyArray<KafkaMessageInput> | undefined;
    readonly args: ReadonlyArray<unknown>;
}

export interface KafkaPendingCall<TResult = unknown>
    extends ForwardablePendingCall<KafkaCall, TResult> {
    readonly method: KafkaMethod;
    readonly topic: string | undefined;
    readonly messages: ReadonlyArray<KafkaMessageInput> | undefined;
    readonly args: ReadonlyArray<unknown>;
}

export interface KafkaProbe extends ForwardableProbe<KafkaCall, KafkaPendingCall> {
    on(method: KafkaMethod): ForwardableSelection<KafkaCall, KafkaPendingCall>;
    topic(name: string): ForwardableSelection<KafkaCall, KafkaPendingCall>;
}

export interface TopicLogEntry {
    readonly topic: string;
    readonly partition: number;
    readonly offset: number;
    readonly key: Buffer | null;
    readonly value: Buffer | null;
    readonly headers: Readonly<Record<string, Buffer | Buffer[]>>;
    readonly timestamp: string;
    readonly appendIndex: number;
}

export type ProbedKafkaProducer = ProbedAdapterWithLifecycle<KafkaProducer, KafkaProbe> & {
    topicLog(topic: string): TopicLogEntry[];
};

export type CreateProbedKafkaProducerOptions = {
    readonly harness: Harness;
    readonly partitionsPerTopic?: number;  // default 4
    readonly defaultTimeout?: Duration;
};

export function createProbedKafkaProducer(options: CreateProbedKafkaProducerOptions): ProbedKafkaProducer;

export function brokerDownError(message?: string): Error;
```

Behavior:

- The factory installs a default `probe.always().forward()` rule.
- `send` / `sendBatch` append to an in-memory per-topic log; `connect` /
  `disconnect` are no-ops that still go through the probe.
- Partitioning matches kafkajs' default partitioner: explicit
  `message.partition` wins (clamped), else keyed messages are
  murmur2-hashed (same key ⇒ same partition ⇒ stable per-key ordering),
  else partition 0.
- Per-partition offsets are monotonic from 0.
- No dedup: duplicate sends append (at-least-once is the consumer's
  problem).
- `topicLog(topic)` returns entries in global append order, each tagged
  with `partition` and per-partition `offset`; bytes are normalized to
  `Buffer` (or `null`).
- `brokerDownError()` returns an `Error` with `name: 'KafkaJSBrokerNotFound'`
  for simulating transport failures via `.reject(...)`.
- `reset()` empties every topic log.
- `close()` disposes the backing.

## MySQL Adapter API

Package: `@vnatures/test-kit-mysql`.

A real MySQL 8 Testcontainer behind the `@vnatures/test-kit-sql` probe
seam. Requires Docker; tests should use `describe.skipIf` when Docker is
unavailable.

```typescript
export interface MysqlAdapter {
    execute<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;
    query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;
}

export interface MaintenancePool {
    execute<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;
    query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]>;
}

export interface MysqlContainerInfo {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly connectionUri: string;
}

export type ProbedMysqlAdapter = ProbedAdapterWithLifecycle<MysqlAdapter, QueryProbe> & {
    seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
    readonly container: MysqlContainerInfo;
};

export interface CreateProbedMysqlAdapterOptions {
    readonly harness: Harness;
    readonly bootstrap: (maintenance: MaintenancePool) => Promise<void>;
    readonly image?: string;     // default "mysql:8.0"
    readonly database?: string;  // default "testdb"
    readonly username?: string;  // default "testuser"
    readonly password?: string;  // default "testpass"
    readonly defaultTimeout?: Duration;
}

export function createProbedMysqlAdapter(options: CreateProbedMysqlAdapterOptions): Promise<ProbedMysqlAdapter>;
```

Behavior:

- The factory starts a MySQL 8 Testcontainer, creates two `mysql2/promise`
  pools (application + maintenance), and wires the `SqlDriver` through
  `createProbedSqlAdapter` from `@vnatures/test-kit-sql`.
- The application pool routes `execute` / `query` through the probe; the
  maintenance pool bypasses it for `bootstrap`, `seed`, and `reset`.
- The probe surface is `QueryProbe` (same as pg-kysely / pg-knex /
  pg-sequelize): `.sql(match)`, `.calls`, `.expect.*`, `.drain()`, with
  the default `always().forward()` rule.
- `reset()` truncates all user tables (`SET FOREIGN_KEY_CHECKS = 0`,
  `TRUNCATE TABLE` per table from `information_schema`, re-enable FK
  checks) and re-runs `bootstrap`.
- `close()` closes both pools and stops the container.
- `seed(table, rows)` batch-inserts via the maintenance pool.

## HTTP Client Adapter API (planned)

Package: `@vnatures/test-kit-http`. Reserved API space.

```typescript
export interface HttpClient {
    request<T>(opts: HttpRequest): Promise<HttpResponse<T>>;
}

export type HttpCall = {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
};

export interface HttpPendingCall<T = unknown> extends PendingCallBase<HttpCall, HttpResponse<T>> {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
}

export interface HttpProbe extends Probe<HttpCall, HttpPendingCall> {
    on(method: string): Selection<HttpCall, HttpPendingCall>;
    url(match: string | RegExp | ((url: string) => boolean)): Selection<HttpCall, HttpPendingCall>;
}
```

The HTTP adapter intentionally does **not** intercept `fetch` or
`http.request` globally. It is a typed `HttpClient` interface meant to be
injected. See "Boundaries In And Out Of Scope" in the concepts document.

## Rule Matching Semantics

When a call arrives, the engine resolves it through ordered tiers. The
first match in tiers 1b, 2, or 3 executes and stops resolution. Tier 1a
(observers) never stops resolution; resolution always proceeds to 1b
after observers fire.

### Tier 1a — Observers (notify-only, FIFO)

1. Iterate live observers (registered by `expect.observe`) in
   registration order. For each whose filter chain matches the call,
   resolve the observer's awaiter with a snapshot of the call shape
   (the same `TCall` value the call is recorded as). Observers do not
   consume; resolution continues.

   Timing: all matching observers are notified **before** any other
   tier acts on the call. From the test author's perspective, an
   `expect.observe` resolves with the call's pre-rule shape, and any
   subsequent rule's mutation/settlement is observable only via
   `selection.calls` reads after the rule has fired.

### Tier 1b — Capturing waiters (intercept, FIFO)

2. Iterate live `expect.intercept` waiters in registration order. For
   each, evaluate the underlying selection's filter chain. The first
   match consumes the call: it is returned as a pending call to the
   awaiter, marked consumed, removed from the waiter list, and
   resolution stops.

### Tier 2 — One-shot rules (FIFO)

3. Iterate `once()` rules — across all selections, in a single global
   queue — in registration order (oldest first). For each, evaluate
   the underlying selection's filter chain. The first match executes
   the rule, removes it from the queue, and stops resolution.

   There is no "per-selection queue" or "per-matcher queue." All one-
   shot rules share one FIFO queue. A one-shot whose filter chain does
   not match a particular call simply remains in the queue, available
   for a future matching call.

   One-shots take priority over all permanent rules. Even a harness-
   installed permanent forward at tier 3 is bypassed for any call that
   matches a queued one-shot at tier 2.

### Tier 3 — Permanent rules (LIFO)

4. Iterate `always()` rules from most recently registered to oldest.
   For each, evaluate the underlying selection's filter chain. The
   first match executes the rule and stops resolution. Permanent
   rules are not removed after execution.

   LIFO ordering at this tier means user-installed permanents
   naturally override harness-installed defaults (because user rules
   are registered after the factory installs defaults).

### Default behavior (no waiter, no rule)

5. If no waiter consumed the call and no rule matched in tier 2 or
   tier 3:
   - The call **parks** (the returned promise stays pending until
     either the test settles it via a retroactive `expect.intercept`,
     or the harness safety timeout fires).
   - This applies to both programmable mock adapters and backed
     adapters whose harness-installed default rule has been removed
     via `clearRules({ includeDefaults: true })`. Backed adapters
     with their default intact never reach this step — the
     `always().forward()` rule at the bottom of the tier-3 stack
     handles the call there.

### Specificity ranking

There is no specificity ranking among predicates. Within each tier,
ordering (FIFO at tiers 1a, 1b, and 2; LIFO at tier 3) is the only
prioritizing dimension. Two `filter(predicate)` rules registered for
overlapping inputs fire in tier-and-order resolution; the engine
does not compare predicates structurally.

## Consumption Semantics

A call can be:

- recorded,
- consumed by a capturing waiter (intercept) or by `drain*`,
- settled,
- both consumed and settled.

These are independent. Concretely:

- All adapter calls are recorded in call history (`probe.calls`).
- `expect.intercept` consumes a call (subsequent intercepts will skip it).
- `expect.observe` does **not** consume a call.
- Settling a call (via rule, pending, or drainAndReject/drainAndForward)
  marks it settled but leaves it in call history.
- `drain` consumes calls without settling them. `drainAndReject` /
  `drainAndForward` both consume and settle.
- There is no `pendingCount()` method. If a test needs to inspect the
  unconsumed subset of a probe's history, it can compute it from
  `probe.calls` and the test's own bookkeeping; in practice, tests
  almost never need this.

## Error Message Requirements

Errors are public UX. Every error thrown by core or by domain packages must
include enough context for a developer to act on it without opening source.

Required formats:

- Timeout waiting for a call:
  `"Timed out after 1000ms waiting for next call matching {label}."`
  where `{label}` is the filter chain's label (joined by " AND " when
  chained).
- Negative expectation failure:
  `"Expected no calls matching {label} within 100ms, but received {n}."`
- `exactly` failure:
  `"Expected exactly 2 calls matching {label} within 1000ms, but received {n}."`
- Double settlement:
  `"Pending call '{label}' is already settled."`
- Unsupported forward:
  `"Cannot forward {domain} call '{name}': no local backing
  implementation supports it. Use .answer(...) or .reject(...)."`
- Sync methods on a probed mock are rejected at compile time, not at
  runtime; there is no runtime error message for them. See
  `CheckedMethods<T, M>` in the Mock Adapter API section.
- Mock method not declared (the user reached the proxy via `as any`
  escape hatch and called a method not in the `methods` list): the
  proxy returns `undefined` (no throw). The user's code will fail
  naturally at the use site (e.g., `await undefined` returns undefined,
  `undefined.x` throws `TypeError`). The probed-mock contract does not
  promise to detect bypass attempts.
- Real clock advance attempt:
  `"realClock cannot advance time. Configure the harness with a fake
  clock to use clock.advance()."`
- Fake clock not active:
  `"jestFakeClock requires jest.useFakeTimers() to be active before
  clock.advance() is called."`
- Harness safety timeout:
  `"Test exceeded the harness safety timeout (30000ms wall-clock).
  This usually means the test is hung; check for missing settlements
  or unmet expectations."`
- Harness closed:
  `"Harness is closed."`
- Harness close with unsettled waiters:
  `"Harness closed with {n} unsettled waiter(s)."`
- `harness.expect.sequence` order violation:
  `"Sequence expectation failed: step {i} ({label}) matched before step {j} ({label}) was satisfied."`
- `harness.expect.sequence` timeout:
  `"Sequence expectation timed out after {within}ms. Steps satisfied: {i}/{n}. First unsatisfied step: {label}."`
- `harness.expect.allOf` timeout:
  `"allOf expectation timed out after {within}ms. {satisfied}/{n} steps satisfied. Unsatisfied: [{labels}]."`

All errors are plain `Error` subclasses (or `RangeError` for invalid
durations). Optional Jest/Vitest matcher integrations may wrap these later;
the core remains framework-neutral.

## Implementation Expectations

### Core engine (single source of truth)

Domain packages must **not** reimplement:

- waiter registration (capturing and observing),
- timeout handling (delegated to `Clock`),
- rule queue (LIFO stack),
- default behavior resolution,
- call history,
- drain behavior,
- double-settlement checks,
- filter chain evaluation,
- harness lifecycle integration.

### Domain packages (thin wrappers)

Each domain package provides:

- adapter construction (the factory function),
- call extraction (translating boundary I/O into the domain `Call` shape),
- typed filter sugars (`on`, `sql`, `command`, `url`, etc.) that compose
  to `filter` calls in the core,
- optional backing implementation,
- domain-specific `PendingCall` accessors (e.g., `pending.sql`,
  `pending.parameters`),
- lifecycle helpers (`reset`, `close`) wired into `ProbedResource`.

A domain package implementation should fit in a few hundred lines. If it
grows larger, it is duplicating core behavior.

### Extender's guide (must ship)

The repo must ship a short guide showing how to build a new domain package
end-to-end (e.g., `@vnatures/test-kit-grpc-client`). The guide must demonstrate:

1. Defining the domain `Call` type.
2. Defining the domain `PendingCall` type (with or without `forward`).
3. Constructing the probe via `core.createProbeRoot<TCall, TPending>(...)`.
4. Adding typed filter sugars.
5. Wiring `reset`/`close` into `ProbedResource`.
6. Optional: installing default rules.

The guide's worked example must compile and pass tests in CI.

## Finalized v2 API Decisions

These decisions are part of the v2 target unless explicitly revisited:

1. `once()` and `always()` are methods, not properties. Use
   `selection.once().answer(value)`.
2. `intercept` is the canonical name for capturing waiters. No alias.
3. `observe` is the canonical name for non-capturing waiters. No alias.
4. `atLeast(n, { within })` and `exactly(n, { within })` are distinct
   expectations with distinct semantics. There is no `count(...)`.
5. There is no `park()` on pending calls. `RuleBuilder.park()` exists
   and matters: it overrides defaults for a selection.
6. Public timing APIs accept `Duration` only. The API surface never
   accepts raw numbers for time values.
7. Domain packages do not invent alternate timing grammars. The standard
   forms are `expect.intercept({ within })`, `expect.observe({ within })`,
   `expect.none({ within })`, `expect.atLeast(n, { within })`, and
   `expect.exactly(n, { within })`.
8. `createProbedMock` requires an explicit `methods` list, type-
   constrained via `CheckedMethods<T, M>` to async-returning methods
   only. There is no open-ended Proxy with passthrough property
   allowlists; non-listed property access returns `undefined`.
9. Sync methods are not supported on `createProbedMock`. Including a sync
   method in `methods` is a compile-time error. The prescription for
   sync dependencies is to use the real implementation in tests
   (clocks, JWT verifiers, UUID generators, feature-flag clients, etc.
   should be injected as real objects, not doubled). See "Synchronous
   Dependencies: Use The Real Thing" in the concepts document.
10. `defaultRule` is not a configuration concept. Backed adapters
    install a default `always().forward()` rule via the same public
    API any user would use; it sits at the bottom of the tier-3 LIFO
    stack.
11. Rule resolution has four ordered tiers: observers (notify-only,
    FIFO) → capturing waiters (intercept, FIFO) → one-shot rules
    (single global FIFO queue) → permanent rules (LIFO). Observers
    never consume; intercepts and rules consume on first match. One-
    shots beat permanents unconditionally. There is no specificity
    ranking among predicates.
12. The probe is a selection. There is no `any()` accessor.
13. `filter(predicate, label?)` is the universal narrowing primitive.
    Domain probes provide typed sugars that compose to `filter`.
14. The harness is the recommended lifecycle owner for tests with backed
    adapters or multiple probes. Tests with a single mock and no backed
    adapter may use `createProbedMock` directly without a harness.
15. The Clock is a user-facing abstraction for driving SUT-internal
    virtual time. It does **not** drive any of test-kit's internal
    timing. All test-kit waiter deadlines and the safety timeout are
    real wall-clock, unconditionally.
16. `expect.none({ within })` waits real wall-clock for the duration
    and does not advance virtual time. Use `harness.clock.advance(...)`
    explicitly when virtual-time advancement is wanted, then assert
    silence with `expect.none({ within: ms(0) })`.
17. The harness installs a wall-clock safety timeout (default 30s) as
    a last-resort failsafe for hung tests.
18. `expect.observe` returns a `TCall` shape (read-only). `expect.intercept`
    returns a `TPending` (settlable). The distinction is intentional.
19. `harness.reset()` produces test isolation by default: it calls
    `adapter.reset()` on every backed adapter AND clears user-installed
    rules and call history on every probe. Harness-installed defaults
    are preserved. `{ keepRules: true }` opts out of probe state
    clearing.
20. `attach` is a single implementation with two type signatures (sync
    and Promise overloads). The Promise overload recurses on the
    resolved value, returning a Promise that resolves to the
    registered adapter.
21. Backed-adapter factories take an explicit `harness` parameter in
    their options. They do not call `harness.attach` themselves;
    callers wrap the factory call in `await harness.attach(...)`.
    `createProbedMock` does not take a harness parameter (no external
    resources; falls back to sensible defaults).
22. There is no `pendingCount()` method on selections. The "calls
    available for `expect.intercept` to capture" metric is derivable
    from `selection.calls` and is rarely needed in practice.
23. `selection.calls` returns a fresh `ReadonlyArray` snapshot on each
    access. Mutating the returned array does not affect probe state.
    Re-reading after new calls arrive returns a new array.
24. Call history is unbounded by design. Tests are short-lived and
    construct fresh harnesses per test; accumulation across many tests
    is not a concern. There is no auto-truncation, no max-history
    option, no LRU eviction.
25. `expect.intercept` is retroactively eligible only for calls that
    parked because **no rule of any kind matched**. Calls caught by
    `once().park()`, `always().park()`, or any settling rule
    (`forward`/`answer*`/`reject`) are not retroactively
    interceptable. The pre-register pattern (intercept before SUT
    triggers the call) is the canonical way to capture a call that
    a rule would otherwise handle.
26. The `pg-kysely`, `pg-knex`, and `pg-sequelize` packages share an
    identical `QueryProbe` surface. The packages differ only in the
    `adapter` type, the `bootstrap` callback signature, and the
    `seed` helper's input shape. Tests written against one ORM port
    to another with minimal change to non-ORM-specific code.
27. `harness.expect.sequence(steps, { within })` and
    `harness.expect.allOf(steps, { within })` provide cross-probe
    ordering assertions. Steps default to capturing intercepts;
    `observation(selection)` marks a step as observation-only. Both
    helpers fail fast on order violations or timeouts with diagnostics
    naming the unmet step.
28. Tier 1a (observers) is notify-only and runs **before** tier 1b
    (capturing intercepts) and all rule tiers. An observer registered
    on the same selection as a later intercept will see the call
    before the intercept captures it.
29. One-shot rules (tier 2) live in a single global FIFO queue
    regardless of which selection registered them. There is no
    per-selection or per-matcher queue.
30. `clearRules()` (without options) preserves harness-installed
    defaults. `clearRules({ includeDefaults: true })` removes them too,
    leaving the adapter to park all subsequent calls. The preferred
    way to "park everything" on a backed adapter is to register an
    explicit `always().park()` rule, which sits on top of the tier-3
    stack and shadows the default forward.
