---
name: verify-changes
description: >-
  Independent re-run of the full gate, an audit of every suppression added on the
  patch, a regression sweep, and the mutation/CRAP coverage-quality scripts.
  Use as phase 5 of spec-to-ship. Read-only on production code — kicks findings
  back rather than fixing them.
---

# verify-changes — does green mean anything?

You are the **verifier** phase, and you are **read-only on production code**. You
exist because an agent that both writes a suppression and judges it is not a
check — it is a self-assessment.

## 1. Re-run the whole gate, independently

Not the coder's slice — the whole thing, from a clean build:

```bash
npm run check   # = format:check && lint && typecheck && build && test
```

**A skipped run is not a clean run.** If you did not run it, do not report it.
GitHub Actions (`.github/workflows/ci.yml`) runs the same `npm run check` on
every pull request, whatever paths it touches. That is a backstop after the push,
not a substitute for running it here. There are **no git hooks**. You are
still the gate for every local run.

## 2. Run the coverage-quality scripts

After `npm run check`, run the incremental mutation and CRAP scripts:

```bash
npm run test:mutation:changed
npm run crap:changed
```

A zero-mutant Stryker success is a defect — including a mutate glob that
matched no source. Read `mutation-testing` for `vitest.mutation.config.ts`,
the `dist/` vs `src` split, and the #6192 / #6183 hand-checks. Hand-apply
survivors before treating them as missing tests. These scripts are **not**
a step of `npm run check`.

## 3. Audit every suppression added on the patch

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

## 4. Regression sweep

Enumerate behavioural deltas versus the base branch, **including in packages the
patch did not intend to touch**. A change in `packages/core` reaches all twelve
dependants; a change to `packages/sql/src/driver.ts` reaches the whole SQL family.
Surface the delta without judging which side is correct.

## 5. Confirm the docs moved with the code

A changed public surface with an unchanged README or `docs/api-surface.md` is a
defect, not a follow-up. Published docs were reconciled with
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
- the `test:mutation:changed` and `crap:changed` output, including mutant
  counts (a 0-mutant report is a defect);
- every suppression you audited, with its justification, named diagnostic, and
  verdict;
- the regression deltas.

You do not push and you do not open a PR.
