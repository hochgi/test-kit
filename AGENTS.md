# Agent entrypoint

Tool-agnostic instructions for Cursor, Claude Code, and OpenCode. Canonical terms live in `CONTEXT.md`. Per-phase model targeting lives in `.harness/models.json`.

## What this repo is

This repository is the `@vnatures/test-kit` npm workspace of published packages: probe-driven component testing for TypeScript services. The public surface of those packages is the product.

## Layout

- `packages/` — published library packages
- `examples/` — example apps that consume the packages
- `docs/` — concepts, API, architecture, internal spec
- `.cursor/` — Cursor agents, skills, and blinkers
- `.claude/` — Claude Code agents, commands, and skill mirrors
- `.opencode/` — OpenCode agent and command mirrors
- `.harness/` — agent-pipeline manifest (models, sync)

## Commands

- `npm run check` — the full gate: format:check, lint, typecheck, build, test
- `npm run build` — build every workspace (writes `dist/`)
- `npm test` — `vitest run` across the workspace projects

There is no single substitute for `npm run check` when shipping.

## Blinkers

Files under `.cursor/rules/` are blinkers. Call them blinkers, not rules — the published API already owns Rule. Read them before editing `packages/*/src`.

## Testing

Root `npm test` does not run per-package `pretest` builds. Always run `npm run build` first, or specifier resolution (`@vnatures/test-kit` and siblings) hits a stale `dist/`.

The full gate is `npm run check`.

There are no git hooks: no husky, no lefthook. Nothing local will catch a skipped gate.

`packages/mysql` needs Docker (Testcontainers). Other in-process backings do not.

## Workflow

Non-trivial changes run `/spec-to-ship`: spec-author, test-author, coder, reviewer, verifier, then open a PR and address review threads.

Stop when every review thread is addressed. Do not merge while a PR is open.

Git conventions:

- Remote `vn` (there is no `origin`)
- Base branch `main`
- History is squash-only
- Branches are `RD-NNNNN_slug`
- Commits are Conventional Commits with a package scope

## Model targeting

Per-phase model targeting is the table in `.harness/models.json`. Point at that file; do not copy vendor or gateway model ids into this entrypoint, prompts, or overlays.
