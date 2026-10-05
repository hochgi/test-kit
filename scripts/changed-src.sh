#!/usr/bin/env bash
# Resolve merge-base with origin/main (fallback: main).
# Sourced by mutation-incremental.sh and crap-changed.sh — do not `set -e` here.
resolve_patch_base() {
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    git merge-base origin/main HEAD
  elif git rev-parse --verify --quiet main >/dev/null; then
    git merge-base main HEAD
  else
    echo "Could not find origin/main or main to diff against." >&2
    return 1
  fi
}

# Production .ts/.tsx under packages/*/src. Includes committed, staged,
# unstaged, and untracked files vs the given merge-base.
changed_src_files() {
  local base="$1"
  local committed others files f
  committed="$(git diff --name-only --diff-filter=ACMR "$base" -- packages)" || return $?
  others="$(git ls-files --others --exclude-standard -- packages)" || return $?
  # grep exits 1 when nothing matches; that is an empty result, not a git failure.
  files="$(
    printf '%s\n%s\n' "$committed" "$others" | sort -u \
      | grep -E '^packages/[^/]+/src/' \
      | grep -E '\.tsx?$' \
      | grep -v '\.d\.ts$' \
      | grep -v '/test/' \
      | grep -E -v '\.(test|spec)\.tsx?$' || true
  )"
  printf '%s\n' "$files" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    printf '%s\n' "$f"
  done
}
