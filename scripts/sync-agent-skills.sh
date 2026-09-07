#!/usr/bin/env bash
# Sync agent artifacts across every coding tool (Cursor, Claude Code, ...) so
# each dev's IDE works to the same conventions out of the box. Adapted from
# vnatures/vn-server + van-damme-slack-app.
#
# THREE artifact types are kept in sync, each with its own canonical source:
#   * skills   — .cursor/skills  is CANONICAL -> fanned out to .claude/skills
#                (identical SKILL.md; rsync). Honours --source (default cursor).
#   * agents   — .claude/agents  is CANONICAL -> generated .cursor/agents and
#                .opencode/agents (frontmatter translated per tool).
#   * commands — .claude/commands is CANONICAL -> copied to .cursor/commands and
#                rewritten for OpenCode under .opencode/commands.
#
# Generated directories must NEVER be edited by hand. Edit the canonical copy,
# rerun this script, and commit every generated copy.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/agent-sync-lib.sh
. "$ROOT/scripts/agent-sync-lib.sh"
assert_harness_manifest_present

# --- skills: `.cursor/skills` is canonical; it is listed first (default source).
TOOL_KEYS="cursor claude"

tool_dir() {
  case "$1" in
    cursor) echo "$SKILLS_CURSOR_DIR" ;;
    claude) echo "$SKILLS_CLAUDE_DIR" ;;
  esac
}

usage() {
  echo "Usage: $0 [--source=cursor|claude] [-h]"
  echo ""
  echo "Syncs agent artifacts (skills, subagents, commands) across coding tools."
  echo ""
  echo "  skills:   .cursor/skills   (canonical) -> .claude/skills"
  echo "  agents:   .claude/agents   (canonical) -> .cursor/agents + .opencode/agents"
  echo "  commands: .claude/commands (canonical) -> .cursor/commands + .opencode/commands"
  echo ""
  echo "Options:"
  echo "  --source=TOOL   Skills only: use this tool's skills dir as the source."
  echo "                  TOOL must be one of: $TOOL_KEYS (default: cursor)."
  echo "  -h, --help      Show this help message."
}

SOURCE_KEY=""

for arg in "$@"; do
  case "$arg" in
    --source=*)
      SOURCE_KEY="${arg#--source=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -n "$SOURCE_KEY" ]; then
  valid=0
  for key in $TOOL_KEYS; do
    [ "$key" = "$SOURCE_KEY" ] && valid=1
  done
  if [ "$valid" -eq 0 ]; then
    echo "Error: --source must be one of: $TOOL_KEYS" >&2
    exit 1
  fi
fi

# Non-interactive without --source: default to the canonical `.cursor/skills`
# rather than hang or guess a direction.
if [ -z "$SOURCE_KEY" ] && [ ! -t 0 ]; then
  SOURCE_KEY="cursor"
fi

if [ -z "$SOURCE_KEY" ]; then
  echo "Which tool's skills directory is the authoritative source?"
  echo "(\`.cursor/skills\` is canonical for this repo — pick it unless you know better.)"
  echo ""
  i=1
  for key in $TOOL_KEYS; do
    printf "  %d) %-8s (%s)\n" "$i" "$key" "$(tool_dir "$key")"
    i=$((i + 1))
  done
  echo ""
  printf "Enter number: "
  read -r choice

  i=1
  for key in $TOOL_KEYS; do
    if [ "$i" = "$choice" ]; then
      SOURCE_KEY="$key"
      break
    fi
    i=$((i + 1))
  done

  if [ -z "$SOURCE_KEY" ]; then
    echo "Invalid choice: $choice" >&2
    exit 1
  fi
fi

SOURCE_DIR="$(tool_dir "$SOURCE_KEY")"
SOURCE_PATH="$ROOT/$SOURCE_DIR"

