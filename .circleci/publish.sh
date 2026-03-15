#!/bin/bash -e

echo "📤 Publishing @vnatures/test-kit to GitHub Packages"
cd "$(dirname "$0")/../packages/core"
source "$(dirname "$0")/publish-shared.sh"
if [[ -z "$CIRCLECI" ]]; then
    echo "❌ Error: CI-only script. Use npm run publish:local for local publishing."
    exit 1
fi
validate_github_token
setup_npm_auth
get_package_info
if [[ ! -d "dist" ]]; then
    echo "❌ Error: dist directory not found"
    exit 1
fi
run_dry_run
check_version_exists
publish_package
