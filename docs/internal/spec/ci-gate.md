# CI gate

What currently gates a change to this repository: CircleCI path-filtered
per-package jobs, a workspace-wide `npm run check` workflow for named
root/docs/CI and harness-surface paths, a lint+test workflow for `examples/grpc-client`, and
main-only backup/audit. There are no git hooks (no husky, no lefthook).
`npm run lint` enforces the complexity budget and type-seam rules as a
ratchet (P09 / RD-24150). P10 (RD-24151) extracted s3 `handleList` to
complexity ≤ 12 and deleted the P09 next-line disable.

Folded from the P09 delta (RD-24150), preserved at
`docs/internal/archive/2026-09-10-P09-blinker-ratchet/delta.md`.
P10 list-contract current truth is `docs/internal/spec/s3-backing.md`;
its delta is at
`docs/internal/archive/2026-09-10-P10-s3-handlelist-decomposition/delta.md`.
P12 (RD-24153) landed per-package Stryker and CRAP; they are not a
step of `npm run check`. Phase 5 runs `test:mutation:changed` and
`crap:changed`. Folded from
`docs/internal/archive/2026-09-17-P12-mutation-and-crap/delta.md`.

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
It SHALL also ignore `.stryker-tmp`, `reports/mutation`, `coverage`,
`stryker.log`, and `.stryker-package`.

#### Scenario: gitignore is narrowed
- **WHEN** root `.gitignore` is read
- **THEN** it lists `.claude/settings.local.json` and `.claude/worktrees/`, and
  it has no ignore pattern that is exactly `.claude/`

#### Scenario: gitignore lists mutation artifacts
- **WHEN** root `.gitignore` is read
- **THEN** it contains `.stryker-tmp`, `reports/mutation`, `coverage`,
  `stryker.log`, and `.stryker-package`

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
- `vitest.config.ts`
- `vitest.mutation.config.ts`
- the Stryker config file
- anything under `scripts/`
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

### Requirement: Vitest projects live in vitest.config.ts
Root `vitest.config.ts` SHALL be the Vitest config that lists every test
project under `test.projects`. The repository SHALL NOT contain
`vitest.workspace.ts`. Root `package.json` `lint` and `format:check`
SHALL name `vitest.config.ts`. CircleCI path-filtering SHALL map
`vitest.config.ts` onto `build_workspace true` and SHALL NOT map
`vitest.workspace.ts`. `npm test` SHALL keep using each package's own
`vite.config.ts` (built `dist/` via package name), not the mutation
aliases.

#### Scenario: defineWorkspace and vitest.workspace.ts are gone
- **WHEN** the repository root is listed and `vitest.config.ts` is read
- **THEN** `vitest.workspace.ts` does not exist, `vitest.config.ts`
  contains `test.projects` and does not contain `defineWorkspace`, and
  `test.projects` includes `packages/core`, `packages/mock`,
  `test/ci-gate`, `test/harness-prose`, `test/harness-scaffold`, and
  `test/docs-truth`

#### Scenario: root scripts and path-filter name vitest.config.ts
- **WHEN** root `package.json` scripts `lint` and `format:check`, and
  `.circleci/config.yml` path-filtering mapping, are read
- **THEN** each names `vitest.config.ts` and none names
  `vitest.workspace.ts`

### Requirement: Mutation-only Vite config aliases workspace packages to source
Root `vitest.mutation.config.ts` SHALL alias every published
`@vnatures/test-kit*` workspace package name to that package's
`packages/<dir>/src/index.ts`. It SHALL NOT enable Vitest typecheck. It
SHALL NOT list `test.projects` and SHALL NOT import `defineWorkspace`.
It SHALL set `test.server.deps.inline` so `@vnatures/` packages are
transformed. Test include SHALL be scoped to one package via
`.stryker-package`, not to repository-root `test/`.

Stryker SHALL load this file via `vitest.configFile` and SHALL set
`vitest.related` to `false`. It SHALL NOT rely on Stryker `vitest.dir`
as the scoping mechanism.

