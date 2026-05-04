# Test-Kit Architecture

This document describes the package layout and module structure of test-kit.
It complements [`concepts.md`](concepts.md) (mental model) and
[`api-surface.md`](api-surface.md) (public API reference) by answering
"what code lives where, and how do the pieces fit together."

The goal here is to draw the boundaries and call out shared-vs-per-domain
code so contributors can find their way around. The actual internal
contracts (function signatures, file layouts, etc.) are described in
[`internal/tech-design.md`](internal/tech-design.md).

## Package Graph

```
@vnatures/test-kit                   ← probe engine, Clock, Harness, shared types
       ▲
       │
       ├── @vnatures/test-kit-mock                ← createProbedMock + MethodProbe
       │
       ├── @vnatures/test-kit-sql                 ← shared QueryProbe + SqlDriver seam
       │      ▲
       │      │
       │      ├── @vnatures/test-kit-pglite-driver  (internal helper, shared by pg-*)
       │      │       ▲
       │      │       │
       │      │       ├── @vnatures/test-kit-pg-kysely     ← KyselySqlDriver + Kysely typing
       │      │       ├── @vnatures/test-kit-pg-knex       ← KnexSqlDriver + Knex typing
       │      │       └── @vnatures/test-kit-pg-sequelize  ← SequelizeSqlDriver + Sequelize typing
       │      │
       │      └── (future SQL ORMs slot in here, e.g. drizzle, typeorm)
       │
       ├── @vnatures/test-kit-redis               ← createProbedCacheAdapter
       │
       └── @vnatures/test-kit-s3                  ← createProbedS3Adapter + createProbedPresignerAdapter
```

Two horizontal layers:

- **Core layer** (`@vnatures/test-kit`): generic probe engine, lifecycle,
  time abstraction, shared types. No domain knowledge.
- **Domain layer** (`@vnatures/test-kit-mock`, `@vnatures/test-kit-sql`,
  `@vnatures/test-kit-redis`, `@vnatures/test-kit-s3`): per-boundary
  packages that wrap the core engine with domain-specific call shapes,
  filter sugars, and adapter factories.

Within the SQL family, a third sub-layer exists: `@vnatures/test-kit-sql`
is a shared *abstraction* that the per-ORM packages plug into via a
`SqlDriver` interface. This is where the pg-* packages share more than
just types.

## What Each Package Owns

### `@vnatures/test-kit` — the probe engine

This package is the single source of truth for everything that is not
domain-specific. It exports both the public API surface (Probe,
Selection, RuleBuilder, Expectations, Clock, Harness, Duration) and an
internal-facing API that domain packages consume to build their own
adapters.

**Public exports:**

- `Duration`, `milliseconds`, `seconds`, `minutes`
- `Clock`, `realClock`, `jestFakeClock`, `viFakeClock`,
  `sinonFakeClock`, `manualClock`
- `Harness`, `createHarness`, `HarnessExpectations`, `observation`
- `Selection`, `ForwardableSelection`, `Probe`, `ProbeAdmin`
- `RuleBuilder`, `ForwardableRuleBuilder`
- `Expectations`
- `PendingCallBase`, `ForwardablePendingCall`
- `ProbedAdapter`, `ProbedResource`
- Type helpers: `CallMatcher`, `CallTypeGuard`, `NarrowPending`,
  `PendingAnswer`, `ExpectOptions`, `RequiredWithinOptions`

**Internal exports** (consumed by domain packages, not by user code):

- A factory function — provisional name `createProbeRoot<TCall, TPending>(...)`
  — that domain packages call to construct their probe. This factory
  takes the harness reference, the default-rule-installer, and any
  domain-specific configuration, and returns a fully-wired Probe with
  the four-tier rule resolution engine, waiter management, call
  history, settlement tracking, etc.
- A "record call" function the domain package's adapter implementation
  calls when the SUT invokes the boundary. This is what threads the
  call through rule resolution and produces the application-facing
  Promise.
