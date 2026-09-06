# Internal Migration: pre-OSS → v1.0.0

This document maps the pre-OSS internal test-kit API (referred to here as
"v1") to the v1.0.0 public release. It is **internal documentation**:
OSS adopters never see the pre-OSS API, and the public release is
presented as version 1 of a fresh library.

This document exists to support the migration of internal services
(approximately 10 repos: 8 services + 2 shared model libraries) from
the pre-OSS patterns currently in use to the v1.0.0 grammar.

## Migration Approach

There is no automated migration. There are no deprecation aliases or
codemods. The migration is performed by:

1. Updating the test-kit dependency in each internal service.
2. Following the compile errors produced by the new types to
   identify call sites that need rewriting.
3. Applying the mapping table below.
4. Running the test suite to confirm parity.

For organizational planning, suggested order:

1. Start with thin services (`alerts-controller`,
   `construction_rules_service`) as migration pilots.
2. Apply the same patterns to the heavier services
   (`reports_service`, `user-management-service`) once the pilots are
   stable.
3. Update the two shared model libraries last, after every consumer
   has migrated.

## Mapping Table

### Mock package (probed interfaces)

| pre-OSS | v1.0.0 |
| --- | --- |
| `createProbePair<T>()` | `createProbedMock<T>({ methods: [...] })` |
| `{ fake, probe }` | `{ adapter, probe }` |
| `alwaysReturn(method, value)` | `probe.on(method).always().answer(value)` |
| `alwaysCall(method, fn)` | `probe.on(method).always().answerWith(fn)` |
| `alwaysReject(method, error)` | `probe.on(method).always().reject(error)` |
| `whenCalled(method).thenReturn(value)` | `probe.on(method).once().answer(value)` |
| `whenCalled(method).thenCall(fn)` | `probe.on(method).once().answerWith(fn)` |
| `whenCalled(method).thenReject(error)` | `probe.on(method).once().reject(error)` |
| `expectNext(timeoutMs?)` | `probe.expect.intercept({ within: ms(...) })` (or `expect.observe(...)` if not capturing) |
| `expectMatching(predicate, timeoutMs?)` | `probe.filter(predicate).expect.intercept({ within: ms(...) })` |
| `expectNoMsgWithin(ms)` | `probe.expect.none({ within: ms(...) })` |
| `clearBehavior()` | `probe.clearRules()` (preserves harness defaults) |
| `callsOf(method)` | `probe.on(method).calls` |
| `pendingCount()` | (no v2 equivalent; computed from `probe.calls` if needed) |
| `drainAndRejectAll(error?)` | `probe.drainAndReject(error)` |

### DB package (probed Kysely / Knex / Sequelize)

| pre-OSS | v1.0.0 |
| --- | --- |
| `createProbedTestDb<DB>({ bootstrap })` | `createProbedKyselyAdapter<DB>({ bootstrap })` (and equivalents for knex/sequelize) |
| `testDb.db` | `db.adapter` |
| `testDb.probe` | `db.probe` |
| `dbProbe.alwaysForward()` | (now installed by default; no call needed) |
| `dbProbe.alwaysReject(error)` | `db.probe.always().reject(error)` |
| `dbProbe.expectNext(timeoutMs?)` | `db.probe.expect.intercept({ within: ms(...) })` |
| `dbProbe.expectMatching(p, timeoutMs?)` | `db.probe.filter(p).expect.intercept({ within: ms(...) })` |
| `pendingQuery.forward()` | unchanged |
| `pendingQuery.reject(error)` | unchanged |
| `dbProbe.clearBehavior()` | `db.probe.clearRules()` |
| `dbProbe.drainAndForwardAll()` | `db.probe.drainAndForward()` |
| `dbProbe.drainAndRejectAll(error?)` | `db.probe.drainAndReject(error)` |

### Cache package (probed Redis)

| pre-OSS | v1.0.0 |
| --- | --- |
| `createProbedCache(...)` | `createProbedCacheAdapter(...)` |
| `cache.fake` | `cache.adapter` |
| `cache.probe.alwaysForward()` | (default; no call needed) |
| `cache.probe.alwaysReject(error)` | `cache.probe.always().reject(error)` |
| `cache.probe.expectNext(...)` | `cache.probe.expect.intercept({ within: ms(...) })` |

### S3 package

| pre-OSS | v1.0.0 |
| --- | --- |
| `createProbedS3(...)` | `createProbedS3Adapter(...)` |
| `s3.client` | `s3.adapter` |
| `s3Probe.alwaysForward()` | (default; no call needed) |
| `s3Probe.whenCalled(GetObjectCommand).thenAnswer(out)` | `s3.probe.command(GetObjectCommand).once().answer(out)` |
| `s3Probe.alwaysAnswer(fn)` | `s3.probe.always().answerWith(fn)` |
| `s3Probe.callsOf(GetObjectCommand)` | `s3.probe.command(GetObjectCommand).calls` |
| `pendingS3.forward()` / `.answer(out)` / `.reject(err)` | unchanged |

### Time

| pre-OSS | v1.0.0 |
| --- | --- |
| Raw `number` for timeouts (`timeoutMs`) | `Duration` via `seconds(...)` / `milliseconds(...)` |
| `jest.advanceTimersByTime(ms)` | `await harness.clock.advance(ms(...))` (recommended; jest direct still works) |

### Lifecycle

| pre-OSS | v1.0.0 |
| --- | --- |
| Per-adapter `await testDb.close()` in `afterAll` | `await harness.close()` cascades to all attached adapters |
| Per-adapter `await testDb.reset()` in `beforeEach` | `await harness.reset()` cascades; also clears probe rules + call history |
| Manual harness composition (no shared object) | `createHarness()` + `harness.attach(...)` |

## Notes For The Migration

- The biggest behavioral change to watch for is **`harness.reset()`
  now clears probe state by default** (rules + call history). v1
  required separate `clearBehavior()` calls. If your tests use
  `beforeEach` to set up rules and `afterEach` to do per-test
  cleanup, the v2 default is what you want. If your tests need to
  preserve rules across resets within a single test, pass
  `harness.reset({ keepRules: true })`.

- `expect.next` does **not** exist in v2. The capturing waiter is
  named `expect.intercept` in v2, with no alias. The new
  `expect.observe` (non-capturing) did not exist in v1; use it
  whenever the test is just inspecting a call that a default rule
  already handles.

- `probe.on(method)` in v2 returns a typed selection that supports
  `.once()`, `.always()`, `.expect.intercept(...)`, etc. v1's
  `whenCalled(method)` was specifically the one-shot rule builder;
  the v2 grammar separates the selection from the rule kind.

- v1's `expectNoMsgWithin(ms)` advanced fake-timer time as a side
  effect of the assertion. v2's `expect.none({ within })` does **not**
  advance virtual time. If your existing tests rely on the side
  effect, add an explicit `await harness.clock.advance(...)` before
  the `expect.none` call.

- v1's `clearBehavior()` cleared everything (no concept of "harness-
  installed defaults"). v2's `probe.clearRules()` preserves harness
  defaults; `probe.clearRules({ includeDefaults: true })` matches the
  v1 behavior.

## Renaming Plan (If Adopted)

If the OSS release is published under a new package name (current
candidates: `boundary-probe`, `test-probe`, others TBD), the internal
migration also includes updating import paths from `@vnatures/test-kit*`
to the new scope. Decide the new name before the v2 cut so the
internal migration is one round of edits, not two.
