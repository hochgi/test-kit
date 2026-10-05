# Contributing

Thanks for helping. This is an npm workspace of small published packages; the
public surface of those packages is the product, so most of the care goes into
keeping that surface narrow, consistent across the family, and documented.

## Before you start

- **Bugs:** open an issue with a minimal reproduction (a failing test is ideal).
- **New adapters or probe features:** open an issue first so we can agree on
  the boundary before you write code. `docs/concepts.md` explains the
  "Goldilocks" boundary every adapter aims for, and the Design Rules every
  package follows.
- **Typos, docs, dependency bumps:** just send the pull request.

## Development

Requires Node.js ≥ 20 and npm. `packages/mysql` also needs Docker.

```bash
npm ci
npm run build   # tests import packages by name through dist/, so build first
npm test
npm run check   # the full gate: format:check, lint, typecheck, build, test
```

`npm run check` is exactly what CI runs on your pull request. There are no git
hooks, so run it before you push.

## Pull requests

- Branch from `main`; name it `<type>/<short-slug>` (for example
  `fix/s3-list-prefix`).
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  with a package scope: `feat(s3): …`, `fix(core): …`, `docs: …`.
- Keep a pull request to one change. History is squash-merged.
- If you change a package's public API or behaviour, update its `README.md`
  and `docs/api-surface.md` in the same pull request, and bump that package's
  `version` in its `package.json` (semver: patch for fixes, minor for
  additions, major for breaking changes).

## Agent harness (optional)

The repository carries a spec-driven agent pipeline for Claude Code, Cursor
and OpenCode (`AGENTS.md`, `.claude/`, `.cursor/`, `.opencode/`, `.harness/`).
You don't need it to contribute. If you use it, `AGENTS.md` is the entry point;
edit the canonical trees listed in `CLAUDE.md` and run
`npm run sync-agent-skills` rather than editing the generated mirrors.

Per-phase models live in `.harness/models.json`. OpenCode runs every phase on
xAI Grok (`xai/grok-4.7`, variant `xhigh`): sign in with `/connect` → xAI in
OpenCode, and check what your login exposes with `opencode models xai`. Never
commit an `XAI_API_KEY`.

## Releases

Maintainers publish by running the **Release** workflow by hand. It publishes
every package whose `package.json` version is not on npm yet. Merging a pull
request never publishes anything. See [`RELEASING.md`](RELEASING.md).

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