- The settlement state machine (consumed indirectly via PendingCall
  factory).

**What core does NOT contain:**

- No knowledge of any specific boundary (no SQL, no S3, no HTTP).
- No proxy implementation (that lives in `@vnatures/test-kit-mock`).
- No backing implementations (PGlite, ioredis-mock, mock-aws-s3 live
  in their respective domain packages).
- No framework integration (Jest matchers, Vitest matchers — these are
  optional add-on packages that may ship later).

### `@vnatures/test-kit-mock` — programmable mock adapters

Owns the proxy-based programmable mock adapter. Imports `core`'s
internal-facing API to construct the underlying probe.

**Module layout (sketch):**

- `types.ts`: `MethodCall`, `MethodPendingCall`, `MethodProbe`,
  `MethodSelection`, `MethodName`, `AsyncMethodName`, `SyncMethodName`,
  `CheckedMethods`, `MethodArgs`, `MethodResolvedReturn`, `IsAsync`.
- `proxy.ts`: the `Proxy`-based adapter implementation. The handler's
  `get` trap returns intercepting functions only for keys in `methods`;
  every other access returns `undefined`.
- `factory.ts`: `createProbedMock<T, M>` and `CreateProbedMockOptions<T, M>`.
- `index.ts`: re-exports the public API.

This is the smallest domain package — probably <300 lines total.

### `@vnatures/test-kit-sql` — shared SQL probe surface and driver seam

This is the abstraction that the three pg-* packages plug into. It owns
the shared probe API and the `SqlDriver` interface; it does NOT own any
ORM-specific code or any PGlite startup logic.

**Module layout:**

- `types.ts`: `QueryCall`, `QueryPendingCall`, `QueryProbe`.
- `driver.ts`: the `SqlDriver` interface (see "The SqlDriver Seam"
  below).
- `factory.ts`: a `createProbedSqlAdapter(driver, harness, options)`
  helper that the pg-* packages call to wire the driver into a probe,
  install the default forward rule, and return the resulting adapter +
  probe pair.
- `index.ts`: re-exports.

`@vnatures/test-kit-sql` has no PGlite or ORM dependencies. It's pure types and
glue.

### `@vnatures/test-kit-pglite-driver` — shared PGlite lifecycle helper

A small internal-facing package shared across all pg-* packages. It
encapsulates:

- Constructing a fresh PGlite instance.
- Running a user-supplied bootstrap script against it.
- Providing a "maintenance connection" that the pg-* packages use for
  `seed`/`reset`/`close` operations without going through the probe.
- Truncate-all-user-tables logic for `reset()`.
- Disposing the PGlite instance on `close()`.

It does NOT know anything about Kysely/Knex/Sequelize. Each pg-* package
plugs its ORM into the PGlite-backed connection and translates the ORM's
query stream into `QueryCall` shapes for the probe.

This package may end up being internal-only (no public API exports);
that's fine. It exists for code reuse, not for direct consumption.

### `@vnatures/test-kit-pg-kysely`, `@vnatures/test-kit-pg-knex`, `@vnatures/test-kit-pg-sequelize`

Each is a thin wrapper that:

1. Builds a `SqlDriver` implementation specific to its ORM.
2. Constructs the ORM's adapter object atop `@vnatures/test-kit-pglite-driver`'s
   PGlite connection.
3. Provides the typed `bootstrap` callback signature, the typed `seed`
   helper, and the typed factory function.

Each package's public API is small: one factory function plus the
package-specific types. The shared probe behavior comes for free from
`@vnatures/test-kit-sql`.

**Module layout (per pg-* package; structure is identical):**

- `driver.ts`: implements `SqlDriver` for this ORM.
- `factory.ts`: `createProbed{Kysely,Knex,Sequelize}Adapter(...)`.
- `seed.ts`: typed seed helper (per-ORM idiom).
- `reset.ts`: per-ORM reset implementation (or shared via maintenance
  connection if generic enough).
