---
name: mutation-testing
description: >-
  How to run this repository's mutation testing (Stryker) and CRAP
  gates. Use in phase 5 (verify-changes) after npm run check, or when
  asking whether green means anything.
---

# Mutation testing — Stryker how-to

This repository scores coverage quality with Stryker and CRAP. Phase 5
runs the incremental scripts after `npm run check`. Coder and reviewer
do not run these gates.

## Commands

```bash
npm run test:mutation -- core          # one published package directory name
npm run test:mutation:changed          # packages/*/src changed vs vn/main, else main
npm run crap                           # istanbul coverage via vitest.mutation.config.ts, then CRAP
npm run crap:changed                   # same, scoped to changed production src
```

None of these are a step of `npm run check`. `thresholds.break` is `null`;
this is not a CircleCI merge gate.

## Why vitest.mutation.config.ts exists

`npm test` still resolves workspace packages through `dist/` (each
package `vite.config.ts`). A mutant applied to `src` is never loaded by
the default suite.

Stryker uses `vitest.mutation.config.ts`, which aliases every
`@vnatures/test-kit*` name to `packages/<dir>/src/index.ts` so mutants
in `src` are the modules under test. `vitest.related` is `false` because
tests import by package name, not by file path.

Package scope is the file `.stryker-package` (copied into the Stryker
sandbox). Do not rely on `STRYKER_PACKAGE` inside the Vite-bundled
config.

Do not set Stryker `vitest.dir`. Scope tests via include driven by
`.stryker-package`. Core include is in-process `packages/*/test` except
`packages/mysql/test` and four core layout files that fail a sandbox
dry run. When the package is `mysql`, include is
`packages/mysql/test/**/*.test.ts` and that glob is not excluded. When
`.stryker-package` is absent (CRAP), include is all package tests and
mysql tests are not excluded.

`concurrency` is `1` for `mysql` (Testcontainers). Other packages use `4`.

## Zero mutants is a failure

A Stryker JSON report with 0 mutants is a defect, including the case
where the mutate glob matched no files. Treat that as
[stryker-js#6183](https://github.com/stryker-mutator/stryker-js/issues/6183)
until proven otherwise: fail closed. `#6183` did not reproduce on
`@babel/generator@8.0.5` in the RD-24153 spike; the wrapper still
exits non-zero.

## Survivors

Hand-apply survivors before treating them as missing tests.
[stryker-js#6192](https://github.com/stryker-mutator/stryker-js/issues/6192)
can report false survivors. The `duration.ts` `<` vs `<=` survivors in
the spike were genuine; still hand-check before adding tests.
