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
@hochgi/test-kit                   ← probe engine, Clock, Rig, shared types
       ▲
       │
       ├── @hochgi/test-kit-mock                ← createProbedMock + MethodProbe
       │
       ├── @hochgi/test-kit-sql                 ← shared QueryProbe + SqlDriver seam
       │      ▲
       │      │
       │      ├── @hochgi/test-kit-pglite-driver  (published helper, shared by pg-*)
       │      │       ▲
       │      │       │
       │      │       ├── @hochgi/test-kit-pg-kysely     ← KyselySqlDriver + Kysely typing
       │      │       ├── @hochgi/test-kit-pg-knex       ← KnexSqlDriver + Knex typing
       │      │       └── @hochgi/test-kit-pg-sequelize  ← SequelizeSqlDriver + Sequelize typing
       │      │
       │      ├── @hochgi/test-kit-mysql         ← real MySQL 8 via Testcontainers
       │      └── (future SQL ORMs slot in here, e.g. drizzle, typeorm)
       │
       ├── @hochgi/test-kit-redis               ← createProbedCacheAdapter
       │
       ├── @hochgi/test-kit-bull                ← createProbedBullQueue
       │
       ├── @hochgi/test-kit-s3                  ← createProbedS3Adapter + createProbedPresignerAdapter
       │
       ├── @hochgi/test-kit-sqs                 ← createProbedSqsAdapter
       │
       └── @hochgi/test-kit-kafka               ← createProbedKafkaProducer