- `index.ts`: re-exports.

The total per-package code should be under 500 lines including types.
Most of the heavy lifting is in `@vnatures/test-kit-sql` and
`@vnatures/test-kit-pglite-driver`.

### `@vnatures/test-kit-redis` — cache adapter

Owns the cache boundary and the in-memory Redis-compatible backing
(`ioredis-mock`).

**Module layout:**

- `types.ts`: `CacheCall`, `CachePendingCall`, `CacheProbe`,
  `CacheAdapter`, `CacheKeyInput`, `CacheMethod`.
- `adapter.ts`: implementation of `CacheAdapter` over the
  ioredis-mock backing.
- `factory.ts`: `createProbedCacheAdapter(...)`.
- `index.ts`: re-exports.

Single-package, single-backing. No abstraction layer like
`@vnatures/test-kit-sql` because there's only one cache implementation in the
test-kit family today; if a Memcached or other variant is added later,
introduce a `@vnatures/test-kit-cache` shared abstraction at that point (premature
to do it now).

### `@vnatures/test-kit-s3` — S3 client and presigner adapters

Owns both the S3Client adapter (with mock-aws-s3 backing) and the
presigner adapter (no backing).

**Module layout:**

- `types.ts`: `S3Call`, `S3PendingCall`, `S3Probe`, `PresignCall`,
  `PresignPendingCall`, `PresignerProbe`, command-related types.
- `s3-client/`: subfolder with the S3Client adapter implementation,
  command extraction logic, mock-aws-s3 wiring.
- `presigner/`: subfolder with the presigner adapter implementation
  (no backing).
- `factory.ts`: `createProbedS3Adapter(...)` and
  `createProbedPresignerAdapter(...)`.
- `index.ts`: re-exports.

Two factories live in one package because they share the `S3Call`
shape, command type machinery, and AWS SDK type imports. Splitting into
two packages would duplicate the AWS SDK dep with no real boundary.

### `@vnatures/test-kit-http` — typed HTTP-client adapter (planned, post-v1)

Owns the HTTP-client adapter for SUTs that depend on a typed
`HttpClient` interface (generated OpenAPI clients, hand-written API
clients, etc.). Out of scope for v1 of the OSS release; reserved API
space documented in `v2-api-surface.md`.

When implemented, it follows the single-package pattern of
`@vnatures/test-kit-redis` (one backing — likely none; HTTP boundaries are
typically pure stubs/probes — and one factory).

## The SqlDriver Seam

The single most important "shared more than just types" decision in v2:
the three pg-* packages share a `SqlDriver` abstraction in
`@vnatures/test-kit-sql`. This is what lets each ORM package stay under 500
lines while still benefiting from the full probe-engine machinery.

**SqlDriver interface (sketch — exact shape TBD in tech design):**

```typescript
export interface SqlDriver {
    /**
     * Fired by the ORM whenever the SUT issues a query through the
     * probed adapter. The driver translates the ORM's internal call
     * shape into a normalized QueryCall and routes it through the
     * probe's recordCall(...) function.
     *
     * The probe's recordCall returns a Promise that resolves to the
     * query result (forwarded, answered, or rejected per rule
     * resolution). The driver hands that Promise back to the ORM as
     * the query's return value.
     */
    onApplicationQuery(call: QueryCall): Promise<unknown>;

    /**
     * Fired when @vnatures/test-kit-sql wants to forward a query to the real
     * backing. The driver invokes the real backing (PGlite via the
     * shared driver helper) and returns the Promise.
     */
    forward(call: QueryCall): Promise<unknown>;

    /**
     * Fired by harness.reset() (with default options). The driver
     * truncates all user tables on the maintenance connection,
     * bypassing the probe.
     */
    reset(): Promise<void>;

    /**
     * Fired by harness.close(). The driver disposes the ORM
     * connection pool and the underlying PGlite instance.
     */
    close(): Promise<void>;
}
```

