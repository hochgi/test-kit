#!/usr/bin/env bash
# Shared helpers for syncing agent artifacts across coding tools.
# Sourced by scripts/sync-agent-skills.sh (writes) and
# scripts/check-agent-skills.sh (regenerates to a temp dir and diffs).
#
# Keeping the generation logic here — in ONE place — guarantees the sync and the
# check produce byte-identical output, so drift detection is meaningful.

# Canonical source directories (per artifact type) and their generated mirrors.
# skills:   .cursor/skills  -> .claude/skills   (identical SKILL.md, rsync)
#           OpenCode is NOT a third copy: `.opencode/opencode.json` sets
#           skills.paths -> ["./.cursor/skills"], so it reads the canonical dir in
#           place. One fewer mirror that can drift.
# agents:   .claude/agents  -> .cursor/agents + .opencode/agents (frontmatter translated)
# commands: .claude/commands-> .cursor/commands (copied) + .opencode/commands (OpenCode-worded)
SKILLS_CURSOR_DIR=".cursor/skills"
SKILLS_CLAUDE_DIR=".claude/skills"
AGENTS_CLAUDE_DIR=".claude/agents"
AGENTS_CURSOR_DIR=".cursor/agents"
AGENTS_OPENCODE_DIR=".opencode/agents"
COMMANDS_CLAUDE_DIR=".claude/commands"
COMMANDS_CURSOR_DIR=".cursor/commands"
COMMANDS_OPENCODE_DIR=".opencode/commands"

# ---------------------------------------------------------------------------
# Model targeting is data, not code. `.harness/models.json` is the ONE place a
# model may be named in this repo; every helper below reads it. The `opencode`
# column holds LiteLLM role aliases (litellm/<role>), repointed centrally when a
# better or cheaper model appears — so following the frontier never touches a repo.
# ---------------------------------------------------------------------------
export HARNESS_MANIFEST="$(git rev-parse --show-toplevel)/.harness/models.json"

# Missing models.json must fail loudly and must NOT auto-copy the example.
# Tests (and clones) look for both relative paths in stderr.
assert_harness_manifest_present() {
  if [ -f "$HARNESS_MANIFEST" ]; then
    return 0
  fi
  echo "Missing .harness/models.json." >&2
  echo "Copy .harness/models.example.json to .harness/models.json, then rerun." >&2
  echo "This script will not create .harness/models.json." >&2
  exit 1
}