#### Scenario: mutation config aliases each workspace package to src/index.ts
- **WHEN** `vitest.mutation.config.ts` is loaded
- **THEN** its resolve aliases map `@vnatures/test-kit` to
  `packages/core/src/index.ts` and `@vnatures/test-kit-mock` to
  `packages/mock/src/index.ts`, and every other published workspace
  package name under `packages/*/package.json` has a corresponding
  alias to that directory's `src/index.ts`

#### Scenario: mutation config does not load the default project graph
- **WHEN** `vitest.mutation.config.ts` is read
- **THEN** it does not contain `defineWorkspace` or `test.projects`, and
  it sets typecheck enabled to false

#### Scenario: Stryker uses the mutation config and disables related mode
- **WHEN** the Stryker config is read
- **THEN** `testRunner` is `vitest`, `vitest.configFile` is
  `vitest.mutation.config.ts`, and `vitest.related` is `false`

#### Scenario: mutation vitest loads source, not dist
- **WHEN** `npx vitest run --config vitest.mutation.config.ts` is run
  against `packages/core/test/unit/duration.test.ts` after writing the
  package name `core` to `.stryker-package`
- **THEN** the run's resolved `@vnatures/test-kit` module path contains
  `packages/core/src` and does not contain `packages/core/dist`

### Requirement: Per-package mutation runner
`scripts/mutation-package.sh` SHALL take a published package directory
name, write that name to repository-root `.stryker-package`, and invoke
Stryker with `mutate` limited to `packages/<name>/src/**/*.ts`
excluding `*.d.ts`.

The mutation Vite config SHALL include `packages/<name>/test/**/*.test.ts`
for that name. When the name is `mysql`, that include SHALL NOT be
listed in `test.exclude` (Vitest exclude wins over include). When the
name is `core`, it SHALL also include `packages/*/test/**/*.test.ts`
except `packages/mysql/test/**` and except these core layout files:

- `packages/core/test/unit/rig-docs-naming.test.ts`
- `packages/core/test/unit/rig-rename-layout.test.ts`
- `packages/core/test/unit/package-graph.test.ts`
- `packages/core/test/unit/rig-public-surface.test.ts`

When `.stryker-package` is absent (the `crap` / `crap:changed` path),
include SHALL be `packages/*/test/**/*.test.ts` and SHALL NOT exclude
`packages/mysql/test/**`.

Stryker `concurrency` SHALL be `1` when the package is `mysql` and SHALL
be greater than `1` for in-process packages. `thresholds.break` SHALL be
`null`.

`scripts/mutation-incremental.sh` SHALL source `scripts/changed-src.sh`,
group changed production files by `packages/<name>`, and invoke the
per-package runner for each touched published package that has tests.
It SHALL exit 0 without invoking Stryker when no production src files
changed. It SHALL skip a package that has no
`packages/<name>/test/**/*.test.ts` files.

Root `package.json` SHALL define `test:mutation` and
`test:mutation:changed`. Neither SHALL be a step of `scripts.check`.

#### Scenario: mutation-package writes .stryker-package and mutates that package's src
- **WHEN** `scripts/mutation-package.sh` is read
- **THEN** it writes the package directory name to `.stryker-package`
  and invokes Stryker with a `--mutate` glob under `packages/<name>/src`

#### Scenario: mutation include for mock is that package's tests only
- **WHEN** `.stryker-package` contains `mock` and the mutation Vite
  config is loaded
- **THEN** its test include contains `packages/mock/test/**/*.test.ts`
  and does not contain `packages/core/test/**/*.test.ts` as a required
  match for a mock-only run

#### Scenario: mutation include for mysql is that package's tests only
- **WHEN** `.stryker-package` contains `mysql` and the mutation Vite
  config is loaded
- **THEN** its test include contains `packages/mysql/test/**/*.test.ts`
  and its exclude does not contain `packages/mysql/test/**`

