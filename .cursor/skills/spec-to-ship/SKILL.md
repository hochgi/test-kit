---
name: spec-to-ship
description: >-
  Orchestrator overview of the 5-phase delivery pipeline for @vnatures/test-kit:
  spec-author → test-author → coder → reviewer → verifier, run gate-free. Use as
  the entry point when starting ANY non-trivial change, and to understand how the
  /spec-to-ship command, the five agents and the phase skills fit together.
---

# spec-to-ship — the pipeline

The delivery workflow for every non-trivial change in `@vnatures/test-kit`. It
exists because plausible-looking-but-wrong code is the dominant failure mode in
agent-driven development. The loop kills it by forcing the spec before tests,
tests before code, correctness review before verification, and by never letting
the agent that produced an artifact be the agent that signs it off.

**Context is handed off through artifacts, not chat history.** Each phase's output
— the spec delta, the red suite, the diff, the review — is the durable interface
to the next phase. Write for the next agent, which does not share your context.

## The five phases

```
PHASE 1 — SPEC          spec-author    main thread, may ask the user
  packet/ticket → a spec DELTA against docs/internal/spec/<capability>.md
  skill: write-spec
        │  verify the artifact, then continue
PHASE 2 — RED           test-author    delegated
  one Vitest test per scenario + compiling stubs that FAIL meaningfully
  skill: write-failing-tests
        │  confirm the red bar yourself
PHASE 3 — GREEN         coder          delegated
  implement until green; format/lint/typecheck/build/test all clean
  skill: code-to-green
        │  re-run the gate yourself, never trust
PHASE 4 — REVIEW        reviewer       delegated, READ-ONLY
  spec conformance, public-API consistency, docs-match-code, regressions
  skill: review-changes
        │  must-fixes → coder / test-author / spec-author
PHASE 5 — VERIFY        verifier       delegated, READ-ONLY
  independent re-run of the whole gate + suppression audit
  skill: verify-changes
        │
   PR → bots → fix → threads clean → STOP
        human squash-merges onto main
        then FOLD THE DELTA → ARCHIVE (follow-up PR on updated main)
```

## Why 4 and 5 are separate, and read-only

Phase 3's goal is *make it green*. An agent inside that goal, asked whether a
suppression is legitimate, is deciding inside a bias toward allowing it. Phases 4
and 5 have no such goal and cannot write production code, so they judge honestly.
That is the whole of "nobody grades their own homework", and it is the one part of
this pipeline that must not be collapsed to save a step.

## Phase 5 is thin here, and must say so

test-kit has **no mutation testing and no CRAP report.** That is RD-24153, and it
is blocked on something real: 33 of 34 test files import by package name and
resolve into `dist/`, so a mutant applied to `src` is never loaded — a naive
Stryker install would report a ~0% score composed entirely of resolution
artifacts, and CRAP would break the same way.

So phase 5 verifies that green is *real* (independent re-run, suppression audit,
regression sweep). It cannot yet verify that green *means anything*. The verifier
states that limitation in every handoff. An unstated missing gate is worse than a
stated one.

## Autonomy: no human gates

Run 1 → 2 → 3 → 4 → 5, fix findings, open the PR, iterate review. Do not merge
or archive until the PR is on `main`. Do not stop to ask whether to proceed
between phases and do not present finished work for approval.

**Resolve yourself, silently:** anything that does not change observable
behaviour — naming, decomposition, internal types, test structure, file layout.

**When a decision does change behaviour**, walk the ladder: the source
(`packages/*/src`) → precedent in a sibling package → only what was explicitly
requested (the `RD-*` ticket) → ask. Record the rung in the spec.

## What replaces the gates

- **Never trust a phase's self-report.** Re-run the tests, typecheck, lint and
  build yourself after every phase. A subagent claiming green is a hypothesis.
- **Audit every suppression.** A justification naming a condition that only holds
  for the tested inputs is a masked defect until proven otherwise. The verifier
  inspects justification and named diagnostic; it does not mutate the tree.
- **A phase that reports a problem honestly is doing its job.** Fix the finding;
  do not wave it through to keep momentum.

Harness markdown under `.cursor/` and `.claude/` is not format-checked or linted by
`npm run check` (that script is TypeScript-focused). Changes there still run the
workspace-wide `check` job in CI via the `.cursor/**` and `.claude/**`
path-filter mappings. That job's `npm test` includes the suites that invoke
`check-agent-skills`. Do not invent a markdown or frontmatter linter.

## When NOT to run the pipeline

Typo fixes, doc-only PRs, mechanical refactors with no observable delta, and
dependency bumps **skip it** — ship a small PR with a one-line scope note. Most of
the `tests infra` epic (RD-24140) is exactly that shape.

## References

- Command: `.cursor/commands/spec-to-ship.md`
- Agents: `.cursor/agents/{spec-author,test-author,coder,reviewer,verifier}.md`
- Phase skills: `write-spec`, `write-failing-tests`, `code-to-green`,
  `review-changes`, `verify-changes`
- Vocabulary and the 13 Design Rules: `docs/concepts.md`
