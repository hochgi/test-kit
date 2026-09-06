---
name: write-failing-tests
description: >-
  Derive failing Vitest tests plus the minimal type/skeleton stubs from a spec
  delta, so the suite compiles and fails for missing behaviour rather than
  missing symbols. Use as phase 2 of spec-to-ship. Other than tests, may only
  write type and interface declarations.
---

# write-failing-tests — spec delta → a red suite

You are the **test-author** phase. Input: a spec delta. Output: a **RED** Vitest
suite that compiles and fails for missing behaviour, not missing symbols.

## We are inside test-kit, not using it

Every consumer repo tests *with* `@vnatures/test-kit` — probes, adapters,
Goldilocks boundaries. **That is not what you are doing.** Here, test-kit is the
artifact under development. You test the packages directly: call the factory,
drive the probe, assert on what it recorded.

> **Do not follow `.cursor/skills/component-testing/SKILL.md` as a whole.**
> Cursor will surface it because it sits right there. It teaches consumers how
> to *use* this library, in **Jest**, pinned at v1.0.0 while core is at 1.0.6,
> and RD-24147 replaces it. Ignore its Jest APIs (`jest.useFakeTimers`,
> `jest.advanceTimersByTimeAsync`) and its version pin. Keep the parts that still
> describe this repo's own tests: Goldilocks boundaries, leaf-only probing,
> explicit probe methods, and harness lifecycle (`harness.close()` in `afterEach`
> or `try/finally`).

## Where tests live

```
packages/<name>/test/unit/         pure logic, no backing
packages/<name>/test/integration/  exercises a real in-process backing
packages/<name>/test/types/        type-level tests (core and mock only)
test/ci-gate/                      repository-level CI/gate tests (Vitest workspace)
```

`integration/` here means "runs a real backing in-process" — PGlite, `ioredis-mock`,
the in-memory S3 store — **not** "needs an external service". Vitest picks up
`test/**/*.test.ts` from each package's `vite.config.ts`, which doubles as its
Vitest config. `packages/core` and `packages/mock` additionally typecheck
`test/types/**/*.ts`.

The one package that needs Docker is `packages/mysql`, and it degrades rather than
fails: it shells `docker info` once and wraps the suite in
`describe.skipIf(!hasDocker)`. Keep that shape if you add to it.

## Import by package name

Tests import `@vnatures/test-kit`, `@vnatures/test-kit-mock` and friends — not
relative `../src`. That resolves through a workspace symlink into `dist/`, so
**a stale build silently tests yesterday's code**:

```bash
npm run build --workspace=packages/<name> && npm test --workspace=packages/<name>
# always build first; pglite-driver has no pretest
npm run build && npm test              # root run — pretest does NOT cascade
```

There is exactly one relative-import test in the repo
(`packages/s3/test/integration/backing-regressions.test.ts`). Follow the
convention, not the exception, unless you are deliberately testing internals.

## Allowed writes

- Tests under `packages/<name>/test/`.
- Repository-level tests under `test/` (e.g. `test/ci-gate/` for repo/CI-gate
  packets).
- Type and interface declarations the tests compile against.
- Throwing `not implemented` skeletons **only** so the suite compiles.

Do **not** implement production logic. That is `code-to-green`.

## Rules

- **One test per scenario.** Do not collapse two `#### Scenario:` blocks into one
  `it`. The names should track the spec text closely enough that phase 4 can
  match them by eye.
- **One assertion path per requirement.** Every `### Requirement:` (`SHALL`) gets
  a test. Property-style where the requirement quantifies over inputs.
- **Strict types, no `any`.** If a type is genuinely unexpressible, say so in the
  handoff rather than reaching for an escape hatch phase 5 will audit.
- **Confirm every new test fails for a behavioural reason** — an assertion or a
  `not implemented` throw. A test that fails to compile proves nothing and will
  later pass for the wrong reason.
- **Harness-based `it`s are disposable.** Each such test creates its own harness
  and closes it in `afterEach` or `try/finally` so a failed assertion cannot leak
  adapters or probe state. That rule comes from `component-testing` and still
  applies here.
- Prefer extending an existing package's test file over adding a parallel one.

## Handoff

**No approval gate.** Report: tests written, requirements covered, scenarios
covered, exact red/green counts, and the command you actually ran.

**Report spec/code discrepancies instead of silently picking a side.** If a
scenario cannot be expressed as written, or its arithmetic looks wrong, say so.