```

Two horizontal layers:

- **Core layer** (`@hochgi/test-kit`): generic probe engine, lifecycle,
  time abstraction, shared types. No domain knowledge.
- **Domain layer** (`@hochgi/test-kit-mock`, `@hochgi/test-kit-sql`,
  `@hochgi/test-kit-pglite-driver`, `@hochgi/test-kit-pg-kysely`,
  `@hochgi/test-kit-pg-knex`, `@hochgi/test-kit-pg-sequelize`,
  `@hochgi/test-kit-mysql`, `@hochgi/test-kit-redis`,
  `@hochgi/test-kit-bull`, `@hochgi/test-kit-s3`,
  `@hochgi/test-kit-sqs`, `@hochgi/test-kit-kafka`): per-boundary
  packages that wrap the core engine with domain-specific call shapes,
  filter sugars, and adapter factories.

Within the SQL family, a third sub-layer exists: `@hochgi/test-kit-sql`
is a shared *abstraction* that the per-ORM packages plug into via a
`SqlDriver` interface. This is where the pg-* packages share more than
just types.

## What Each Package Owns

### `@hochgi/test-kit` — the probe engine

This package is the single source of truth for everything that is not
domain-specific. It exports both the public API surface (Probe,
Selection, RuleBuilder, Expectations, Clock, Rig, Duration) and an
internal-facing API that domain packages consume to build their own
adapters.

**Public exports:**

- `Duration`, `milliseconds`, `seconds`, `minutes`
- `Clock`, `realClock`, `jestFakeClock`, `viFakeClock`,
  `sinonFakeClock`, `manualClock`
- `Rig`, `createRig`, `RigExpectations`, `observation`
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
  takes the rig reference, the default-rule-installer, and any
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
- No proxy implementation (that lives in `@hochgi/test-kit-mock`).
- No backing implementations (PGlite, ioredis-mock, in-memory S3 live
  in their respective domain packages).
- No framework integration (Jest matchers, Vitest matchers — these are
  optional add-on packages that may ship later).

### `@hochgi/test-kit-mock` — programmable mock adapters

Owns the proxy-based programmable mock adapter. Imports `core`'s
internal-facing API to construct the underlying probe.

**Module layout (sketch):**

- `types.ts`: `MethodCall`, `MethodPendingCall`, `MethodProbe`,
  `MethodSelection`, `MethodName`, `AsyncMethodName`, `SyncMethodName`,
  `CheckedMethods`, `MethodArgs`, `MethodResolvedReturn`, `IsAsync`.
- `factory.ts`: `createProbedMock<T, M>` and `CreateProbedMockOptions<T, M>`.
  The `Proxy`-based adapter lives here: the handler's `get` trap returns
  intercepting functions only for keys in `methods`; every other access
  returns `undefined`.
- `stream-types.ts` / `stream-factory.ts`: `createProbedStreamMock<T, M>` —
  the sibling factory for methods returning `AsyncIterable<...>` (e.g. an
  `async *stream()` method). Built on core's `createStreamProbeRoot`
  (`stream-probe-engine.ts`), a parallel engine to `createProbeRoot`: same
  four-tier `FilterChain` matching, but settlement is a `push`/`end`/`error`
  chunk channel instead of a single `Deferred`, since a stream call yields
  zero-or-more values over time rather than resolving once. See that file's
  header comment for why this isn't unified with the Promise-settlement
  engine.
- `index.ts`: re-exports the public API.

This is the smallest domain package — probably <300 lines total (the
stream sibling roughly doubles that, but stays in the same package since
both serve the same "fake any interface" concern, just for two method
shapes).

### `@hochgi/test-kit-sql` — shared SQL probe surface and driver seam

This is the abstraction that the three pg-* packages plug into. It owns
the shared probe API and the `SqlDriver` interface; it does NOT own any
ORM-specific code or any PGlite startup logic.

**Module layout:**

- `types.ts`: `QueryCall`, `QueryPendingCall`, `QueryProbe`, `SqlDriver`
  (see "The SqlDriver Seam" below).
- `factory.ts`: a `createProbedSqlAdapter({ harness: rig, driver })`
  helper that the pg-* packages call to wire the driver into a probe,
  install the default forward rule, and return `{ probe, probeRoot }`.
- `index.ts`: re-exports.

`@hochgi/test-kit-sql` has no PGlite or ORM dependencies. It's pure types and
glue.

### `@hochgi/test-kit-pglite-driver` — shared PGlite lifecycle helper

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

This package is published (`@hochgi/test-kit-pglite-driver`) so
community ORM packages can reuse the same PGlite lifecycle. Direct
consumption is still uncommon; pg-* factories are the usual entry.

### `@hochgi/test-kit-pg-kysely`, `@hochgi/test-kit-pg-knex`, `@hochgi/test-kit-pg-sequelize`

Each is a thin wrapper that:

1. Builds a `SqlDriver` implementation specific to its ORM.
2. Constructs the ORM's adapter object atop `@hochgi/test-kit-pglite-driver`'s
   PGlite connection.
3. Provides the typed `bootstrap` callback signature, the typed `seed`
   helper, and the typed factory function.

Each package's public API is small: one factory function plus the
package-specific types. The shared probe behavior comes for free from
`@hochgi/test-kit-sql`.

**Module layout (per pg-* package):**

- `factory.ts`: `createProbed{Kysely,Knex,Sequelize}Adapter(...)`,
  including typed `seed` / `reset` helpers.
- Kysely and Knex: `driver.ts` implements `SqlDriver` for that ORM.
  Sequelize: `dialect.ts` implements the probed `pg`-compatible dialect.
- `index.ts`: re-exports.

The total per-package code should be under 500 lines including types.
Most of the heavy lifting is in `@hochgi/test-kit-sql` and
`@hochgi/test-kit-pglite-driver`.

### `@hochgi/test-kit-redis` — cache adapter

Owns the cache boundary and the in-memory Redis-compatible backing
(`ioredis-mock`).

**Module layout:**

- `types.ts`: `CacheCall`, `CachePendingCall`, `CacheProbe`,
  `CacheAdapter`, `CacheKeyInput`, `CacheMethod`.
- `key.ts`: cache-key formatting for `CacheKeyInput`.
- `factory.ts`: `createProbedCacheAdapter(...)` and the
  `CacheAdapter` implementation over the ioredis-mock backing.
- `index.ts`: re-exports.

Single-package, single-backing. No abstraction layer like
`@hochgi/test-kit-sql` because there's only one cache implementation in the
test-kit family today; if a Memcached or other variant is added later,
introduce a `@hochgi/test-kit-cache` shared abstraction at that point (premature
to do it now).

### `@hochgi/test-kit-s3` — S3 client and presigner adapters

Owns both the S3Client adapter (in-memory backing) and the
presigner adapter (no backing).

**Module layout:**

- `types.ts`: `S3Call`, `S3PendingCall`, `S3Probe`, `PresignCall`,
  `PresignPendingCall`, `PresignerProbe`, command-related types.
- `s3-client/factory.ts`: `createProbedS3Adapter(...)`.
- `s3-client/in-memory-backing.ts`: dispatcher keyed on
  `command.constructor.name`.
- `presigner/factory.ts`: `createProbedPresignerAdapter(...)`
  (no backing).
- `index.ts`: re-exports.

Two factories live in one package because they share the `S3Call`
shape, command type machinery, and AWS SDK type imports. Splitting into
two packages would duplicate the AWS SDK dep with no real boundary.

`@hochgi/test-kit-http` is not shipped.

## The SqlDriver Seam

The single most important "shared more than just types" decision in v2:
the three pg-* packages share a `SqlDriver` abstraction in
`@hochgi/test-kit-sql`. This is what lets each ORM package stay under 500
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
     * Fired by rig.reset() (with default options). The driver
     * truncates all user tables on the maintenance connection,
     * bypassing the probe.
     */
    reset(): Promise<void>;

    /**
     * Fired by rig.close(). The driver disposes the ORM
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
   via `@hochgi/test-kit-pglite-driver`, bypassing the probe.

**Why a driver seam (vs. each pg-* package owning its own probe wiring):**

- The query translation logic is the only ORM-specific code.
  Everything else (probe wiring, default rule installation, lifecycle
  cascade) is identical across the three.
- Adding a fourth pg-* package (drizzle, typeorm) becomes a ~200-line
  task: write the SqlDriver, point its query path at the shared
  abstraction, expose the typed factory.
- If a behavioral change is needed across all pg-* packages (e.g., a
  bug fix in rule resolution or a new feature like query-timing
  capture), it lives in `@hochgi/test-kit-sql` and benefits all ORMs at
  once.

**Why not a similar abstraction for cache, S3:**

- Cache: one backing (ioredis-mock). One ORM-equivalent. No siblings to
  share with. Adding a `CacheDriver` abstraction now would be premature.
- S3: one backing (in-memory dispatcher). Same.

If a second cache variant ever materializes, introduce the abstraction
at that point. BSSN.

## Cross-Cutting Concerns

### Typing strategy

The TypeScript machinery is non-trivial: `CheckedMethods<T, M>`,
`NarrowPending<TPending, TNarrow>`, `AsyncMethodName<T>`,
`SequenceResult<S>`, the conditional-presence of `forward()` on backed
selections, etc. To keep this manageable:

- **All shared type primitives live in `@hochgi/test-kit`.** Domain
  packages import them; they do not redefine.
- **Per-domain type narrowing lives in the domain package.** E.g.,
  `MethodSelection<T, K>` lives in `@hochgi/test-kit-mock`, not in core.
- **Type-level tests** (using `expect-type`) live in each
  package's `test/types/` folder. These test that the type machinery
  produces the expected diagnostics for both correct and incorrect
  inputs. Critical for `CheckedMethods<T, M>` — the branded error
  type's diagnostic must be visible.
- **A small TypeScript POC** validates the type machinery before the
  full implementation begins. ~100 lines exercising every public
  factory with both valid and invalid inputs to verify the diagnostics
  are useful.

### Error messages

Error message formats are specified in `api-surface.md`. They are
constructed in `@hochgi/test-kit` from templates parameterized by domain-
specific labels:

- The core engine knows how to produce `"Timed out after Xms waiting
  for next call matching {label}."`
