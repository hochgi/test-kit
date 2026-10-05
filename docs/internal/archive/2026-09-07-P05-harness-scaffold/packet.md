# P05 harness scaffold — surfaces, model manifest, sync/check machinery

Ticket: RD-24146
Depends on: P00 (RD-24141)

Stand up the four harness directories and the machinery that keeps them in
sync. No new agent, skill, or command bodies — that remains P06 (RD-24147).
A Cursor-only bootstrap already lives on `main` from RD-24147; this packet
wraps it with the three-tool layout and donor sync/check scripts.

Scope: `.harness/models.json` + `models.example.json`, empty/mirrored
`.claude/{agents,commands,skills}/`, `.cursor/rules/`,
`.opencode/{agents,commands}/` + `opencode.json`, and `sync-agent-skills` /
`check-agent-skills` npm scripts taken from donor-bot-repo. Canonical
directions: skills `.cursor` → `.claude`; agents/commands `.claude` →
`.cursor` + `.opencode`.

Out: P06 agent/skill/command/rule prose; `.github/skills` and `.agents/skills`;
git hooks; adding `check-agent-skills` to the five-step `npm run check` chain;
mutation testing / CRAP (RD-24153).