Each pg-* package implements this interface for its ORM. The
implementation is small because the heavy lifting (rule resolution,
forwarding, settlement, history, etc.) lives in core. The driver only
has to:

1. Translate the ORM's internal query representation to `QueryCall`.
2. Wire the application-facing query path through `onApplicationQuery`.
3. Wire the maintenance path (bootstrap, seed, reset) directly to PGlite
   via `@vnatures/test-kit-pglite-driver`, bypassing the probe.

**Why a driver seam (vs. each pg-* package owning its own probe wiring):**

- The query translation logic is the only ORM-specific code.
  Everything else (probe wiring, default rule installation, lifecycle
  cascade) is identical across the three.
- Adding a fourth pg-* package (drizzle, typeorm) becomes a ~200-line
  task: write the SqlDriver, point its query path at the shared
  abstraction, expose the typed factory.
- If a behavioral change is needed across all pg-* packages (e.g., a
  bug fix in rule resolution or a new feature like query-timing
  capture), it lives in `@vnatures/test-kit-sql` and benefits all ORMs at
  once.

**Why not a similar abstraction for cache, S3, HTTP:**

- Cache: one backing (ioredis-mock). One ORM-equivalent. No siblings to
  share with. Adding a `CacheDriver` abstraction now would be premature.
- S3: one backing (mock-aws-s3). Same.
- HTTP: even when implemented, likely one shape (typed HttpClient
  interface). No driver needed.

If a second cache variant or HTTP variant ever materializes, introduce
the abstraction at that point. BSSN.

## Cross-Cutting Concerns

### Typing strategy

The TypeScript machinery is non-trivial: `CheckedMethods<T, M>`,
`NarrowPending<TPending, TNarrow>`, `AsyncMethodName<T>`,
`SequenceResult<S>`, the conditional-presence of `forward()` on backed
selections, etc. To keep this manageable:

- **All shared type primitives live in `@vnatures/test-kit`.** Domain
  packages import them; they do not redefine.
- **Per-domain type narrowing lives in the domain package.** E.g.,
  `MethodSelection<T, K>` lives in `@vnatures/test-kit-mock`, not in core.
- **Type-level tests** (using `tsd` or `expect-type`) live in each
  package's `test/types/` folder. These test that the type machinery
  produces the expected diagnostics for both correct and incorrect
  inputs. Critical for `CheckedMethods<T, M>` — the branded error
  type's diagnostic must be visible.
- **A small TypeScript POC** validates the type machinery before the
  full implementation begins. ~100 lines exercising every public
  factory with both valid and invalid inputs to verify the diagnostics
  are useful.

### Error messages

Error message formats are specified in `v2-api-surface.md`. They are
constructed in `@vnatures/test-kit` from templates parameterized by domain-
specific labels:

- The core engine knows how to produce `"Timed out after Xms waiting
  for next call matching {label}."`
- The label string is supplied by the domain package's filter sugar at
  selection-construction time.

Domain packages must use the core's error templates rather than rolling
their own. This guarantees consistent error wording across boundaries.

### Lifecycle integration

The `Harness` lifecycle (`attach`/`reset`/`close`) is implemented in
core. Domain packages plug in via the `ProbedResource` interface
(`reset()` and `close()` methods on the returned adapter). The harness
calls these methods at the appropriate times.

`harness.reset()` clears probe state on every attached probe (rules +
call history, preserving harness-installed defaults) AND calls
`adapter.reset()` on every backed adapter. The order is: probe state
first, then adapter state. This ensures a test that has registered
rules expecting fresh data won't see those rules apply to in-flight
adapter-reset operations (which use maintenance connections that bypass
the probe anyway, so this is belt-and-suspenders).

### Clock integration

The Clock is in `@vnatures/test-kit` and is purely user-facing. Probe
internal timers (waiter deadlines, safety timeout) use `globalThis.setTimeout`
directly. Domain packages do not need to touch the Clock; they just
respect the harness-supplied configuration (e.g., the `defaultTimeout`
on factory options is passed through to the underlying `core.createProbeRoot`
call).

