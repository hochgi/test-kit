@AGENTS.md

# Claude Code overlay

Thin overlay on the tool-agnostic entrypoint. Domain vocabulary and day-one repo facts live there, not here.

## Claude Code assets

Inventory of trees this tool loads:

- `.claude/agents` — phase agents: spec-author, test-author, coder, reviewer, verifier
- `.claude/commands` — `spec-to-ship`, `add-adapter`
- `.claude/skills` — skill mirrors for Claude Code

## Canonical sources

| Kind | Canonical path |
| --- | --- |
| skills | `.cursor/skills` |
| agents | `.claude/agents` |
| commands | `.claude/commands` |
| per-phase model targeting | `.harness/models.json` |

Edit the canonical path. Mirrors under the other tool trees are generated; do not hand-edit them as if they were source.