#### Scenario: mutation include for core covers sibling in-process tests and drops layout files
- **WHEN** `.stryker-package` contains `core` and the mutation Vite
  config is loaded
- **THEN** its test include covers `packages/*/test/**/*.test.ts`, its
  exclude lists the four core layout files named above, and it excludes
  `packages/mysql/test/**`

#### Scenario: mysql mutation concurrency is 1
- **WHEN** the Stryker configuration used for `mysql` is read
- **THEN** `concurrency` is `1`

#### Scenario: incremental mutation skips when no production src changed
- **WHEN** `scripts/mutation-incremental.sh` is invoked on a tree whose
  `changed_src_files` list is empty
- **THEN** it exits 0 without invoking `stryker`

#### Scenario: test:mutation scripts exist and are not in check
- **WHEN** root `package.json` `scripts` is read
- **THEN** it defines `test:mutation` and `test:mutation:changed`, and
  `scripts.check` equals
  `npm run format:check && npm run lint && npm run typecheck && npm run build && npm test`

### Requirement: A zero-mutant Stryker success is a failure
The per-package mutation runner SHALL exit non-zero when Stryker
instruments zero mutants for the requested mutate glob, including the
case where zero files matched.

#### Scenario: mutating a glob that matches no source fails
- **WHEN** the per-package runner is invoked with a mutate glob that
  matches no `packages/*/src/**/*.ts` file
- **THEN** the process exits non-zero

#### Scenario: duration.ts mutation produces a non-zero mutant count
- **WHEN** Stryker is run against `packages/core/src/duration.ts` with
  the mutation Vite config and `.stryker-package` set to `core`
- **THEN** the JSON report records more than 0 mutants and more than 0
  killed mutants

### Requirement: CRAP scores source functions from istanbul coverage
`scripts/crap-report.js` SHALL exist in the existing `scripts/`
directory. It SHALL implement
`CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)` per function, reading
coverage from Istanbul `coverage-final.json` `statementMap` (not v8).
Test paths SHALL be treated as `packages/*/test/**`, repository-root
`test/**`, and `*.test.ts` / `*.spec.ts` files. Patch scoping SHALL look
at `packages/*/src/**/*.ts`.

Root `package.json` SHALL define `crap` and `crap:changed`.
`@vitest/coverage-istanbul` SHALL be a root devDependency. Neither crap
script SHALL be a step of `scripts.check`. Coverage collection SHALL use
the mutation Vite config so `coverage-final.json` keys are
`packages/*/src/**/*.ts` files, not `packages/*/dist/**/*.js`.

#### Scenario: crap-report.js lives under the existing scripts directory
- **WHEN** `scripts/` is listed
- **THEN** it contains `crap-report.js` and the P05 files
  `agent-sync-lib.sh`, `sync-agent-skills.sh`, and
  `check-agent-skills.sh`

#### Scenario: crap-report uses istanbul statementMap and packages/*/src
- **WHEN** `scripts/crap-report.js` is read
- **THEN** it contains `statementMap`, `packages/*/src`, and
  `CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)`, and it does not
  treat a root `specs/` directory as the test corpus

#### Scenario: crap scripts exist, use istanbul, and are not in check
- **WHEN** root `package.json` is read
- **THEN** `scripts.crap` and `scripts.crap:changed` exist,
  `devDependencies` contains `@vitest/coverage-istanbul`, `scripts.crap`
  names `istanbul` or `vitest.mutation.config.ts`, and `scripts.check`
  does not contain `crap`

#### Scenario: istanbul coverage keys are TypeScript sources
- **WHEN** `npx vitest run --config vitest.mutation.config.ts --coverage`
  is run for package `core` with provider istanbul
- **THEN** `coverage/coverage-final.json` has at least one key whose
  path contains `packages/core/src/` and ends with `.ts`, and has no key
  whose path contains `packages/core/dist/`

