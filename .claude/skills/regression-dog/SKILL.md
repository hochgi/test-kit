---
name: regression-dog
description: Review code changes for regressions — enumerate behavioral deltas between before and after without judging which is correct.
---

# Regression Dog

Review code changes for behavioral differences between the before and after code.

Important:

- Do NOT run tests, typechecks, linters, or build commands. The verifier runs
  `npm run check`; this skill does not. Focus your context budget entirely on
  reasoning about the code changes and their implications on
  logic/behavior/data/ordering/state.
- Enumerate behavioral differences: "this used to do X, now it does Y." Do not
  judge whether the old or new behavior is correct — just surface the delta. Do
  not flag pre-existing issues or suggest improvements.

Output format:

- List regressions first, numbered, with severity.
- After the regressions section, add a "Cleared" section listing items reviewed
  and found to have no issues. Prefix each cleared item with a ✅ emoji.

Scope (pass as arguments):

- No arguments: review the most recent commit
- `main`: review all commits since the last merge from main
- `HEAD~3`: review the last 3 commits
- Any git revision range (e.g., `abc123..HEAD`, `main..HEAD`)

## When to use this skill

- During refactor PRs (no intended behavior change) — dog runs first, anything
  it flags is either a bug or needs to be called out explicitly.
- During cutover PRs where you've deleted code other code might depend on — dog
  catches "this used to call X, the new code calls Y" patterns.
- During hot-fix review when the diff is small but high-stakes.
- Pay special attention to the load-bearing invariants of this library:
  published API consistency across the adapter family, Rig as the lifecycle
  owner vs the factory option key `harness`, every adapter package's
  peerDependency on core, and Goldilocks leaf probing. A silent change to any
  of these is a P0 regression.

## When NOT to use this skill

- Feature PRs where behavior change IS the point. The dog flags everything as a
  regression in that case — noise.
- Spec/doc PRs.

## Output style

Keep it scannable. Each regression / cleared item gets one line. If a regression
needs explanation, add a bullet under it. Don't pad with prose.

Example:

```
## Regressions

1. [P0] `packages/mock/src/factory.ts`: `harness` option is now optional and ignored.
   - Means: a 2.x caller passing `{ harness: rig }` no longer shares lifecycle.
2. [P2] `packages/core/src/rig.ts`: `close()` no longer rejects in-flight waiters.
   - Means: a test that used to see "Harness is closed." now hangs.

## Cleared

✅ `packages/core/src/index.ts` — re-export reorder only; no shape change.
✅ `packages/sql/src/factory.ts` — `{ harness, driver }` shorthand still binds the rig.
```
