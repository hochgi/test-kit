# CI gate

What currently gates a change to this repository: CircleCI path-filtered
per-package jobs, plus whatever a contributor runs by hand. There is no unified
local check script and no git hooks.

> Folded current truth starts empty of the P00 behaviours. See
> `deltas/P00-repo-hygiene.md` until that packet is archived.

## Requirements

### Requirement: Per-package CircleCI workflows
When a file under `packages/<name>/` changes relative to `main`, CircleCI SHALL
set the corresponding `build_<name>` pipeline parameter so that package's
`vn-ci/init` workflow runs. On `main`, that package's `vn-ci/build-publish`
workflow SHALL also run.

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