# True when <dir> contains at least one *.md. Empty Claude canonical dirs must
# not generate-and-replace Cursor/OpenCode mirrors (that would wipe bootstrap).
has_canonical_md() {
  local dir="$1" f
  [ -d "$dir" ] || return 1
  for f in "$dir"/*.md; do
    [ -e "$f" ] || return 1
    return 0
  done
  return 1
}

# Harness fixtures copy scripts/ into a temp git repo without packages/core.
# The live monorepo working tree always has that package; check-agent-skills
# uses this to fail an empty canonical dir on the live tree while fixtures skip.
is_live_monorepo() {
  local root
  root="$(git rev-parse --show-toplevel)"
  [ -f "$root/packages/core/package.json" ]
}

# harness_field <agent> <field> -> value from the manifest (empty + rc1 if absent).
# Callers may assume the value is well-typed ONLY because harness_validate ran
# first; on its own this still stringifies whatever JSON it finds.
harness_field() {
  node -e '
    const m = require(process.env.HARNESS_MANIFEST);
    const a = m.agents[process.argv[1]];
    if (!a || a[process.argv[2]] === undefined) process.exit(1);
    process.stdout.write(String(a[process.argv[2]]));
  ' "$1" "$2"
}

# Reject a manifest that cannot generate correct mirrors, BEFORE anything is
# written. Two classes of bug this closes:
#
#   * Type coercion. Every value used to reach the generators through
#     `String(...)`, so `"readonly": "no"` produced `readonly: no` in Cursor
#     frontmatter (YAML reads that as false) while OpenCode compared against the
#     exact string "true" and silently emitted a WRITABLE agent — the one field
#     whose whole job is to say an agent may not write.
#   * Unexplained deviation. The manifest promises in prose that a phase pinned
#     off its siblings carries a `rationale`; nothing enforced it, so a stale pin
#     and a deliberate one were indistinguishable and the drift check passed
#     either way. A deviating `claude`/`cursor` tier now REQUIRES
#     `rationale["<agent>.<column>"]`, and a rationale that no longer describes a
#     live deviation is an error too, so the explanations cannot rot in place.
#
# `opencode` is exempt from the deviation rule by design: those are per-phase
# LiteLLM role aliases (`litellm/vn-spec`, `litellm/vn-review`, ...), so every
# phase differing IS the intended shape.
harness_validate() {
  assert_harness_manifest_present
  node -e '
    const m = require(process.env.HARNESS_MANIFEST);
    const errs = [];
    const isStr = (v) => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
    const isText = (v) => typeof v === "string" && v.trim() !== "";
    const isRationale = (v) =>
      isText(v) || (Array.isArray(v) && v.length > 0 && v.every(isText));
    const requiredReadonly = {
      "spec-author": false,
      "test-author": false,
      coder: false,
      reviewer: true,
      verifier: true,
    };
    const requiredPhases = {
      "spec-author": 1,
      "test-author": 2,
      coder: 3,
      reviewer: 4,
      verifier: 5,
    };
    const requiredNames = Object.keys(requiredPhases);

    if (!m.agents || typeof m.agents !== "object" || Array.isArray(m.agents)) {
      errs.push("`agents` must be an object");
    }
    if (!m.orchestrator || !isStr(m.orchestrator.opencode)) {
      errs.push("`orchestrator.opencode` must be a non-empty string without newlines");
    } else if (!m.orchestrator.opencode.startsWith("litellm/vn-")) {
      errs.push(`orchestrator.opencode must be a litellm/vn-<role> alias, got "${m.orchestrator.opencode}"`);
    }
    const rationale = m.rationale ?? {};
    if (typeof rationale !== "object" || Array.isArray(rationale)) {
      errs.push("`rationale` must be an object");
    }

    const entries = Object.entries(m.agents ?? {});
    if (entries.length === 0) errs.push("`agents` is empty");
    for (const name of requiredNames) {
      if (!m.agents || !Object.prototype.hasOwnProperty.call(m.agents, name)) {
        errs.push(`agents.${name} is required`);
      }
    }
    const phases = new Set();
    for (const [name, a] of entries) {
      for (const col of ["claude", "cursor", "opencode"]) {
        if (!isStr(a[col])) errs.push(`agents.${name}.${col} must be a non-empty string without newlines`);
      }
      if (isStr(a.opencode) && !a.opencode.startsWith("litellm/vn-")) {
        errs.push(`agents.${name}.opencode must be a litellm/vn-<role> alias, got "${a.opencode}"`);
      }
      if (typeof a.readonly !== "boolean") {
        errs.push(`agents.${name}.readonly must be a JSON boolean (true/false), got ${JSON.stringify(a.readonly)}`);
      } else if (requiredReadonly[name] !== undefined && a.readonly !== requiredReadonly[name]) {
        errs.push(`agents.${name}.readonly must be ${requiredReadonly[name]}, got ${a.readonly}`);
      }
      const expectedPhase = requiredPhases[name];
      if (expectedPhase === undefined) {
        errs.push(`agents.${name} is not one of ${requiredNames.join(", ")}`);
      }
      if (!Number.isInteger(a.phase) || a.phase < 1 || a.phase > 5) {
        errs.push(`agents.${name}.phase must be an integer 1–5, got ${JSON.stringify(a.phase)}`);
      } else if (expectedPhase !== undefined && a.phase !== expectedPhase) {
        errs.push(`agents.${name}.phase must be ${expectedPhase}, got ${a.phase}`);
      } else if (phases.has(a.phase)) {
        errs.push(`agents.${name}.phase ${a.phase} is already taken by another agent`);
      } else {
        phases.add(a.phase);
      }
    }

    // Deviation vs the column majority; ties resolve to the earliest phase, so
    // the answer never depends on key order in the file.
    const ordered = entries.slice().sort((x, y) => (x[1].phase ?? 99) - (y[1].phase ?? 99));
    const wanted = new Set();
    for (const col of ["claude", "cursor"]) {
      const tally = new Map();
      for (const [, a] of ordered) {
        if (isStr(a[col])) tally.set(a[col], (tally.get(a[col]) ?? 0) + 1);
      }
      let modal = null;
      for (const [value, n] of tally) {
        if (modal === null || n > tally.get(modal)) modal = value;
      }
      for (const [name, a] of ordered) {
        if (!isStr(a[col]) || a[col] === modal) continue;
        const key = `${name}.${col}`;
        wanted.add(key);
        if (!isRationale(rationale[key])) {
          errs.push(
            `agents.${name}.${col} is "${a[col]}" while the other phases use "${modal}". ` +
            `Add rationale["${key}"] explaining why, or the next reader will treat a ` +
            `deliberate pin as a stale one and "fix" it.`);
        }
      }
    }
    for (const key of Object.keys(rationale)) {
      if (!wanted.has(key)) {
        errs.push(`rationale["${key}"] does not describe any current deviation — remove it or restore the pin it explains`);
      }
    }

    if (errs.length) {
      process.stderr.write(`Invalid ${process.env.HARNESS_MANIFEST}:\n`);
      for (const e of errs) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
  '
}

# `.opencode/opencode.json` is hand-written (OpenCode has no generator here), so
# nothing tied its three model fields to the manifest: bumping a manifest alias
# left the OpenCode default/primary/build agents pointing at the old one and the
# drift check passed, because it only ever compared generated dirs. Assert the
# mapping instead. `skills.paths` is checked in the same pass — it is what makes
# OpenCode read `.cursor/skills` in place rather than becoming a third mirror
# that can drift.
assert_opencode_config() {
  local conf="$1"
  [ -f "$conf" ] || { echo "missing OpenCode config: $conf" >&2; return 1; }
  OPENCODE_CONF="$conf" node -e '
    const fs = require("fs");
    const m = require(process.env.HARNESS_MANIFEST);
    const conf = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONF, "utf8"));
    const errs = [];
    const want = (label, got, expected) => {
      if (got !== expected) errs.push(`${label} is ${JSON.stringify(got)}, manifest says ${JSON.stringify(expected)}`);
    };
    const coder = m.agents?.coder?.opencode;
    want("model", conf.model, coder);
    want("agent.build.model", conf.agent?.build?.model, coder);
    want("agent[\"spec-to-ship\"].model", conf.agent?.["spec-to-ship"]?.model, m.orchestrator?.opencode);
    const paths = conf.skills?.paths;
    if (!Array.isArray(paths) || paths.length !== 1 || paths[0] !== "./.cursor/skills") {
      errs.push(`skills.paths must be ["./.cursor/skills"] so OpenCode reads the canonical skills dir in place, got ${JSON.stringify(paths)}`);
    }
    if (errs.length) {
      process.stderr.write(`${process.env.OPENCODE_CONF} disagrees with ${process.env.HARNESS_MANIFEST}:\n`);
      for (const e of errs) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
  '
}

# Recreate a generated mirror from scratch. `rm -f <dir>/*.md` left stale
# subdirectories and non-Markdown files in place, and `check_dir` compares the
# WHOLE directory (`diff -rq`) — so one stray file failed the drift check
# permanently while its own remediation ("rerun sync") could never clear it.
reset_generated_dir() {
  local dir="$1"
  if [ -z "$dir" ] || [ "$dir" = "/" ]; then
    echo "refusing to reset generated directory '$dir'" >&2
    return 1
  fi
  rm -rf "$dir"
  mkdir -p "$dir"
}

# Generate into a staging dir and swap it into place only once every file in the
# mirror has been written. `reset_generated_dir` empties the real target up front,
# so any mid-loop failure — an unreadable source, or a translator's own guard
# firing — used to leave that mirror wiped or half-written while its siblings sat
# at the previous generation. The preflight in sync-agent-skills.sh closes that
# for causes it can see in advance; staging closes it for the ones it cannot,
# including every guard added to a translator later.
# stage_into <out_dir> <emitter> [args...]
#   Runs `<emitter> <staging_dir> [args...]`, then swaps the staging dir into
#   place. The emitter only has to write files and `return 1` on trouble; every
#   generator gets identical staging, cleanup and promotion because there is only
#   one copy of it. The four generators previously repeated this lifecycle inline,
#   which meant ten separate `rm -rf "$staged"; return 1` fragments that a fifth
#   generator could quietly forget — the same "a rule each new thing must follow"
#   shape that let the mirror-clobbering bug through in the first place.
stage_into() {
  local out_dir="$1" emitter="$2" staged
  shift 2
  staged="$out_dir.generating.$$"
  reset_generated_dir "$staged" || return 1
  if ! "$emitter" "$staged" "$@"; then
    rm -rf "$staged"
    return 1
  fi
  rm -rf "$out_dir" && mv "$staged" "$out_dir"
}

# Generated artifacts are built from files this repo can see. A symlinked source
# is refused outright rather than followed: `.claude/agents/x.md -> /etc/passwd`
# would otherwise be read by the awk translators below and its contents copied
# into every mirror, and `rsync -a` would carry the link itself into
# `.claude/skills` for OpenCode to follow at runtime.
assert_regular_source() {
  local f="$1"
  if [ -L "$f" ]; then
    echo "refusing to read symlinked source: $f" >&2
    return 1
  fi
  if [ ! -f "$f" ]; then
    echo "not a regular file: $f" >&2
    return 1
  fi
  return 0
}

# Same rule for a whole tree, for the rsync'd skills dir where there is no
# per-file read to hook into.
assert_no_symlinks() {
  local dir="$1" found
  [ -d "$dir" ] || return 0
  found="$(find "$dir" -type l)"
  if [ -n "$found" ]; then
    echo "refusing to sync: symlinks under $dir" >&2
    printf '%s\n' "$found" | sed 's/^/  /' >&2
    return 1
  fi
  return 0
}

# harness_agents -> newline-separated agent names in phase order.
harness_agents() {
  node -e '
    const m = require(process.env.HARNESS_MANIFEST);
    console.log(Object.entries(m.agents)
      .sort((a, b) => (a[1].phase ?? 99) - (b[1].phase ?? 99))
      .map(([n]) => n).join("\n"));
  '
}

# Model for <agent> on <tool> (claude|cursor|opencode).
agent_model() { harness_field "$1" "$2"; }

# Returns "true"/"false" — whether <agent> is read-only (reviews, does not write).
# No `|| echo false` fallback: a missing or mistyped `readonly` used to coerce to
# "writable", which is the wrong way for that particular field to fail. It is a
# hard error in harness_validate instead.
agent_readonly() { harness_field "$1" readonly; }

# Fail if a canonical .claude/agents/<name>.md pins a model that disagrees with
# the manifest. Without this check a hand-edited tier drifts silently and the
# repo quietly stops following the central mapping — which is exactly how a
# single agent ends up frozen on last quarter'"'"'s model.
assert_claude_models() {
  local src_dir="$1" f base want got rc=0
  for f in "$src_dir"/*.md; do
    [ -e "$f" ] || continue
    assert_regular_source "$f" || { rc=1; continue; }
    base="$(basename "$f" .md)"
    want="$(agent_model "$base" claude)" || {
      echo "drift: $f has no entry in $HARNESS_MANIFEST" >&2; rc=1; continue
    }
    got="$(awk '/^---$/ { n++; next } n == 1 && /^model:/ { sub(/^model:[[:space:]]*/, ""); print; exit }' "$f")"
    if [ "$got" != "$want" ]; then
      echo "drift: $f pins model '$got' but $HARNESS_MANIFEST says '$want'" >&2
      rc=1
    fi
  done
  return $rc
}

