# Versatile-internal harness pieces

This repository's published packages are OSS. These harness pieces are
**versatile-internal** — they assume vnatures seats, gateways, and review
bots. OSS adopters can ignore them.

- `summon-review-panel` (`.cursor/skills/summon-review-panel/`) and
  `.harness/review-panel.json` — committed review-panel policy for this
  org. Capability is live and is not committed.
- LiteLLM role aliases in `.harness/models.json` (`litellm/vn-`) — the
  OpenCode column and orchestrator aliases on the internal gateway.

This file is the inventory. Do not add a skill-frontmatter marking
convention (`oss:` / `versatile-internal` keys on skills).
