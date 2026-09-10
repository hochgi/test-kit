---
name: summon-review-panel
description: >-
  Summon the intersection of committed review-panel policy and live
  capability on an open PR. Use after opening a PR and after a later
  push; do not use this skill to triage findings.
---

# summon-review-panel

Summon review bots on an open PR. Remote is **`vn`**. Never run
`gh auth login`. This is a skill, not a slash command, and not a sixth
pipeline agent.

Findings that land hand off to `pr-review-style`. This skill does not
triage. Re-summon after a later push without running triage.

## Policy vs capability

**Policy** is what this repository wants reviewed. It is the committed
`wanted` array in `.harness/review-panel.json`. **Capability** is live
seat and reachability on the current account. Capability is not
committed — do not add `capability` or `seats` keys to that file.

Known bot ids are exactly `copilot`, `bugbot`, and `baz`. An omitted or
unticked id is not the same signal as a missing seat.

## Record policy if missing

If `.harness/review-panel.json` is absent, ask via `AskUserQuestion`
**multi-select** which of `copilot`, `bugbot`, and `baz` this repository
wants. Write the answer as `wanted`, then summon.
A later run does not ask while review-panel.json exists.

## Summon the intersection

For each id in `wanted` that this account can invoke, at most once:

- `copilot` — add copilot as a reviewer on the PR
- `bugbot` — comment `@cursor review` on the PR (that string is the
  whole comment body; do not prefix it with `🤖:`)
- `baz` — org-automatic if present; do not add Baz config, CODEOWNERS,
  or anything under `.github/`

This does **not** contradict `no GitHub Actions`: adding a reviewer and
commenting on a PR are per-PR actions and need zero CI.

State every gap. Example: `policy wants bugbot; no seat on this account`.
When a summon fails, or a bot is unreachable, re-prompt via
`AskUserQuestion` for this run only (retry, skip this run, or continue
with the gap named). Do not drop a bot from `wanted` because a summon
failed. Changing `wanted` is an explicit committed edit, not a
capability patch.

Done when every capable wanted bot is summoned and every gap is named.