### Requirement: changed-src.sh resolves vn/main and packages/*/src
`scripts/changed-src.sh` SHALL define `resolve_patch_base` that prefers
`vn/main`, then local `main`, and SHALL fail if neither exists. It SHALL
NOT look up `vn/master` or `origin/master`. `changed_src_files` SHALL
list production TypeScript under `packages/*/src` (committed, staged,
unstaged, and untracked vs that base) and SHALL exclude
`packages/*/test/**` and `*.test.ts` / `*.spec.ts` files.

#### Scenario: resolve_patch_base prefers vn/main then main
- **WHEN** `scripts/changed-src.sh` is read
- **THEN** `resolve_patch_base` contains `vn/main` and `main`, and does
  not contain `vn/master` or `origin/master`

#### Scenario: changed_src_files is packages/*/src, not root src or specs
- **WHEN** `scripts/changed-src.sh` is read
- **THEN** `changed_src_files` names `packages/` and `src`, and does not
  use a pathspec that is exactly `src` at the repository root, and does
  not grep for `/specs/`

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


### Requirement: Blinker ratchet rules are errors in the root ESLint config
Root `.eslintrc.json` SHALL set these rules to `"error"` on the default
(non-override) `rules` map. The seven **ratchet rules** are:

- `complexity` with option `{ "max": 12 }`
- `max-depth` with option `4`
- `max-params` with option `5`
- `max-lines-per-function` with option
  `{ "max": 80, "skipBlankLines": true, "skipComments": true, "IIFEs": true }`
- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/consistent-type-imports`
- `@typescript-eslint/ban-ts-comment` with option
  `{ "ts-expect-error": "allow-with-description", "ts-ignore": "allow-with-description", "ts-nocheck": "allow-with-description", "ts-check": "allow-with-description" }`

`.eslintrc.json` `overrides` SHALL NOT set any ratchet rule to `"off"`,
`"warn"`, `0`, or `1`, and SHALL NOT replace a ratchet rule's options with
a more lenient max.

This packet SHALL NOT add a file-glob `overrides` entry whose purpose is
to excuse an already-violating file from a ratchet rule.

`consistent-type-imports` violations SHALL be resolved by type-only
imports (`import type`), not by an `eslint-disable` of that rule.

#### Scenario: complexity-budget ESLint rules are errors with pinned options
- **WHEN** root `.eslintrc.json` `rules` is read
- **THEN** `complexity` is error with `max` 12, `max-depth` is error with
  4, `max-params` is error with 5, and `max-lines-per-function` is error
  with `max` 80, `skipBlankLines` true, `skipComments` true, and `IIFEs`
  true

#### Scenario: type-seam ESLint rules are errors with sibling ban-ts-comment options
- **WHEN** root `.eslintrc.json` `rules` is read
- **THEN** `@typescript-eslint/no-explicit-any` and
  `@typescript-eslint/consistent-type-imports` are error, and
  `@typescript-eslint/ban-ts-comment` is error with
  `ts-expect-error`, `ts-ignore`, `ts-nocheck`, and `ts-check` each set
  to `allow-with-description`

#### Scenario: eslintrc overrides do not weaken the ratchet rules
- **WHEN** each entry in root `.eslintrc.json` `overrides` is read
- **THEN** none of those entries sets a ratchet rule to off, warn, 0, or
  1, and none replaces a ratchet rule's options with a more lenient max

### Requirement: Existing ratchet violations use next-line disables with a justification
A tracked TypeScript file under `packages/`, `examples/`, or
repository-root `test/` SHALL NOT contain a file-level or block
`eslint-disable` (a directive that is not `eslint-disable-next-line` and
is not `eslint-disable-line`) that names a ratchet rule.

Each `eslint-disable-next-line` or `eslint-disable-line` that names a
ratchet rule SHALL include a `--` justification with at least one
non-whitespace character after the dashes.

`max-classes-per-file` is not a ratchet rule. An existing file-level
disable of that rule alone MAY remain.

#### Scenario: no file-level eslint-disable of a ratchet rule
- **WHEN** tracked `*.ts` files under `packages/`, `examples/`, and
  repository-root `test/` are scanned for `eslint-disable` directives
- **THEN** no directive that is not `eslint-disable-next-line` and not
  `eslint-disable-line` names `complexity`, `max-depth`, `max-params`,
  `max-lines-per-function`, `@typescript-eslint/no-explicit-any`,
  `@typescript-eslint/consistent-type-imports`, or
  `@typescript-eslint/ban-ts-comment`

#### Scenario: ratchet next-line disables carry a justification
- **WHEN** those same files are scanned for `eslint-disable-next-line`
  and `eslint-disable-line` directives that name a ratchet rule
- **THEN** each such directive contains `--` followed by a non-empty
  justification

### Requirement: New TypeScript for this capability is on the root test and format paths
Tests that encode these scenarios SHALL run as part of the root `npm test`
workspace, and SHALL be included in the root `format:check` glob.

#### Scenario: repo-gate tests are in the Vitest workspace
- **WHEN** `vitest.config.ts` is read
- **THEN** it includes a project that picks up the tests for this capability

#### Scenario: repo-gate TypeScript is format-checked
- **WHEN** the root `format:check` script is read
- **THEN** its glob covers those test files and covers
  `vitest.config.ts` and `vitest.mutation.config.ts`

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

```mermaid
sequenceDiagram
  participant Agent as coding agent
  participant Cfg as eslintrc.json
  participant Src as packages and test TypeScript
  participant Lint as npm run lint
  Agent->>Cfg: ratchet rules on at error
  Agent->>Src: next-line disable per existing violation
  Agent->>Lint: npm run lint --max-warnings 0
  alt new breach without a justified disable
    Lint-->>Agent: non-zero
  else in budget, or existing violation excused inline
    Lint-->>Agent: exit 0
  end