## Repository Layout

The monorepo structure (already in place from v1) is:

```
test-kit/
├── package.json                 (workspace root)
├── tsconfig.base.json
├── README.md                    (OSS-facing intro)
├── docs/
│   ├── README.md                (docs index)
│   ├── v2-concepts.md           (mental model)
│   ├── v2-api-surface.md        (API specification)
│   ├── v2-architecture.md       (THIS document)
│   └── internal/
│       ├── README.md
│       └── migration-from-v1.md
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── README.md
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                    (public exports)
│   │   │   ├── duration.ts
│   │   │   ├── clock.ts
│   │   │   ├── harness.ts
│   │   │   ├── selection.ts
│   │   │   ├── rule-builder.ts
│   │   │   ├── expectations.ts
│   │   │   ├── pending-call.ts
│   │   │   ├── probe-engine.ts             (rule resolution, waiter mgmt)
│   │   │   ├── probe-root.ts               (createProbeRoot for domain pkgs)
│   │   │   ├── errors.ts                   (error message templates)
│   │   │   └── internal/
│   │   │       └── ...                      (not exported from index)
│   │   └── test/
│   │       ├── unit/
│   │       └── types/                       (tsd / expect-type)
│   │
│   ├── mock/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── proxy.ts
│   │   │   └── factory.ts
│   │   └── test/
│   │
│   ├── sql/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── driver.ts                   (SqlDriver interface)
│   │   │   └── factory.ts                  (createProbedSqlAdapter)
│   │   └── test/
│   │
│   ├── pglite-driver/
│   │   ├── package.json                    (private: true)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── lifecycle.ts                (start, reset, close PGlite)
│   │   │   └── maintenance-connection.ts
│   │   └── test/
│   │
│   ├── pg-kysely/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── driver.ts                   (KyselySqlDriver impl)
│   │   │   ├── factory.ts
│   │   │   └── seed.ts
│   │   └── test/
│   │
│   ├── pg-knex/                            (same shape as pg-kysely)
│   ├── pg-sequelize/                       (same shape)
│   │
│   ├── redis/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── adapter.ts
│   │   │   └── factory.ts
│   │   └── test/
│   │
│   ├── s3/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── s3-client/
│   │   │   │   ├── adapter.ts
│   │   │   │   └── factory.ts
│   │   │   ├── presigner/
│   │   │   │   ├── adapter.ts
│   │   │   │   └── factory.ts
│   │   │   └── command-extraction.ts
│   │   └── test/
│   │
│   └── http/                                (planned; structure TBD)
│
└── examples/                                 (extender's-guide worked example)
    └── grpc-client/                         (sample @vnatures/test-kit-grpc-client impl)
```

## Build, Test, and Distribution

### TypeScript project references

Each package has its own `tsconfig.json` extending `tsconfig.base.json`.
Cross-package dependencies use TypeScript project references for fast
incremental builds and reliable type-checking.

### Build target