# Translate a canonical Claude subagent (.claude/agents/<name>.md) into Cursor's
# subagent schema and print it to stdout. Cursor frontmatter fields:
#   name, description, model (inherit|<id>), readonly (bool), is_background (bool)
# The `tools` field is dropped (not part of Cursor's schema). The model comes from the
# `cursor` column of `.harness/models.json`: each tool runs the models it ships with, so
# Claude Code takes the `claude` column and Cursor takes the `cursor` column. Neither is
# derived from the other — the Claude tier is deliberately NOT translated —
# keying off it would silently retarget Cursor whenever a Claude tier changed, and the
# two choices answer to different vendors. `inherit` is no longer emitted: it would
# hand the phase whatever model the user happens to be driving Cursor with, which is
# the one thing a pipeline with per-phase model intent should not do.
# is_background -> false (agents participate in the gated pipeline).
# The body after the frontmatter is emitted byte-for-byte unchanged.
translate_agent() {
  local src="$1" readonly="$2" model="$3"
  awk -v readonly="$readonly" -v model="$model" '
    BEGIN { fm = 0 }
    NR == 1 && $0 == "---" { fm = 1; print "---"; next }
    fm == 1 && $0 == "---" {
      print "name: " name
      print "description: " desc
      print "model: " model
      print "readonly: " readonly
      print "is_background: false"
      print "---"
      fm = 0
      next
    }
    fm == 1 {
      if ($0 ~ /^name:/)        { name = substr($0, index($0, ":") + 2); next }
      if ($0 ~ /^description:/) { desc = substr($0, index($0, ":") + 2); next }
      next  # drop tools, the Claude model tier, and any other frontmatter key
    }
    { print }
  ' "$src"
}

