#!/bin/bash -e

# Version Bump Script for Test Kit (packages/core)
# Usage: ./version-bump.sh [BRANCH_NAME] [NO_COMMIT_AUTOBUMP]
# Similar in scope to ops update-version.sh - handles both version bump AND git commit

# Ensure we're in packages/core (the published package)
cd "$(dirname "$0")/../packages/core"

BRANCH_NAME=${1:-${CIRCLE_BRANCH:-$(git branch --show-current)}}
NO_COMMIT_AUTOBUMP=${2:-${NO_COMMIT_AUTOBUMP:-"false"}}

echo "📝 Managing version for branch: $BRANCH_NAME"

# Validate package.json exists and is readable
if [[ ! -f "package.json" ]]; then
    echo "❌ Error: package.json not found"
    exit 1
fi

# Get current version from package.json with error handling
if ! CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null); then
    echo "❌ Error: Could not read version from package.json"
    exit 1
fi

echo "Current version: $CURRENT_VERSION"

# Validate current version format
if [[ ! $CURRENT_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$ ]]; then
    echo "❌ Error: Invalid version format in package.json: $CURRENT_VERSION"
    exit 1
fi

# Check if semver is available
if ! command -v npx >/dev/null 2>&1; then
    echo "❌ Error: npx not found"
    exit 1
fi

# Determine new version based on branch
if [[ "$BRANCH_NAME" == "main" ]]; then
    # Main branch: use clean version (remove any -dev suffix)
    CLEAN_VERSION=$(echo $CURRENT_VERSION | sed 's/-dev.*//')

    # Use semver with error handling
    if ! NEW_VERSION=$(npx semver $CLEAN_VERSION -i patch 2>/dev/null); then
        echo "❌ Error: Failed to increment version using semver"
        exit 1
    fi
    echo "✅ Main branch - New version: $NEW_VERSION"
else
    # Feature branch: add -dev suffix with more precise timestamp
    BASE_VERSION=$(echo $CURRENT_VERSION | sed 's/-dev.*//')
    TIMESTAMP=$(date +%Y%m%d%H%M%S)  # Include seconds to avoid collisions
    NEW_VERSION="${BASE_VERSION}-dev.${TIMESTAMP}"
    echo "🔧 Feature branch - New version: $NEW_VERSION"
fi

# Update package.json version with error handling
if ! npm version --no-git-tag-version $NEW_VERSION >/dev/null 2>&1; then
    echo "❌ Error: Failed to update package.json version"
    exit 1
fi

echo "Updated package.json to version: $NEW_VERSION"

# Update package-lock.json (monorepo: lock file is at root)
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
npm install --package-lock-only

# Git commit logic (similar to ops update-version.sh)
# Only commit on main branch if NO_COMMIT_AUTOBUMP is false
if [[ "$BRANCH_NAME" == "main" ]]; then
    if [[ "$NO_COMMIT_AUTOBUMP" == "false" ]]; then
        if [[ -n "$GITHUB_WRITE_KEY" ]]; then
            echo "🤖 Committing version bump using SSH..."

            # Check if working directory is clean (except for our changes)
            if git diff --quiet packages/core/package.json package-lock.json 2>/dev/null; then
                echo "⚠️  No version changes to commit"
            else
                # Setup SSH authentication (like ops does)
                LOCATION="$PROJECT_ROOT"
                echo $GITHUB_WRITE_KEY | base64 -d > $LOCATION/ops_write_rsa
                chmod 400 $LOCATION/ops_write_rsa
                ssh-add -D
                ssh-add $LOCATION/ops_write_rsa
                echo "✅ SSH key configured for git operations"

                # Configure git user
                git config --global user.email "ci@circleci.com"
                git config --global user.name "CircleCI Bot"

                # Force SSH for this repository only (not global)
                git config url."git@github.com:".insteadOf "https://github.com/"

                # Git pull before making changes (like ops does)
                git stash push . 2>/dev/null || true
                GIT_SSH_COMMAND="ssh -i $LOCATION/ops_write_rsa" git pull origin "$BRANCH_NAME" || true
                git stash pop 2>/dev/null || true

                # Add version files (monorepo: packages/core + root lock file)
                git add packages/core/package.json package-lock.json

                # Try to commit and push with SSH
                if git commit -m "chore: bump version to v$NEW_VERSION [skip ci]"; then
                    if GIT_SSH_COMMAND="ssh -i $LOCATION/ops_write_rsa" git push origin "$BRANCH_NAME"; then
                        echo "✅ Committed version bump to $BRANCH_NAME"
                    else
                        echo "⚠️  Failed to push version bump - continuing anyway"
                    fi
                else
                    echo "⚠️  Failed to commit version bump - continuing anyway"
                fi

                # Cleanup SSH key
                rm -f $LOCATION/ops_write_rsa
            fi
        else
            echo "⚠️  GITHUB_WRITE_KEY not available - skipping auto-commit"
        fi
    else
        echo "🚫 Auto-commit disabled (NO_COMMIT_AUTOBUMP=true)"
    fi
else
    echo "🔧 Feature branch - skipping auto-commit"
fi

# Also output to stdout for direct script usage
echo "$NEW_VERSION"
