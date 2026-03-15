#!/bin/bash -e

# Function: Determine if version bump and publish are needed
# Sets global variables: SHOULD_PUBLISH, SHOULD_VERSION_BUMP
determine_publish_strategy() {
    local branch_name="$1"
    local commit_msg="$2"

    # Initialize flags
    SHOULD_PUBLISH=false
    SHOULD_VERSION_BUMP=false

    if [[ "$branch_name" == "main" ]]; then
        echo "📋 Main branch detected - will version bump and publish to GitHub Packages"
        SHOULD_PUBLISH=true
        SHOULD_VERSION_BUMP=true
    elif [[ "$commit_msg" == *"[publish]"* ]]; then
        echo "📋 [publish] detected in commit message - will version bump and publish to GitHub Packages"
        SHOULD_PUBLISH=true
        SHOULD_VERSION_BUMP=true
    else
        echo "📋 Feature branch without [publish] - skipping version bump and publish"
        SHOULD_PUBLISH=false
        SHOULD_VERSION_BUMP=false
    fi
}

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git show -s --format=%B $COMMIT_HASH)

echo "Running CI workflow for test-kit"
cd ..
LOCATION=$(pwd)

echo $OPS_REPO_READ_KEY | base64 -d > $LOCATION/ops_rsa
chmod 400 $LOCATION/ops_rsa
ssh-add -D
ssh-add $LOCATION/ops_rsa
git clone --depth=1 git@github.com:vnatures/ops.git

# Configure for test-kit (monorepo - packages/core is published)
export PUBLISHER_SERVICE_NAME="test-kit"
export IS_SCRIPT="true"
export PUBLISHER_SCRIPT_NAME="test-kit"
export FORCE_TARGET_DIR="/home/circleci/project/"
export CI_STEPS="install-utils install"

echo "CI_STEPS configured: $CI_STEPS"
echo "Target directory: $FORCE_TARGET_DIR"
echo "Publisher script name: $PUBLISHER_SCRIPT_NAME"

# Run the ops CI pipeline for install utilities and dependencies
cd ./ops/scripts/publisher-ci-pipeline/ && ./ci.sh "$COMMIT_MSG"

# Back to our project directory for build->test->version management->publishing
cd $FORCE_TARGET_DIR

echo "🔨 Building project..."
npm run build

echo "🧪 Running tests..."
npm test

BRANCH_NAME=${CIRCLE_BRANCH:-$(git branch --show-current)}

# Determine strategy using function
determine_publish_strategy "$BRANCH_NAME" "$COMMIT_MSG"

# version management logic
if [[ "$SHOULD_VERSION_BUMP" == "true" ]]; then
    echo "📝 Running version management for GitHub package..."

    if [[ "$BRANCH_NAME" == "main" ]]; then
        NO_COMMIT_AUTOBUMP="false"
    else
        NO_COMMIT_AUTOBUMP="true"
    fi

    NEW_VERSION=$(./.circleci/version-bump.sh "$BRANCH_NAME" "$NO_COMMIT_AUTOBUMP")
    echo "📦 Package version: $NEW_VERSION"
else
    NEW_VERSION=$(node -p "require('./packages/core/package.json').version" 2>/dev/null || echo "unknown")
    echo "📦 Current package version: $NEW_VERSION (no bump needed)"
fi

# Publish to GitHub Packages if needed
if [[ "$SHOULD_PUBLISH" == "true" ]]; then
    echo "📤 Publishing to GitHub Packages..."
    ./.circleci/publish.sh
else
    echo "⏭️  Skipping GitHub Packages publish step"
fi

echo "🎉 CI completed successfully!"
