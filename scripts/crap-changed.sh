#!/usr/bin/env bash
# CRAP on files changed vs merge-base (origin/main, else main).
# Collects istanbul coverage via vitest.mutation.config.ts so keys are
# packages/*/src TypeScript, then scores patch-overlapping functions.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# shellcheck source=changed-src.sh
. "$ROOT/scripts/changed-src.sh"

BASE="$(resolve_patch_base)"
src_list="$(changed_src_files "$BASE")"
FILES=()
while IFS= read -r f; do
  [ -n "$f" ] && FILES+=("$f")
done <<< "$src_list"

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No changed production src files vs ${BASE}; nothing to score."
  exit 0
fi

echo "CRAP on ${#FILES[@]} file(s) changed vs ${BASE}:"
printf '  %s\n' "${FILES[@]}"

rm -f .stryker-package coverage/coverage-final.json

npx vitest run --config vitest.mutation.config.ts \
  --coverage \
  --coverage.provider istanbul \
  --coverage.reporter json \
  --coverage.reporter text

CRAP_FILES="$(printf '%s\n' "${FILES[@]}")"
export CRAP_FILES
export CRAP_PATCH_BASE="$BASE"
export CRAP_LOCAL_COMMAND="npm run crap:changed"
exec node "$ROOT/scripts/crap-report.js"
