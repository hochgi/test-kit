# P00 repo hygiene + close the CI gate holes

Ticket: RD-24141
Depends on: (none)

Prerequisite housekeeping. Two CI holes mean docs-only and root-config PRs
currently ship with zero checks; close those before anything else lands.

Scope: local hygiene (stale Claude worktree, cross-repo launch.json, local
settings grants, `.gitignore` for `.claude/`), a root `check` script, and
CircleCI path-filtering for workspace-wide paths plus `examples/grpc-client`.

Out: git hooks (document the absence; do not add husky/lefthook).