# Generate the Cursor agents mirror at $1 from the canonical Claude agents dir.
# Deletes any stale files first so the mirror matches the source exactly.
generate_cursor_agents() {
  stage_into "$1" emit_cursor_agents "$2"
}

emit_cursor_agents() {
  local out_dir="$1" src_dir="$2" f base ro model
  for f in "$src_dir"/*.md; do
    [ -e "$f" ] || continue
    assert_regular_source "$f" || return 1
    base="$(basename "$f" .md)"
    ro="$(agent_readonly "$base")" || return 1
    model="$(agent_model "$base" cursor)" || return 1
    translate_agent "$f" "$ro" "$model" > "$out_dir/$base.md" || return 1
  done
}

# Translate a canonical Claude command into Cursor wording. Frontmatter is
# already description + argument-hint, which Cursor accepts, so only the body
# changes:
#   * "via the **Agent** tool" is Claude-specific naming — Cursor launches
#     subagents directly, so the phrase is dropped rather than mistranslated.
#   * Cursor does not always surface repo-local custom agents in the launcher.
#     The generalPurpose fallback is appended to the model-selection paragraph so
#     a phase still runs with the right instructions when the named agent is
#     missing. Copying the Claude file verbatim silently loses this.
#
# The fallback is appended to the END of the `**Model selection.**` paragraph,
# located structurally. Two earlier versions keyed off a model literal instead —
# first a hardcoded `cursor-grok-4.6-xhigh`, then the manifest's `spec-author`
# tier — and both were wrong for the same underlying reason: the command should
# not be naming a model in the first place. `.harness/models.json` says nothing
# else in this repo may, and a single tier quoted in shared prose also misstates
# every phase whose own column differs. So the command now defers to frontmatter,
# there is no literal left to drift, and this translation just has to find the
# paragraph. The END guard keeps a reworded paragraph loud rather than silent.
translate_cursor_command() {
  local src="$1"
  awk '
    /^\*\*Model selection\.\*\*/ { in_para = 1; has_para = 1 }
    in_para && /^$/ {
      print "Prefer the named agent if the tool lists it; otherwise `generalPurpose`"
      print "instructed to follow `.cursor/agents/<name>.md` and the phase skill."
      print ""
      in_para = 0
      hit = 1
      next
    }
    {
      gsub(/ via the \*\*Agent\*\* tool/, "")
      print
    }
    END {
      if (has_para && !hit) {
        print "translate_cursor_command: found a **Model selection.** paragraph but no end to it," > "/dev/stderr"
        print "  so the generalPurpose fallback would be dropped silently." > "/dev/stderr"
        exit 3
      }
    }
  ' "$src"
}

