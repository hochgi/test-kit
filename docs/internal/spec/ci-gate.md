# CI gate

What currently gates a change to this repository: CircleCI path-filtered
per-package jobs, a workspace-wide `npm run check` workflow for named
root/docs/CI and harness-surface paths, a lint+test workflow for `examples/grpc-client`, and
main-only backup/audit. There are no git hooks (no husky, no lefthook).

## Requirements

### Requirement: Per-package CircleCI workflows
When a file under `packages/<name>/` changes relative to `main`, CircleCI SHALL
set the corresponding `build_<name>` pipeline parameter so that package's
`vn-ci/init` workflow runs. On `main`, that package's `vn-ci/build-publish`
workflow SHALL also run. Adding workspace-wide and grpc-client mappings SHALL
NOT remove or rename these thirteen mappings.

#### Scenario: each published package has a path-filter mapping
- **WHEN** `.circleci/config.yml` path-filtering mapping is read
- **THEN** it contains a `packages/<name>/.*` line setting `build_<name>` true
  for each of: core, pglite-driver, mock, sql, redis, bull, s3, sqs, kafka,
  mysql, pg-kysely, pg-knex, pg-sequelize

### Requirement: Main-only backup and audit
The setup config SHALL keep the existing `backup` and `audit` workflows that run
only on `main`.

#### Scenario: backup and audit stay main-only
- **WHEN** `.circleci/config.yml` is read
- **THEN** `vn-ci/backup-code` and `vn-ci/npm-audit` remain filtered to the
  `main` branch

### Requirement: Root check script
The repository SHALL expose a root npm script named `check` that runs the
existing root scripts `format:check`, `lint`, `typecheck`, `build`, and `test`,
in that order, each joined to the next with `&&` so the chain stops at the first
non-zero exit.

#### Scenario: check script is defined
- **WHEN** the root `package.json` `scripts` map is read
- **THEN** it contains `check` whose command invokes those five scripts in that
  order, separated only by `&&`

#### Scenario: check is fail-closed
- **WHEN** the `check` script command is inspected
- **THEN** it does not use `;` or `&` between steps in a way that would continue
  after a failure

### Requirement: Stale Claude worktree is unregistered
The repository working tree SHALL NOT have a git worktree registered at
`.claude/worktrees/gallant-ritchie-e7507a`. The local branch
`claude/gallant-ritchie-e7507a` SHALL remain (it is not deleted).

#### Scenario: gallant-ritchie worktree is absent
- **WHEN** `git worktree list --porcelain` is read
- **THEN** no `worktree` line ends with `.claude/worktrees/gallant-ritchie-e7507a`

### Requirement: No cross-repo Claude launch config
The path `.claude/launch.json` SHALL NOT exist on disk.

#### Scenario: launch.json is absent
- **WHEN** the filesystem is inspected at `.claude/launch.json`
- **THEN** the path does not exist

### Requirement: Local Claude settings do not undercut read-only phases
If `.claude/settings.local.json` exists, its `permissions.allow` list SHALL NOT
contain `Bash(git push *)`, `Bash(gh pr *)`, or `Read(//Users/giladhoch/dev/**)`,
and the file SHALL NOT contain a CircleCI API poll for branch
`docs/v2-probed-adapters` or a `git -C` invocation into `reports_service`.

#### Scenario: forbidden grants are absent when the file exists
- **WHEN** `.claude/settings.local.json` exists
- **THEN** none of those permission strings or residue commands appear in it

#### Scenario: missing local settings file is allowed
- **WHEN** `.claude/settings.local.json` does not exist
- **THEN** this requirement is satisfied (fresh clone / CI)

### Requirement: gitignore tracks harness, ignores local Claude state
Root `.gitignore` SHALL ignore `.claude/settings.local.json` and
`.claude/worktrees/`, and SHALL NOT ignore the entire `.claude/` directory.

#### Scenario: gitignore is narrowed
- **WHEN** root `.gitignore` is read
- **THEN** it lists `.claude/settings.local.json` and `.claude/worktrees/`, and
  it has no ignore pattern that is exactly `.claude/`

### Requirement: Workspace-wide path changes run the root check in CI
CircleCI path-filtering SHALL map a change to any of these paths onto a
boolean pipeline parameter dedicated to a workspace-wide gate (distinct
from the per-package `build_*` parameters):

- `package.json` (repository root only)
- `package-lock.json` (repository root only)
- `.prettierrc` (repository root only)
- `tsconfig.json`
- `tsconfig.base.json`
- `.eslintrc.json`
- `vitest.workspace.ts`
- anything under `docs/`
- anything under `.circleci/`
- anything under `.cursor/`
- anything under `.claude/`
- anything under `.harness/`
- anything under `.opencode/`
- anything under repository-root `test/` (not `packages/*/test/`)

A workflow in `.circleci/ci.yml` gated on that parameter SHALL run the
root `check` script (`npm run check`).

