---
name: pr-review-style
description: >-
  Tone, scope, and discipline for reviewing pull requests in this library
  repository: not strict, never block a human, avoid noise comments, escalate
  out-of-scope concerns to a follow-up instead of silently expanding the PR.
  Use when reviewing a PR, writing review comments, or triaging bot reviewers.
---

# PR review style

This is a single library repository (`@vnatures/test-kit` and its workspace
packages). Remote is **`vn`**. Prefix every GitHub-facing comment with `🤖: `.

## Defaults

- **You are not strict, and you never require changes on a PR to block a human.**
  A blocking-style "changes requested" review is reserved for human reviewers;
  your default is a comment-style review with concrete suggestions.
- **Avoid noise comments.** When in doubt, reach out to a human for context
  before commenting. "Have you considered X" comments where X is obvious or
  already discussed are noise.
- **Don't silently expand scope.** When something looks out of scope, ask the
  owner whether they prefer a fix in the current PR or a follow-up task — don't
  quietly slip it in.

## Assembling the review panel (when you OPEN a PR)

Don't wait for reviewers to find the PR on their own. Other agents — running on
different models with different system prompts — catch what a single agent is
blind to. When you open a PR, gather the panel:

- **Copilot** — add `copilot` as a reviewer on the PR.
- **Bugbot (Cursor)** — comment `@cursor review` on the PR.

Then triage every comment that lands (below).

## Replying to bot reviewers

When a bot reviewer leaves comments:

- **Each finding is either actionable or noise.** Triage explicitly: apply the
  fix in a new commit, OR push back with a concrete reason to reject.
- **Never leave a comment silently unresolved.** If a finding is a nitpick, a
  misread, or out of scope, reply to the review comment with your pushback
  reasoning — a short, concrete reason. A dismissed-with-reason comment is
  resolved; an ignored one is a loose thread.
- **Don't drown the thread.** One reply per finding, brief: `🤖: 👍 fixed in <sha>`
  plus a one-line summary. If multiple bots flagged the same finding, link sibling
  threads instead of repeating the explanation.
- **Bot consensus matters.** When multiple bots flag the same thing, it's almost
  certainly worth fixing. When only one flags it, weigh on technical merit.
- **Wait for the bot's re-run** to confirm the fix landed before declaring
  victory.

## Quality bar for review comments you DO leave

A good review comment includes:

1. The concrete observation ("this `as unknown as` cast is broader than needed…").
2. The reason it matters ("…because it hides type errors that would surface here").
3. A specific suggestion ("…consider casting only the function shape: `as (args: Args) => Promise<Response>`").

(1) and (3) without (2) feels prescriptive. (2) without (3) feels handwavy. All
three together is a good comment.

GitHub-facing text starts with `🤖: `.

## Anti-patterns

- **Style nits when behaviour is the point of the PR.** Trim them.
- **"This file is getting long" without a concrete extraction proposal.** Surface
  the hotspot in a separate task; don't make the PR a refactor.
- **"Did you consider X" rhetorical questions.** Either propose X as a concrete
  change, or skip the comment.
- **Approving with a wall of conditional concerns.** If the conditions matter,
  they belong in `request changes`. If they don't, they belong in a follow-up.

For the substance of what to review (correctness, public-API consistency, spec
conformance), see the `review-changes` skill.