# Generate the Cursor commands mirror at $1 from the canonical Claude commands dir.
generate_cursor_commands() {
  stage_into "$1" emit_cursor_commands "$2"
}

emit_cursor_commands() {
  local out_dir="$1" src_dir="$2" f base
  for f in "$src_dir"/*.md; do
    [ -e "$f" ] || continue
    assert_regular_source "$f" || return 1
    base="$(basename "$f")"
    translate_cursor_command "$f" > "$out_dir/$base" || return 1
  done
}

# Translate a canonical Claude subagent into OpenCode's agent markdown schema.
# OpenCode frontmatter: description, mode, model, optional permission.
# Body after frontmatter is emitted unchanged. Claude tools/model are dropped.
translate_opencode_agent() {
  local src="$1" base="$2" model="$3" readonly="$4"
  awk -v model="$model" -v readonly="$readonly" '
    BEGIN { fm = 0 }
    NR == 1 && $0 == "---" { fm = 1; print "---"; next }
    fm == 1 && $0 == "---" {
      print "description: " desc
      print "mode: subagent"
      print "model: " model
      if (readonly == "true") {
        print "permission:"
        print "  edit: deny"
      }
      print "---"
      fm = 0
      next
    }
    fm == 1 {
      if ($0 ~ /^description:/) { desc = substr($0, index($0, ":") + 2); next }
      next
    }
    { print }
  ' "$src"
}

# Generate the OpenCode agents mirror at $1 from the canonical Claude agents dir.
generate_opencode_agents() {
  stage_into "$1" emit_opencode_agents "$2"
}

emit_opencode_agents() {
  local out_dir="$1" src_dir="$2" f base ro model
  for f in "$src_dir"/*.md; do
    [ -e "$f" ] || continue
    assert_regular_source "$f" || return 1
    base="$(basename "$f" .md)"
    ro="$(agent_readonly "$base")" || return 1
    model="$(agent_model "$base" opencode)" || return 1
    translate_opencode_agent "$f" "$base" "$model" "$ro" > "$out_dir/$base.md" || return 1
  done
}

# Live LiteLLM role aliases from the manifest, backtick-quoted, comma-separated,
# in phase order. The OpenCode command rewrite interpolates this list so a
# drifted agents.*.opencode fails check-agent-skills instead of matching a
# hardcoded alias set.
opencode_role_alias_markup() {
  local name alias out=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    alias="$(agent_model "$name" opencode)" || return 1
    if [ -n "$out" ]; then
      out="$out, "
    fi
    out="$out\`$alias\`"
  done < <(harness_agents)
  printf '%s' "$out"
}

# Translate a Claude/Cursor command into OpenCode wording (Task tool, model map).
# Frontmatter drops argument-hint (OpenCode uses $ARGUMENTS in the body only).
translate_opencode_command() {
  local src="$1"
  local aliases
  aliases="$(opencode_role_alias_markup)" || return 1
  OPENCODE_ROLE_ALIASES="$aliases" awk '
    BEGIN {
      fm = 0
      aliases = ENVIRON["OPENCODE_ROLE_ALIASES"]
    }
    NR == 1 && $0 == "---" { fm = 1; print "---"; next }
    fm == 1 && $0 == "---" {
      print "description: " desc
      print "agent: spec-to-ship"
      print "---"
      fm = 0
      next
    }
    fm == 1 {
      if ($0 ~ /^description:/) { desc = substr($0, index($0, ":") + 2); next }
      next
    }
    {
      gsub(/\*\*Agent\*\* tool/, "**task** tool")
      gsub(/via the \*\*Agent\*\* tool/, "via the **task** tool")
      gsub(/via the Agent tool/, "via the task tool")
      gsub(/Agent\/Task/, "task")
      gsub(/AskUserQuestion/, "question")
      # Model-selection paragraph is Cursor/Claude-specific — rewrite when we hit it.
      if ($0 ~ /^\*\*Model selection\.\*\*/) {
        print "**Model selection.** When launching a subagent via task, **omit any"
        print "`model` override** unless the human explicitly asked for a specific"
        print "listed model. Agent frontmatter is authoritative, and on OpenCode every"
        print "phase targets a LiteLLM **role alias** (" aliases ") rather than a vendor"
        print "model id. The alias is repointed centrally in LiteLLM, so the best"
        print "capability-per-dollar model for each phase arrives without a repo change."
        skip_model_para = 1
        next
      }
      if (skip_model_para) {
        if ($0 ~ /^## /) { skip_model_para = 0; print; next }
        if ($0 ~ /^$/) { skip_model_para = 0; print; next }
        next
      }
      print
    }
  ' "$src"
}

# Generate OpenCode commands at $1 from canonical Claude commands at $2.
generate_opencode_commands() {
  stage_into "$1" emit_opencode_commands "$2"
}

emit_opencode_commands() {
  local out_dir="$1" src_dir="$2" f base
  for f in "$src_dir"/*.md; do
    [ -e "$f" ] || continue
    assert_regular_source "$f" || return 1
    base="$(basename "$f")"
    translate_opencode_command "$f" > "$out_dir/$base" || return 1
  done
}