- The label string is supplied by the domain package's filter sugar at
  selection-construction time.

Domain packages must use the core's error templates rather than rolling
their own. This guarantees consistent error wording across boundaries.

### Lifecycle integration

The `Rig` lifecycle (`attach`/`reset`/`close`) is implemented in
core. Domain packages plug in via the `ProbedResource` interface
(`reset()` and `close()` methods on the returned adapter). The rig
calls these methods at the appropriate times.

`rig.reset()` clears probe state on every attached probe (rules +
call history, preserving rig-installed defaults) AND calls
`adapter.reset()` on every backed adapter. The order is: probe state
first, then adapter state. This ensures a test that has registered
rules expecting fresh data won't see those rules apply to in-flight
adapter-reset operations (which use maintenance connections that bypass
the probe anyway, so this is belt-and-suspenders).

### Clock integration

The Clock is in `@hochgi/test-kit` and is purely user-facing. Probe
internal timers (waiter deadlines, safety timeout) use `globalThis.setTimeout`
directly. Domain packages do not need to touch the Clock; they just
respect the rig-supplied configuration (e.g., the `defaultTimeout`
on factory options is passed through to the underlying `core.createProbeRoot`
call).

## Repository Layout

The monorepo structure:

```
test-kit/
├── package.json                 (workspace root)
├── tsconfig.base.json
├── README.md                    (OSS-facing intro)
├── APPENDIX.md
├── docs/
│   ├── README.md                (docs index)
│   ├── concepts.md              (mental model)
│   ├── api-surface.md           (API specification)
│   ├── architecture.md          (THIS document)
│   └── internal/
│       ├── README.md
│       └── tech-design.md
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── README.md
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                    (public exports)
│   │   │   ├── duration.ts
│   │   │   ├── clock.ts
│   │   │   ├── rig.ts
│   │   │   ├── probe-engine.ts             (rule resolution, waiter mgmt)
│   │   │   ├── expectation-engine.ts
│   │   │   ├── stream-probe-engine.ts
│   │   │   ├── stream-types.ts
│   │   │   ├── types.ts
│   │   │   └── errors.ts                   (error message templates)
│   │   └── test/
│   │       ├── unit/
│   │       └── types/                       (expect-type)
│   │
│   ├── mock/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── factory.ts
│   │   │   ├── stream-factory.ts
│   │   │   └── stream-types.ts
│   │   └── test/
│   │
│   ├── sql/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   └── factory.ts                  (createProbedSqlAdapter)
│   │   └── test/
│   │
│   ├── pg-kysely/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── driver.ts                   (Kysely SqlDriver impl)
│   │   │   └── factory.ts
│   │   └── test/
│   │
│   ├── pg-knex/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── driver.ts
│   │   │   └── factory.ts
│   │   └── test/
│   │
│   ├── pg-sequelize/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── dialect.ts
│   │   │   └── factory.ts
│   │   └── test/
│   │
│   ├── redis/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── key.ts
│   │   │   └── factory.ts
│   │   └── test/
│   │
│   ├── bull/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── factory.ts
│   │   │   └── backing.ts
│   │   └── test/
│   │
│   ├── s3/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── s3-client/
│   │   │   │   ├── factory.ts
│   │   │   │   └── in-memory-backing.ts
│   │   │   └── presigner/
│   │   │       └── factory.ts
│   │   └── test/
│   │
│   ├── sqs/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── factory.ts
│   │   │   └── in-memory-backing.ts
│   │   └── test/
│   │
│   ├── kafka/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── factory.ts
│   │   │   └── in-memory-backing.ts
│   │   └── test/
│   │
│   ├── mysql/
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── types.ts
│       │   └── factory.ts
│       └── test/
│
│   └── pglite-driver/
│       ├── package.json
│       └── src/
│           └── index.ts
│
└── examples/                                 (extender's-guide worked example)
    └── grpc-client/                         (sample @hochgi/test-kit-grpc-client impl)
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
  "import": {
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  },
  "require": {
    "types": "./dist/index.d.cts",
    "default": "./dist/index.cjs"
  }
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
folder using `expect-type`. Critical cases to cover:

- `createProbedMock<T>` rejects sync methods with the branded error.
- Filter chain narrowing produces correct pending types.
- `rig.expect.sequence` infers tuple result types correctly.
- `ForwardableSelection` exposes `forward()`/`drainAndForward()` only
  on backed pending types.

### Linting and formatting

Existing v1 setup (eslint + prettier) carried over.

## Decisions Still Open (for Implementation Phase)

Shipped 1.x already resolved the implementation-phase questions recorded
in [`internal/tech-design.md`](internal/tech-design.md): the probe-root
factory, storage model, published PGlite helper, plain `Error` /
`RangeError`, and `@hochgi/test-kit-*` package names at 1.x.

Items that were decided in this document and remain true:

1. **Bundling tool.** Decided: Vite library mode + `vite-plugin-dts`.
   Matches the team's existing toolchain on application/SUT projects;
   shares the installation with Vitest for tests.

2. **Test runner for the kit's own tests.** Decided: Vitest. Built on
   Vite, shares config and installation with the build.

No further open decisions block adding a domain package.

## Adding a New Domain Package: Walkthrough

For the extender's guide (mandated by `api-surface.md`), the
walkthrough for adding a hypothetical `@hochgi/test-kit-grpc-client` package
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

7. **Define the factory function.** Take the `harness` parameter, accept
   ORM/SDK-specific options, return the typed `ProbedAdapter`.

The total package is expected to be 200-500 lines including types and
tests. If it grows substantially larger, the implementer is duplicating
core behavior and should refactor.

A worked `@hochgi/test-kit-grpc-client` example will live in `examples/` and
must compile and pass tests in CI as a smoke test for the extender
contract.