```

```mermaid
sequenceDiagram
  participant V as verifier
  participant Inc as mutation-incremental.sh
  participant Pkg as mutation-package.sh
  participant S as stryker
  participant M as vitest.mutation.config.ts
  V->>Inc: npm run test:mutation:changed
  Inc->>Inc: resolve_patch_base vn/main then main
  Inc->>Inc: changed_src_files packages/*/src
  alt no production src changed
    Inc->>V: exit 0
  else per touched package
    Inc->>Pkg: package dir name
    Pkg->>Pkg: write .stryker-package
    Pkg->>S: mutate packages/name/src
    S->>M: configFile related false
    M->>S: alias @vnatures/* to src/index.ts
    S->>Pkg: mutation.json
    alt mutant count is 0
      Pkg->>V: exit non-zero
    else mutants exist
      Pkg->>V: score report
    end
  end
  V->>V: npm run crap:changed via istanbul on src
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
| Tests live at repo-file boundaries, not inside a published package | A Vitest project included from `vitest.config.ts` that reads tracked files | Ticket (this capability is the repo gate) plus write-failing-tests layout does not apply to a non-package |
| `.cursor/` is mapped onto `build_workspace` | Harness-only PRs run `npm run check` | Source: `.circleci/config.yml` (added by RD-24147) |
| `.claude/`, `.harness/`, `.opencode/` are mapped onto `build_workspace` | Harness-only PRs on any of the three surfaces run `npm run check` | Superseded by P05 (RD-24146): P00 deferred this until the trees existed |
| No public API / version bump | Root `package.json` is private; no package `src/` change | Source |
| `ban-ts-comment` options | Pin `@vnatures/eslint-config` (reports_service / vn-server): `allow-with-description` for `ts-expect-error`, `ts-ignore`, `ts-nocheck`, `ts-check`. `"ts-expect-error": true` is not used | Sibling (`@vnatures/eslint-config` 1.1.0) + re-measure (RD-24150) |
| `max-lines-per-function` skip flags | `{ max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }` as in cycle-processing's shared eslint-config | Sibling (`cycle-processing/packages/eslint-config`) + ticket + re-measure (RD-24150) |
| Ratchet via next-line disables, not file-glob `overrides` | New violations in an already-excused file still fail lint unless a new visible disable is added | Ticket (RD-24150) |
| Convert `pg-sequelize/src/dialect.ts` file-level `no-explicit-any` disable to next-line | File-level disable of a ratchet rule would let new `any`s slip in. `max-classes-per-file` on that same comment is not a ratchet rule and may stay file-level | Ticket (RD-24150) |
| Autofix `consistent-type-imports` rather than disable | Ticket: all four `--fix-dry-run` confirmed | Ticket + re-measure (RD-24150) |
| Do not extract `handleList` (complexity 26) | Superseded by P10 (RD-24151): `handleList` is extracted to complexity ≤ 12 and the P09 next-line disable is gone | Ticket (P10) |
| Root `test/` is in the ratchet | `npm run lint` starts with `eslint test vitest.config.ts vitest.mutation.config.ts` | Source (`package.json` `scripts.lint`) + re-measure (RD-24150) |
| Mutation-only Vite aliases `@vnatures/*` → `packages/*/src/index.ts`; `npm test` keeps validating `dist/` | Spike: poisoning `duration.ts` failed mutation vitest and passed workspace vitest | Spike measurement + ticket (RD-24153) |
| Replace `vitest.workspace.ts` / `defineWorkspace` with `vitest.config.ts` `test.projects` | With the workspace file present, `--config vitest.mutation.config.ts` still loaded dist | Spike measurement + ticket (Vitest 3.2 deprecation) |
| Scope tests via mutation config include / `.stryker-package`, not Stryker `vitest.dir` | Stryker 10 passes `dir` as top-level `createVitest` option; Vitest 3.2.7 treats that as Vite cache dir | Spike measurement |
| `vitest.related: false` | Tests import by package name, not by file path | Ticket + source |
| Core mutation include is all in-process package tests, minus mysql and four layout files | `probe-engine.ts` scored 0% killed against core's 18 remaining tests | Spike measurement |
| `concurrency: 1` only for mysql; mysql include is that package's tests and is not excluded | Only mysql starts Testcontainers; Vitest exclude wins over include | Source + Bugbot on RD-24153 |
| Istanbul, not v8; `thresholds.break: null`; not a step of `npm run check` | Coverage keys are `packages/*/src/**/*.ts`; P00 pinned the five-step check chain | Spike + source (`ci-gate.md`) |
| `changed-src.sh` prefers `vn/main` then `main`; pathspec `packages/*/src` | Ticket named those two bugs | Ticket |

## Out of scope (deferred)

| Item | Consequence of deferring |
| --- | --- |
| Adding husky/lefthook/`prepare` / setting `core.hooksPath` | Agents and humans can still push without running `check`; CircleCI plus `npm run check` remain the only gates |
| Running grpc-client tests when `packages/core` changes | A core-only PR still does not execute the extender guard in CircleCI; root `check` does, when a workspace-wide path also changed |
| Extract `dispatch` in `packages/s3/src/s3-client/in-memory-backing.ts` (complexity 14) | It stays behind `eslint-disable-next-line complexity -- existing function over the published budget; extract on next touch` until that method is edited |
| Extracting the other complexity-13 functions (`recordCallImpl` × 2, `createProbedSequelizeAdapter`, repo-root test helpers) | They stay behind next-line disables until a later touch extracts them |
| Turning on other currently-off rules (`no-empty-object-type`, `no-empty-function`, `no-namespace`, `no-empty-pattern`) | Those stays-off are not this packet's ratchet |
| Replacing remaining `any` type-seam escapes with `unknown` | The 12-no-escape-hatches blinker still forbids *new* `any`; existing ones are justified inline |
| Adding mutation or CRAP to the five-step `npm run check` | `npm run check` stays fast; phase 5 runs the extra scripts |
| CircleCI job that runs Stryker / a non-null `thresholds.break` | CI still only runs `npm run check`; a PR can merge with un-run mutation unless the verifier ran it |
| Mutating `examples/grpc-client` or `pglite-driver` (no tests) | Those trees are not scored |
| Killing the genuine `duration.ts` `<` vs `<=` survivors | Score is not 100%; the skill says hand-apply survivors |
| Fixing open stryker-js#6192 | Single-project mutation config avoids the reported projects repro; survivors are still hand-checked |

## Acceptance mapping

1. Root `package.json` has `scripts.check` running `format:check`, `lint`, `typecheck`, `build`, `test` in order with `&&`.
2. `git worktree list` has no `gallant-ritchie-e7507a` worktree; branch of that name may still exist.
3. `.claude/launch.json` does not exist.
4. If `.claude/settings.local.json` exists, it lacks the forbidden push/PR/cross-repo-read grants and the listed residue commands.
5. `.gitignore` ignores `.claude/settings.local.json` and `.claude/worktrees/` and does not ignore `.claude/` wholesale; it also ignores `.stryker-tmp`, `reports/mutation`, `coverage`, `stryker.log`, and `.stryker-package`.
6. Path-filtering maps root `package.json`, root `package-lock.json`, root `.prettierrc`, `tsconfig.json`, `tsconfig.base.json`, `.eslintrc.json`, `vitest.config.ts`, `vitest.mutation.config.ts`, the Stryker config, `scripts/**`, `docs/**`, `.circleci/**`, `.cursor/**`, `.claude/**`, `.harness/**`, `.opencode/**`, and repository-root `test/**` onto `build_workspace true`, without `packages/core/package.json` matching a root-file line or `packages/core/test/**` matching the `test/` line.
7. `.circleci/ci.yml` has `build_workspace` and a workflow that runs `npm run check` when it is true.
8. Path-filtering maps `examples/grpc-client/**` onto `build_grpc_client true`.
9. `.circleci/ci.yml` has `build_grpc_client` and a workflow that builds core, then lints, typechecks, and tests `examples/grpc-client` without `vn-ci/build-publish`.
10. The thirteen existing `packages/<name>/.*` mappings remain.
11. Gate-describing harness markdown, if any, says `npm run check` and that there are no git hooks, and does not claim `package-lock.json` or `.prettierrc` remain unmapped.
12. The tests for these scenarios run under root `npm test` and are in the root `format:check` glob.
13. `.cursor/skills/spec-to-ship/SKILL.md` contains no `a later packet` about a markdown linter, states that harness markdown under `.cursor/` and `.claude/` is not format-checked or linted by `npm run check`, and states that those paths still run the workspace-wide `check` job whose `npm test` invokes `check-agent-skills`.
14. Root `.eslintrc.json` `rules` has `complexity` error `{ max: 12 }`, `max-depth` error `4`, `max-params` error `5`, `max-lines-per-function` error `{ max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }`.
15. Root `.eslintrc.json` `rules` has `@typescript-eslint/no-explicit-any` error, `@typescript-eslint/consistent-type-imports` error, and `@typescript-eslint/ban-ts-comment` error with the four directives set to `allow-with-description`.
16. No `.eslintrc.json` `overrides` entry turns a ratchet rule off/warn or loosens its max.
17. No tracked `packages/` / `examples/` / repo-root `test/` `*.ts` file has a file-level or block `eslint-disable` of a ratchet rule.
18. Every next-line or same-line disable of a ratchet rule in those files includes `--` plus a non-empty justification.
19. `npm run lint` exits 0 with the ratchet on (`--max-warnings 0`). There are still no git hooks.
20. `vitest.workspace.ts` is gone; `vitest.config.ts` has `test.projects`; `vitest.mutation.config.ts` aliases `@vnatures/*` to `src/index.ts`.
21. `test:mutation` / `test:mutation:changed` / `crap` / `crap:changed` exist and are not steps of `scripts.check`; a zero-mutant Stryker success exits non-zero.
22. Mysql mutation include is `packages/mysql/test/**/*.test.ts` and that glob is not excluded; core mutation still excludes mysql tests.