The existing `.cursor/**` / `.claude/**` / `.harness/**` / `.opencode/**`
mappings SHALL remain. Harness-only PRs still set `build_workspace`.
That job's `npm test` still includes the suites that invoke
`check-agent-skills`. This packet SHALL NOT add a markdown or
frontmatter linter to `npm run check`.

#### Scenario: workspace-wide paths are mapped
- **WHEN** the path-filtering mapping in `.circleci/config.yml` is
  evaluated with `^`/`$` anchors as the orb applies them
- **THEN** each of those paths matches a mapping line that sets the
  workspace-wide parameter to `true`, and `packages/core/package.json`
  does not match the root `package.json` mapping, and
  `packages/core/test/unit/duration.test.ts` does not match the
  repository-root `test/` mapping

#### Scenario: workspace-wide workflow runs check
- **WHEN** `.circleci/ci.yml` is read
- **THEN** it declares that workspace-wide parameter (boolean, default
  `false`) and a workflow that runs when the parameter is true whose
  steps invoke `npm run check`


### Requirement: grpc-client is a CI-checked extender guard
Changes under `examples/grpc-client/` SHALL trigger a CircleCI workflow that
builds `@vnatures/test-kit`, then runs that workspace's `lint`, `typecheck`,
and `test` scripts. That workflow SHALL NOT publish the example to the npm
registry and SHALL NOT push a version-bump commit for it.

#### Scenario: grpc-client path is mapped
- **WHEN** the path-filtering mapping is evaluated with orb anchors
- **THEN** a path under `examples/grpc-client/` matches a mapping line that sets
  a grpc-client-specific boolean parameter to `true`

#### Scenario: grpc-client workflow lints and tests without publishing
- **WHEN** `.circleci/ci.yml` is read
- **THEN** it declares that parameter (boolean, default `false`) and a workflow
  gated on it that builds `@vnatures/test-kit`, runs lint, typecheck, and test
  for `examples/grpc-client`, and does not invoke `vn-ci/build-publish`

### Requirement: Gate-describing harness prose names the real gates
Any tracked markdown file under `.cursor/agents/`, `.cursor/skills/`,
`.cursor/commands/`, `.cursor/rules/`, `.claude/agents/`,
`.claude/skills/`, or `.claude/commands/` that tells an agent how to run
the repository-wide quality gate SHALL instruct `npm run check` and SHALL
state that the repository has no git hooks (no husky, no lefthook). It
SHALL NOT claim that there is no `check` script.

It SHALL NOT claim that `package-lock.json` or `.prettierrc` remain
unmapped CircleCI holes.

`.cursor/skills/spec-to-ship/SKILL.md` SHALL state that harness markdown
under `.cursor/` and `.claude/` is not format-checked or linted by
`npm run check`. It SHALL state that changes there still run the
workspace-wide `check` job in CI via the `.cursor/**` and `.claude/**`
path-filter mappings, and that that job's `npm test` includes the
suites that invoke `check-agent-skills`. It SHALL NOT contain the
phrase `a later packet` about a markdown or frontmatter linter. It
SHALL NOT instruct inventing a markdown or frontmatter linter.

#### Scenario: existing gate prose uses check and names the missing hooks
- **WHEN** those directories are scanned for markdown that mentions
  running `format:check` together with `lint`, `typecheck`, `build`,
  and `test`, or that mentions there being no `check` script
- **THEN** every such file contains `npm run check` and states that
  there are no git hooks, and none of them claim the `check` script is
  absent

#### Scenario: files that do not describe the repo gate are out of this requirement
- **WHEN** a tracked markdown file in those directories does not
  describe the repository-wide quality gate
- **THEN** this requirement does not constrain it

#### Scenario: gate prose does not claim lockfile or prettier holes
- **WHEN** those directories are scanned for markdown that describes
  the repository-wide quality gate
- **THEN** none of those files claim that `package-lock.json` or
  `.prettierrc` remain unmapped

#### Scenario: spec-to-ship does not defer a markdown linter as a later packet
- **WHEN** `.cursor/skills/spec-to-ship/SKILL.md` is read
- **THEN** it does not contain `a later packet`, it states that harness
  markdown is not format-checked or linted by `npm run check`, and it
  states that `.cursor/**` and `.claude/**` still run the workspace-wide
  `check` job whose tests invoke `check-agent-skills`


### Requirement: New TypeScript for this capability is on the root test and format paths
Tests that encode these scenarios SHALL run as part of the root `npm test`
workspace, and SHALL be included in the root `format:check` glob.

#### Scenario: repo-gate tests are in the Vitest workspace
- **WHEN** `vitest.workspace.ts` is read
- **THEN** it includes a project that picks up the tests for this capability

#### Scenario: repo-gate TypeScript is format-checked
- **WHEN** the root `format:check` script is read
- **THEN** its glob covers those test files

## Flow

