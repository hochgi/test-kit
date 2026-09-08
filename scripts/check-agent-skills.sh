#!/usr/bin/env bash
# Read-only drift check for every synced agent artifact. Invoked by
# `npm run check-agent-skills` (and by this packet's tests inside `npm test`).
# Not a git hook — this repo has none — and not part of the five-step
# `npm run check` chain. Never modifies tracked files.
#
# Checks artifact types against their canonical source:
#   * skills   — .claude/skills must equal canonical .cursor/skills
#   * agents   — .cursor/agents and .opencode/agents must equal what translating
#                .claude/agents yields
#   * commands — .cursor/commands must equal canonical .claude/commands;
#                .opencode/commands must equal the OpenCode rewrite
#
# For agents/commands the generation is regenerated into a temp dir and diffed,
# so the check uses the SAME logic as the sync (shared lib) and exits non-zero
# on any drift.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/agent-sync-lib.sh
. "$ROOT/scripts/agent-sync-lib.sh"
assert_harness_manifest_present

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

DRIFT=""

# The manifest is the input to every generator below, so validate it before
# trusting a single comparison: an unexplained tier deviation or a non-boolean
# `readonly` produces mirrors that agree with each other and with nothing else.
if ! harness_validate; then
  DRIFT="$DRIFT\n  [models] ${HARNESS_MANIFEST#$ROOT/} is invalid (see above)"
fi
# `.opencode/opencode.json` is hand-written, so drift there is invisible to a
# generated-dir diff.
if ! assert_opencode_config "$ROOT/.opencode/opencode.json"; then
  DRIFT="$DRIFT\n  [opencode-config] .opencode/opencode.json disagrees with ${HARNESS_MANIFEST#$ROOT/}"
fi

# diff two dirs, recording drift with a label. Missing target => drift.
check_dir() {
  local label="$1" reference="$2" target="$3"
  if [ ! -d "$target" ]; then
    DRIFT="$DRIFT\n  [$label] missing directory: ${target#$ROOT/}"
    return
  fi
  if ! diff -rq --exclude='.DS_Store' "$reference" "$target" > /dev/null 2>&1; then
    DRIFT="$DRIFT\n  [$label] ${reference#$ROOT/}  vs  ${target#$ROOT/}"
  fi
}

# Generate-and-diff when canonical *.md exist. Empty dirs are fixture-safe;
# on the live monorepo they are drift (the skip used to hide a hollow tree).
canonical_md_ready() {
  local dir="$1" label="$2"
  if has_canonical_md "$dir"; then
    return 0
  fi
  if is_live_monorepo; then
    DRIFT="$DRIFT\n  [$label] live working tree has no *.md under ${dir#$ROOT/}"
  fi
  return 1
}

# --- skills: canonical .cursor/skills vs generated .claude/skills -----------
if [ ! -d "$ROOT/$SKILLS_CURSOR_DIR" ]; then
  echo "Error: canonical skills directory missing: $SKILLS_CURSOR_DIR" >&2
  echo "Run 'npm run sync-agent-skills'." >&2
  exit 1
fi
if ! assert_no_symlinks "$ROOT/$SKILLS_CURSOR_DIR"; then
  DRIFT="$DRIFT\n  [skills] symlinks under $SKILLS_CURSOR_DIR (see above)"
fi
check_dir "skills" "$ROOT/$SKILLS_CURSOR_DIR" "$ROOT/$SKILLS_CLAUDE_DIR"

# --- agents: regenerate to temp, compare against .cursor/agents -------------
if [ ! -d "$ROOT/$AGENTS_CLAUDE_DIR" ]; then
  echo "Error: canonical agents directory missing: $AGENTS_CLAUDE_DIR" >&2
  exit 1
fi
if ! assert_no_symlinks "$ROOT/$AGENTS_CLAUDE_DIR"; then
  DRIFT="$DRIFT\n  [agents] symlinks under $AGENTS_CLAUDE_DIR (see above)"
fi
# Empty Claude canonical dirs must not fail the check solely because Cursor
# bootstrap files exist — except on the live monorepo, where empty is drift.
if canonical_md_ready "$ROOT/$AGENTS_CLAUDE_DIR" "agents"; then
  # Canonical Claude frontmatter must agree with the model manifest. This is the
  # check that catches a single agent hand-pinned to a stale vendor tier while its
  # siblings still follow the central mapping.
  if ! assert_claude_models "$ROOT/$AGENTS_CLAUDE_DIR"; then
    DRIFT="$DRIFT\n  [agents-claude] frontmatter disagrees with ${HARNESS_MANIFEST#$ROOT/}"
  fi
  generate_cursor_agents "$TMP_DIR/agents-cursor" "$ROOT/$AGENTS_CLAUDE_DIR"
  check_dir "agents-cursor" "$TMP_DIR/agents-cursor" "$ROOT/$AGENTS_CURSOR_DIR"
  generate_opencode_agents "$TMP_DIR/agents-opencode" "$ROOT/$AGENTS_CLAUDE_DIR"
  check_dir "agents-opencode" "$TMP_DIR/agents-opencode" "$ROOT/$AGENTS_OPENCODE_DIR"
fi

# --- commands: regenerate to temp, compare against tool mirrors -------------
if [ ! -d "$ROOT/$COMMANDS_CLAUDE_DIR" ]; then
  echo "Error: canonical commands directory missing: $COMMANDS_CLAUDE_DIR" >&2
  exit 1
fi
if ! assert_no_symlinks "$ROOT/$COMMANDS_CLAUDE_DIR"; then
  DRIFT="$DRIFT\n  [commands] symlinks under $COMMANDS_CLAUDE_DIR (see above)"
fi
if canonical_md_ready "$ROOT/$COMMANDS_CLAUDE_DIR" "commands"; then
  generate_cursor_commands "$TMP_DIR/commands-cursor" "$ROOT/$COMMANDS_CLAUDE_DIR"
  check_dir "commands-cursor" "$TMP_DIR/commands-cursor" "$ROOT/$COMMANDS_CURSOR_DIR"
  generate_opencode_commands "$TMP_DIR/commands-opencode" "$ROOT/$COMMANDS_CLAUDE_DIR"
  check_dir "commands-opencode" "$TMP_DIR/commands-opencode" "$ROOT/$COMMANDS_OPENCODE_DIR"
fi

if [ -n "$DRIFT" ]; then
  echo "Error: agent artifacts are out of sync:"
  printf "%b\n" "$DRIFT"
  echo ""
  echo "Fix: edit the CANONICAL copy, run 'npm run sync-agent-skills', and commit."
  echo "  skills   canonical: .cursor/skills"
  echo "  agents   canonical: .claude/agents  (generates .cursor/agents + .opencode/agents)"
  echo "  commands canonical: .claude/commands (generates .cursor/commands + .opencode/commands)"
  echo "  models   canonical: .harness/models.json (the only place a model may be named)"
  exit 1
fi

echo "Agent artifacts (skills, subagents, commands) are in sync across all tools."