# --- preflight ---------------------------------------------------------------
# EVERY precondition is checked before the FIRST write. The skills rsync used to
# run first and `--delete` its target, so a missing agents dir or an unmappable
# agent aborted the run after that mirror had already been replaced — leaving the
# three tool trees at different generations, with nothing in the output saying
# which ones were current.
if [ ! -d "$SOURCE_PATH" ]; then
  echo "Error: skills source directory does not exist: $SOURCE_DIR" >&2
  echo "Create it and add SKILL.md files before syncing." >&2
  exit 1
fi
if [ ! -d "$ROOT/$AGENTS_CLAUDE_DIR" ]; then
  echo "Error: agents source directory does not exist: $AGENTS_CLAUDE_DIR" >&2
  exit 1
fi
if [ ! -d "$ROOT/$COMMANDS_CLAUDE_DIR" ]; then
  echo "Error: commands source directory does not exist: $COMMANDS_CLAUDE_DIR" >&2
  exit 1
fi
assert_no_symlinks "$SOURCE_PATH"
assert_no_symlinks "$ROOT/$AGENTS_CLAUDE_DIR"
assert_no_symlinks "$ROOT/$COMMANDS_CLAUDE_DIR"
harness_validate
assert_opencode_config "$ROOT/.opencode/opencode.json"
# Every agent must map to a manifest entry for all three columns, or generation
# would fail halfway through the second mirror.
for agent_file in "$ROOT/$AGENTS_CLAUDE_DIR"/*.md; do
  [ -e "$agent_file" ] || continue
  agent_name="$(basename "$agent_file" .md)"
  for column in claude cursor opencode; do
    if ! agent_model "$agent_name" "$column" >/dev/null; then
      echo "Error: $AGENTS_CLAUDE_DIR/$agent_name.md has no '$column' entry in ${HARNESS_MANIFEST#$ROOT/}" >&2
      exit 1
    fi
  done
done

# --- skills -----------------------------------------------------------------
echo "== skills =="
echo "Source: $SOURCE_DIR"
for key in $TOOL_KEYS; do
  [ "$key" = "$SOURCE_KEY" ] && continue
  TARGET_DIR="$(tool_dir "$key")"
  mkdir -p "$ROOT/$TARGET_DIR"
  rsync -a --delete --exclude '.DS_Store' "$SOURCE_PATH/" "$ROOT/$TARGET_DIR/"
  echo "  Synced -> $TARGET_DIR"
done

# --- agents -----------------------------------------------------------------
echo "== agents =="
echo "Source: $AGENTS_CLAUDE_DIR"
if has_canonical_md "$ROOT/$AGENTS_CLAUDE_DIR"; then
  generate_cursor_agents "$ROOT/$AGENTS_CURSOR_DIR" "$ROOT/$AGENTS_CLAUDE_DIR"
  echo "  Generated -> $AGENTS_CURSOR_DIR (frontmatter translated to Cursor schema)"
  generate_opencode_agents "$ROOT/$AGENTS_OPENCODE_DIR" "$ROOT/$AGENTS_CLAUDE_DIR"
  echo "  Generated -> $AGENTS_OPENCODE_DIR (frontmatter translated to OpenCode schema)"
else
  echo "  Skipping generation: no *.md in $AGENTS_CLAUDE_DIR (leaving existing Cursor/OpenCode agents in place)"
fi

# --- commands ---------------------------------------------------------------
echo "== commands =="
echo "Source: $COMMANDS_CLAUDE_DIR"
if has_canonical_md "$ROOT/$COMMANDS_CLAUDE_DIR"; then
  generate_cursor_commands "$ROOT/$COMMANDS_CURSOR_DIR" "$ROOT/$COMMANDS_CLAUDE_DIR"
  echo "  Generated -> $COMMANDS_CURSOR_DIR"
  generate_opencode_commands "$ROOT/$COMMANDS_OPENCODE_DIR" "$ROOT/$COMMANDS_CLAUDE_DIR"
  echo "  Generated -> $COMMANDS_OPENCODE_DIR"
else
  echo "  Skipping generation: no *.md in $COMMANDS_CLAUDE_DIR (leaving existing Cursor/OpenCode commands in place)"
fi

echo ""
echo "Done. Review with 'git diff' and commit when ready."