```mermaid
sequenceDiagram
  participant Push as git push
  participant Setup as config.yml setup
  participant Filter as path-filtering orb
  participant Cont as ci.yml
  Push->>Setup: pipeline starts
  Setup->>Filter: paths changed vs main
  Filter->>Cont: continue with parameters
  alt workspace-wide path matched
    Cont->>Cont: npm run check
  else examples/grpc-client matched
    Cont->>Cont: build core, then lint typecheck test grpc-client
  else packages/name matched
    Cont->>Cont: vn-ci/init for that package
  end
```

## Decisions (rung recorded)

| Decision | Outcome | Rung |
| --- | --- | --- |
| Workspace-wide CI is one `check` job, not all 13 package workflows | Path-filter those paths onto a dedicated parameter whose workflow runs `npm run check` | Ticket (close the zero-check hole for P01/P05) plus source: root `npm test` without `build` hits stale `dist/`, so `vn-ci/init` at repo root is the wrong gate |
| `tsconfig.json` is mapped alongside the ticket's `tsconfig.base.json` | Both files set the workspace-wide parameter | Source: root `typecheck` is `tsc --build` against `tsconfig.json` |
| grpc-client CI does not use `vn-ci/build-publish` and does not version-bump on main | Build core (no pretest), then lint + typecheck + test only | Source: `examples/grpc-client/package.json` is `private` / `UNLICENSED`; ticket: it is the extender contract guard, not a published package |
| Parameter names follow existing `build_*` spelling | `build_workspace` and `build_grpc_client` | Source: `build_pglite_driver` / `build_pg_kysely` in `.circleci/config.yml` |
| gitignore narrows `.claude/` rather than deleting the directory | Ignore only `settings.local.json` and `worktrees/` | Ticket |
| Worktree is removed; branch `claude/gallant-ritchie-e7507a` is kept | `git worktree remove`, no `git branch -D` | Ticket |
| Git hooks are not added | Document absence in gate-describing harness prose | Ticket ("document, do not fix here") |
| Tests live at repo-file boundaries, not inside a published package | A Vitest project included from `vitest.workspace.ts` that reads tracked files | Ticket (this capability is the repo gate) plus write-failing-tests layout does not apply to a non-package |
| `.cursor/` is mapped onto `build_workspace` | Harness-only PRs run `npm run check` | Source: `.circleci/config.yml` (added by RD-24147) |
| `.claude/`, `.harness/`, `.opencode/` are mapped onto `build_workspace` | Harness-only PRs on any of the three surfaces run `npm run check` | Superseded by P05 (RD-24146): P00 deferred this until the trees existed |
| No public API / version bump | Root `package.json` is private; no package `src/` change | Source |

## Out of scope (deferred)

| Item | Consequence of deferring |
| --- | --- |
| Adding husky/lefthook/`prepare` / setting `core.hooksPath` | Agents and humans can still push without running `check`; CircleCI plus `npm run check` remain the only gates |
| Running grpc-client tests when `packages/core` changes | A core-only PR still does not execute the extender guard in CircleCI; root `check` does, when a workspace-wide path also changed |
| Mutation testing / CRAP (RD-24153) | Phase 5 still cannot tell whether green means anything |

## Acceptance mapping

1. Root `package.json` has `scripts.check` running `format:check`, `lint`, `typecheck`, `build`, `test` in order with `&&`.
2. `git worktree list` has no `gallant-ritchie-e7507a` worktree; branch of that name may still exist.
3. `.claude/launch.json` does not exist.
4. If `.claude/settings.local.json` exists, it lacks the forbidden push/PR/cross-repo-read grants and the listed residue commands.
5. `.gitignore` ignores `.claude/settings.local.json` and `.claude/worktrees/` and does not ignore `.claude/` wholesale.
6. Path-filtering maps root `package.json`, root `package-lock.json`, root `.prettierrc`, `tsconfig.json`, `tsconfig.base.json`, `.eslintrc.json`, `vitest.workspace.ts`, `docs/**`, `.circleci/**`, `.cursor/**`, `.claude/**`, `.harness/**`, `.opencode/**`, and repository-root `test/**` onto `build_workspace true`, without `packages/core/package.json` matching a root-file line or `packages/core/test/**` matching the `test/` line.
7. `.circleci/ci.yml` has `build_workspace` and a workflow that runs `npm run check` when it is true.
8. Path-filtering maps `examples/grpc-client/**` onto `build_grpc_client true`.
9. `.circleci/ci.yml` has `build_grpc_client` and a workflow that builds core, then lints, typechecks, and tests `examples/grpc-client` without `vn-ci/build-publish`.
10. The thirteen existing `packages/<name>/.*` mappings remain.
11. Gate-describing harness markdown, if any, says `npm run check` and that there are no git hooks, and does not claim `package-lock.json` or `.prettierrc` remain unmapped.
12. The tests for these scenarios run under root `npm test` and are in the root `format:check` glob.
13. `.cursor/skills/spec-to-ship/SKILL.md` contains no `a later packet` about a markdown linter, states that harness markdown under `.cursor/` and `.claude/` is not format-checked or linted by `npm run check`, and states that those paths still run the workspace-wide `check` job whose `npm test` invokes `check-agent-skills`.
