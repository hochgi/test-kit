#!/usr/bin/env bash
# Per-package Stryker runner. Writes .stryker-package so the sandbox copy of
# vitest.mutation.config.ts can scope tests. Env STRYKER_PACKAGE is not
# reliably visible inside the Vite-bundled mutation config.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ "${1:-}" = "" ]; then
  echo "usage: $0 <package-dir-name>" >&2
  exit 1
fi

pkg="$1"
printf '%s\n' "$pkg" > "$ROOT/.stryker-package"

if [ ! -d "packages/${pkg}/src" ]; then
  echo "No packages/${pkg}/src/**/*.ts(x) files to mutate (zero-mutant success is a failure)." >&2
  exit 1
fi
src_count="$(find "packages/${pkg}/src" \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.d.ts' | wc -l | tr -d ' ')"
if [ "$src_count" = "0" ]; then
  echo "No packages/${pkg}/src/**/*.ts(x) files to mutate (zero-mutant success is a failure)." >&2
  exit 1
fi

concurrency=4
if [ "$pkg" = mysql ]; then
  concurrency=1
fi

stryker_bin="$ROOT/node_modules/.bin/stryker"
if [ ! -x "$stryker_bin" ]; then
  echo "stryker is not installed at ${stryker_bin}" >&2
  exit 1
fi

rm -rf reports/mutation
mkdir -p reports/mutation

# One --mutate only. Stryker's CLI parses --mutate with a comma splitter and
# commander keeps only the LAST occurrence, so repeating the flag silently
# discards every earlier glob; three flags left a bare negation that matched
# nothing and instrumented zero mutants (RD-24255).
"$stryker_bin" run \
  --concurrency "$concurrency" \
  --mutate "packages/${pkg}/src/**/*.ts,packages/${pkg}/src/**/*.tsx,!packages/${pkg}/src/**/*.d.ts"

report="$ROOT/reports/mutation/mutation.json"
if [ ! -f "$report" ]; then
  echo "Stryker JSON report missing at ${report}" >&2
  exit 1
fi

node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const files = report && typeof report === "object" ? report.files : undefined;
let total = 0;
if (files && typeof files === "object") {
  for (const file of Object.values(files)) {
    if (file && typeof file === "object" && Array.isArray(file.mutants)) {
      total += file.mutants.length;
    }
  }
}
if (total === 0) {
  console.error("Stryker instrumented 0 mutants; treating as failure.");
  process.exit(1);
}
' "$report"
