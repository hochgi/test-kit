#!/usr/bin/env bash
# Incremental Stryker: mutate each published package whose packages/<name>/src
# files changed vs merge-base (vn/main, else main). Skip packages with no tests.
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
  echo "No changed production src files vs ${BASE}; nothing to mutate."
  exit 0
fi

package_has_tests() {
  local name="$1"
  local hit rc
  [ -d "packages/${name}/test" ] || return 1
  hit="$(find "packages/${name}/test" -name '*.test.ts' -print -quit)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "find failed (${rc}) looking for tests in packages/${name}/test" >&2
    exit 1
  fi
  [ -n "$hit" ]
}

names=""
for f in "${FILES[@]}"; do
  if [[ "$f" =~ ^packages/([^/]+)/src/ ]]; then
    name="${BASH_REMATCH[1]}"
    case " ${names} " in
      *" ${name} "*) ;;
      *) names="${names} ${name}" ;;
    esac
  fi
done

ran=0
for name in $names; do
  if ! package_has_tests "$name"; then
    echo "Skipping ${name}: no packages/${name}/test/**/*.test.ts files."
    continue
  fi
  echo "Mutating package ${name} (src changed vs ${BASE})"
  bash "$ROOT/scripts/mutation-package.sh" "$name"
  ran=$((ran + 1))
done

if [ "$ran" -eq 0 ]; then
  echo "No touched published package had tests; nothing to mutate."
fi
