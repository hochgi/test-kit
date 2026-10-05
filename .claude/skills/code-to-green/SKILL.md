---
name: code-to-green
description: >-
  Implement production code until the failing Vitest suite is green and the whole
  gate is clean. Use as phase 3 of spec-to-ship, or when asked to "make the tests
  pass" or "grind to green". Does not measure coverage quality — that is
  phase 5.
---

# code-to-green — implement until green

You are the **coder** phase. Input: a red suite plus stubs. **The spec and the
tests are the authority.**

## Loop

1. Run the failing files and read the failures (always build first;
   `pglite-driver` has no `pretest`):
   ```bash
   npm run build --workspace=packages/<name> && npm test --workspace=packages/<name>
   ```
2. Implement the **smallest correct change** to move one test red → green.
3. **Do not weaken a test to make it pass.** If a test looks wrong, STOP and kick
   it back to test-author or spec-author. Do not edit it away, do not `skip` it,
   do not loosen the assertion.
4. Refactor to stay inside the budget — complexity ≤ 12, max-depth ≤ 4,
   max-lines-per-function ≤ 80, max-params ≤ 5. **Extract before you extend:**
   before adding logic to a method near 40 lines, a file near 300, nesting deeper
   than 2, or a 5th positional parameter, pull out the seam first.
5. Repeat until the new tests are green.

## What you must leave clean

There are **no git hooks** — no husky, no lefthook (kept that way
on purpose). GitHub Actions (`.github/workflows/ci.yml`) runs `npm run check`
on every pull request, whatever paths it touches. The full gate is
`npm run check`:

```bash
npm run format:check   # prettier: packages/**/*.ts + examples/**/*.ts + test/**/*.ts + vitest.config.ts + vitest.mutation.config.ts
npm run lint           # eslint --max-warnings 0, test/ + vitest.config.ts + vitest.mutation.config.ts + each workspace
npm run typecheck      # tsc --build across 14 project references (ci-gate is Vitest-only)
npm run build          # Vite lib mode + vite-plugin-dts, all workspaces
npm test               # vitest run, every project in vitest.config.ts
```

Run `build` before a root `test`, always. The suite resolves into `dist/`.

## Library-specific care

This is a **published package family**. Three things that are cheap to get wrong:

- **The public surface is the product.** A change to an exported type, name or
  signature is a semver event — flag it in the handoff rather than sliding it in.
- **`packages/core` reaches all twelve.** A change there is never local. Run the
  full root suite, not just core's.
- **Docs move with code.** If you change a public surface, update that package's
  README and `docs/api-surface.md` in the same commit. Documenting an API that
  does not exist is this repo's single most common defect.

## Suppressions

Every `eslint-disable`, `@ts-expect-error` and `any` you add is a claim phase 5
will audit by reading the justification and the diagnostic it names — not by
mutating the tree. Justify it by the **invariant** that makes it safe, never by
what the tests happen to do. "No test calls this", "the fake is stateless",
"that value is always 0" all describe a coverage gap wearing an equivalence
costume — if that is the real reason, **write the test instead.**

## Handoff

**No approval gate.** Hand straight to the reviewer. Do not open a PR. Report the
green state, the gate output you actually produced, and the files touched.
