# P02+P03 — rename Harness → Rig, ship all 13 packages at 2.0.0

Depends on: P01 (docs truth pass — RD-24142, done). The rename must land on
documents that are already correct.

Tickets: RD-24143, RD-24144. **These two ship as one branch, one PR, closing
both.** Spec delta: `../spec/deltas/P02-P03-rig-rename-2.0.0.md`.

## Why the two tickets cannot be separated

All 11 domain packages hard-depend on core at `^1.x`, and `.circleci/ci.yml` has
13 per-package `vn-ci/build-publish` workflows on `main`. There is no ordering
that avoids both traps:

1. **Ship core 2.0.0 alone.** `^1.x` does not satisfy `2.0.0`, so npm stops
   linking the workspace copy and resolves a registry `1.x` core into each
   sibling's nested `node_modules`. Every sibling then compiles against 1.x while
   the suite imports 2.x. Because 33 of 34 test files resolve through `dist/`, a
   green suite would not prove the right core was loaded.
2. **Fix the ranges without bumping the siblings.** Each edited manifest trips
   its own path filter, and CI auto-publishes `test-kit-s3@1.1.4` and friends as
   *patch* releases whose core dependency is `^2.0.0` — a breaking change
   delivered to eight consumer repos under a patch bump.

Only the atomic shape is safe.

## Shape

- Rename `packages/core/src/harness.ts` → `rig.ts` and the five published
  symbols: `Harness`→`Rig`, `HarnessRef`→`RigRef`,
  `HarnessExpectations`→`RigExpectations`,
  `CreateHarnessOptions`→`CreateRigOptions`, `createHarness`→`createRig`.
- Clean break, **no deprecated alias** — settled.
- All 13 packages → `2.0.0`. The 11 core consumers move `@hochgi/test-kit`
  from `dependencies` to `peerDependencies` at `^2.0.0`; that is what stops the
  nested dual-install recurring. `pglite-driver` consumes no core and gains none.
- Docs move with the code in the same commit — P01 just made them trustworthy.
- An ADR under `docs/adr/` recording the collision and the versioning choice.

## The trap that makes this not a sed job

"Harness" has two unrelated meanings in this repo and this packet exists to
separate them. Only the **published-API sense** is renamed. The **agent-harness
sense** must not be touched, and it is cleanly confined to:

```
.harness/                     (models.json, models.example.json)
test/ci-gate/, test/docs-truth/, test/harness-scaffold/
scripts/*agent-skills*
everything under .claude/, .cursor/, .opencode/
docs/internal/spec/harness-scaffold.md and docs/internal/archive/**
```

Renaming any of those destroys the distinction being created and breaks
`check-agent-skills`. Rule of thumb: **rename inside `packages/`, leave `test/`
alone.** `packages/core/test/unit/rig-rename-layout.test.ts` guards this.

## Explicitly NOT renamed

Three harness-named things stay, so that RD-24145's committed 118-forced-site
estimate — which defines "forced" as *touching test-kit's exported names* —
remains valid:

- the `harness` factory **option key** (only its type changes, to `Rig`/`RigRef`),
- the public union `origin: 'harness' | 'user'`,
- `errors.harnessClosed()` and its message texts.

The `{ harness: rig }` asymmetry this leaves is deliberate. Changing it later is
a second major bump; see the delta's out-of-scope table.

## Out of scope

- The 118 forced call sites across the 8 consumer repos — **RD-24145**. Do not
  touch another repository.
- The ~1,948 discretionary `create*Harness` local names in those repos — out of
  scope entirely; they name a different thing that merely uses a Rig internally.

## Folded in during phase 1 (unowned by any packet, verified against Jira)

- `examples/grpc-client` — imports `createHarness`/`Harness` and pinned core at
  `^1.0.0`; it is a workspace covered by `npm run check`, so the gate cannot go
  green without it, and its `^1.0.0` was the same dual-install trap in-repo.
- The 13 `packages/*/README.md` — `docs-truth` classifies them as library docs
  and they are the published npm READMEs. RD-24142 owned their *truth*, not this
  rename.
- The ADR — required by RD-24143's own description and referenced by RD-24148 as
  "the ADR in P02"; `docs/adr/` did not exist.

## Repo facts

- Gate is `npm run check` (`format:check && lint && typecheck && build && test`).
  `typecheck` must precede `build`.
- **Build before test.** Tests import by package name and resolve through
  workspace symlinks into `packages/*/dist`; a stale build silently tests
  yesterday's code.
- There are no git hooks.

## Phase 5, specifically

A green suite does not prove the rename worked: because tests resolve through
`dist/`, green is compatible with having loaded the wrong core. Verify from a
clean `npm install` that every `packages/*/node_modules/@hochgi/test-kit` is
still a workspace symlink and not a materialized 1.x directory, and state that
result explicitly.
