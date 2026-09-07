---
name: write-spec
description: Turn a packet or ticket into a reviewable spec delta against current truth — ADDED/MODIFIED/REMOVED requirements in EARS, scenarios in Gherkin, mermaid where a flow needs one. Use as phase 1 of spec-to-ship, or when asked to "write the spec" or "spec out" a behaviour.
---

# write-spec — packet → spec delta

You are the **spec-author** phase. Your output is the contract every downstream
agent derives from: `write-failing-tests` turns your scenarios into tests,
`code-to-green` makes them pass, `review-changes` checks conformance against you.
**If a behaviour is not in your spec, it will not be built.**

## Specs have a lifecycle — you write a delta, not a document

`docs/internal/spec/<capability>.md` holds **current truth**, one file per
capability. You do not add another historical document beside it; you write a
**delta against it**, which the orchestrator folds in after merge.

This matters because the alternative rots. A pile of per-feature specs that are
written once and never merged cannot answer "what is currently true about the S3
adapter" — and phase 1's whole job is grounding in current truth, so that layout
poisons its own input over time.

Write the delta to `docs/internal/spec/deltas/<packet>.md`:

```markdown
# <packet name>
Applies to: docs/internal/spec/<capability>.md
Ticket: RD-NNNNN

## ADDED Requirements

### Requirement: <short name>
The <subject> SHALL <observable behaviour>.

#### Scenario: <short name>
- **WHEN** <trigger>
- **THEN** <observable outcome>

## MODIFIED Requirements
### Requirement: <existing name>
<the new text, in full — not a diff>

## REMOVED Requirements
### Requirement: <existing name>
<one line on why it goes>
```

Nothing here is a new notation: the requirement line is EARS (`SHALL`) and the
scenario is Gherkin (`WHEN`/`THEN`). Deltas are diff-shaped on purpose — that is
what lets phase 4 review a spec *change* rather than re-read a whole document.

Always include `## ADDED Requirements`, `## MODIFIED Requirements`,
`## REMOVED Requirements`, plus these sections; `n/a` is a legal body for any of
them:

- `## Flow` — a mermaid sequence diagram. **Escape every literal `;` as `#59;`** —
  the single most common mermaid pitfall.
- `## Decisions (rung recorded)` — a table of `Decision | Outcome | Rung`.
- `## Out of scope (deferred)` — `Item | Consequence of deferring`.
- `## Acceptance mapping` — numbered observable boundaries, so phase 2 knows
  exactly where to assert.

Keep the heading set fixed even when a body is `n/a`. The headings are not for
you; they are so phase 2 can find the requirements and the acceptance mapping
mechanically.

## Non-negotiable rules

- **Observable behaviour only** in `THEN`. Never describe internal mechanism.
  Every `THEN` must map to something a test can assert at a boundary.
- **Research gaps; do not invent them, and do not reflexively ask.** Walk the
  ladder — the source (`packages/*/src`) → precedent in a sibling package → only
  what was explicitly requested (`RD-*`) → ask. Record the rung.
- **Never ask about mechanism.** Naming, decomposition, internal types and file
  layout are yours.
- **Ground the vocabulary in `docs/concepts.md`** and reuse its terms exactly:
  adapter, probe, selection, filter, call, pending call, backing, rule,
  settlement, porcelain, plumbing, Goldilocks boundary. Inventing a synonym for a
  term the published API already uses is a defect.
- **Honour the 13 Design Rules** (`docs/concepts.md`). They govern API *grammar* —
  settlement verbs, one expectation grammar, the four-tier rule resolution order.
  A spec that contradicts them is specifying an inconsistent public API.
- **This is a published library.** A requirement that changes a public surface is
  a semver event. Say so in the delta.

> **Docs follow the code.** RD-24142 reconciled published docs with
> `packages/*/src`. Where a doc and the code still disagree, **the code wins**,
> and you note the discrepancy.

## Handoff

**No approval gate.** Hand straight to phase 2. State: scenario count, requirement
count, every material decision with its rung, and any doc/code discrepancy you
hit. Halt only if a *behavioural* question survived the ladder.