ESM-first with CommonJS dual export via package `exports` field:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  }
}
```

Build tool: **Vite library mode** with `vite-plugin-dts` for `.d.ts`
generation. Vite delegates production builds to Rollup (best-in-class
library bundling with strong tree-shaking and small output). Same Vite
installation is shared with Vitest for tests, giving a single tool and
single config language across build and test.

### Test runner

The test-kit's own tests use **Vitest**:

- Built on Vite — shares the bundler installation and config language.
- Native ESM, no transpilation overhead.
- Fast.
- Bundled fake timers via `@sinonjs/fake-timers`.
- First-class TypeScript support, including type-level testing via
  `expect-type` integration.

This does NOT mean test-kit only works with Vitest in user code. The
public API is framework-neutral: `jestFakeClock()`, `viFakeClock()`,
`sinonFakeClock()`, and `manualClock()` cover Jest, Vitest, Sinon, and
custom users. The choice of Vitest is for the kit's own test suite, not
for user adopters.

### Type-level tests

Each package with non-trivial generic types ships a `test/types/`
folder using `tsd` or `expect-type`. Critical cases to cover:

- `createProbedMock<T>` rejects sync methods with the branded error.
- Filter chain narrowing produces correct pending types.
- `harness.expect.sequence` infers tuple result types correctly.
- `ForwardableSelection` exposes `forward()`/`drainAndForward()` only
  on backed pending types.

### Linting and formatting

Existing v1 setup (eslint + prettier) carried over.

## Decisions Still Open (for Implementation Phase)

These are intentionally not decided in this document. They will be
resolved during implementation and codified in a follow-up tech design.

1. **Exact shape of `core.createProbeRoot`.** The signature, what
   options it takes, what it returns, and how it threads the harness
   reference through. Sketched as needed by domain packages but not
   yet finalized.

2. **Internal storage representation.** Whether the rule queue uses
   arrays, linked lists, or something else. Whether call history uses
   a single array per probe or per-selection caching. These are
   performance/code-clarity tradeoffs that are best made with code in
   front of you.

3. **Bundling tool.** Decided: Vite library mode + `vite-plugin-dts`.
   Matches the team's existing toolchain on application/SUT projects;
   shares the installation with Vitest for tests.

4. **Test runner for the kit's own tests.** Decided: Vitest. Built on
   Vite, shares config and installation with the build.

5. **Whether `@vnatures/test-kit-pglite-driver` is published or kept private.**
   If published, it has a stable API for community pg-* package
   authors. If private, it can iterate freely. Lean toward private
   for v1; revisit if a community ORM package wants to plug in.

6. **Error class hierarchy.** Whether all errors are plain `Error` /
   `RangeError`, or whether test-kit ships its own
   `TestKitError` / `TimeoutError` / `SettlementError` for type-based
   matching. The API spec currently says plain Error subclasses;
   revisit if the implementation wants finer-grained type
   discrimination.

7. **Package naming.** `@vnatures/test-kit-*` is a placeholder. The OSS release
   may use a different name (`boundary-probe`, `test-probe`, others).
   This affects every `package.json` `name` field but no internal code.
   Decide before the v2 cut.

## Adding a New Domain Package: Walkthrough

For the extender's guide (mandated by `v2-api-surface.md`), the
walkthrough for adding a hypothetical `@vnatures/test-kit-grpc-client` package
looks like:

1. **Define the call shape.** What does a gRPC unary/stream call look
   like as a normalized record? E.g.,
   `{ service: string; method: string; request: unknown }`.

2. **Define the pending call shape.** Extend `PendingCallBase` (no
   forward) or `ForwardablePendingCall` (with forward). Add domain-
   specific accessors (`pending.service`, `pending.method`,
   `pending.request`).

3. **Define the probe interface.** Extend `Probe<TCall, TPending>` with
   typed filter sugars (e.g., `service(name)`, `method(name)`,
   `on({ service, method })`).

4. **Implement the adapter.** Wrap the gRPC client interface so that
   each method invocation translates to a `recordCall(...)` against
   the probe. Use `core.createProbeRoot<GrpcCall, GrpcPendingCall>()`
   to construct the underlying probe.

5. **Wire lifecycle.** If the package owns external resources (a local
   gRPC mock server, etc.), implement `ProbedResource` with `reset()`
   and `close()`.

6. **Optionally install a default rule.** If the package has a backing
   that supports forwarding, install `probe.always().forward()` at
   construction.

7. **Define the factory function.** Take the harness parameter, accept
   ORM/SDK-specific options, return the typed `ProbedAdapter`.

The total package is expected to be 200-500 lines including types and
tests. If it grows substantially larger, the implementer is duplicating
core behavior and should refactor.

A worked `@vnatures/test-kit-grpc-client` example will live in `examples/` and
must compile and pass tests in CI as a smoke test for the extender
contract.
