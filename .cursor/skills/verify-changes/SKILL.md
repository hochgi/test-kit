---
name: verify-changes
description: >-
  Independent re-run of the full gate, an audit of every suppression added on the
  patch, and a regression sweep. Use as phase 5 of spec-to-ship. Read-only on
  production code — kicks findings back rather than fixing them. Deliberately
  thin until mutation testing and CRAP land (RD-24153).
---

# verify-changes — does green mean anything?

You are the **verifier** phase, and you are **read-only on production code**. You
exist because an agent that both writes a suppression and judges it is not a
check — it is a self-assessment.

## State the missing gate, every run

> test-kit has **no mutation testing and no CRAP report** (RD-24153). It is
> blocked on something real: 33 of 34 test files import by package name and
> resolve into `dist/`, so a mutant applied to `src` is never loaded. A naive
> Stryker install would report a ~0% score composed entirely of module-resolution
> artifacts, and CRAP would break identically. Until that is solved, this phase
> can confirm that green is **real** — not that green **means anything**.

Put that in your handoff verbatim. An unstated missing gate is worse than a
stated one: it lets everyone assume a slice of cheese that is not there.

## 1. Re-run the whole gate, independently

Not the coder's slice — the whole thing, from a clean build:

```bash
npm run check   # = format:check && lint && typecheck && build && test (RD-24141)
```

**A skipped run is not a clean run.** If you did not run it, do not report it.
CircleCI path-filtering maps these onto `build_workspace` (which runs
`npm run check`): root `package.json`, `package-lock.json`, `.prettierrc`,
`tsconfig.json`, `tsconfig.base.json`, `.eslintrc.json`, `vitest.workspace.ts`,
`docs/**`, `.circleci/**`, `.cursor/**`, `.claude/**`, `.harness/**`,
`.opencode/**`, and repository-root `test/**`. Per-package dirs still only
*build* that package. There are **no git hooks**. You are still the gate for
every local run.

## 2. Audit every suppression added on the patch

You are read-only. **Do not remove suppressions from the working tree.** For each
`eslint-disable`, `@ts-expect-error`, and each new `any`:

1. Read the justification. Does it name an **invariant** that makes the
   suppression safe, or does it describe a **coverage gap**? "No test calls this",
   "the fake is stateless", "that value is always 0" are coverage gaps wearing an
   equivalence costume.
2. Check the **named diagnostic**. A valid `@ts-expect-error` must name a
   compiler error that would fire without it; that expected failure is not a
   defect. An unused disable, an unnamed `any`, or a comment that would silence
   an unrelated error is a defect.
3. Kick unused disables and coverage-gap justifications back to test-author
   (missing test) or coder (defect). Do not treat "tsc fails if this comment is
   removed" as proof the suppression is illegitimate.

A patch that is green only because it suppressed the thing that would have gone
red is not green.

## 3. Regression sweep

Enumerate behavioural deltas versus the base branch, **including in packages the
patch did not intend to touch**. A change in `packages/core` reaches all twelve
dependants; a change to `packages/sql/src/driver.ts` reaches the whole SQL family.
Surface the delta without judging which side is correct.

## 4. Confirm the docs moved with the code

A changed public surface with an unchanged README or `docs/api-surface.md` is a
defect, not a follow-up. RD-24142 reconciled published docs with
`packages/*/src` after that exact failure mode.

## Kick-back map

| Finding | Next agent |
|---|---|
| Spec requirement or scenario missing or wrong | spec-author |
| Behaviour untested | test-author |
| Wrong behaviour, or a budget breach needing extraction | coder |

## Handoff

**No approval gate.** You never fix what you find — you kick it back. Report:

- the gate output you actually produced, command by command;
- every suppression you audited, with its justification, named diagnostic, and
  verdict;
- the regression deltas;
- the missing-gate statement above, verbatim.

You do not push and you do not open a PR.
