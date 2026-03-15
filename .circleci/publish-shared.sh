#!/bin/bash

# Shared Publishing Functions
# Used by both publish.sh (CI) and publish-local.sh (local)

# Function: Validate GITHUB_TOKEN
validate_github_token() {
    if [[ -z "$GITHUB_TOKEN" ]]; then
        echo "❌ Error: GITHUB_TOKEN environment variable is not set"
        if [[ -z "$CIRCLECI" ]]; then
            echo "Please set your GitHub Personal Access Token:"
            echo "export GITHUB_TOKEN=your_token_here"
        fi
        exit 1
    fi
}

# Function: Setup npm authentication
setup_npm_auth() {
    echo "🔐 Setting up authentication..."
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" > ~/.npmrc
    echo "@vnatures:registry=https://npm.pkg.github.com" >> ~/.npmrc
    echo "✅ Authentication configured"
}

# Function: Validate and get package info
get_package_info() {
    # Validate package.json
    if [[ ! -f "package.json" ]]; then
        echo "❌ Error: package.json not found"
        exit 1
    fi

    # Get package info for validation
    PACKAGE_NAME=$(node -p "require('./package.json').name" 2>/dev/null || echo "")
    PACKAGE_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")

    if [[ -z "$PACKAGE_NAME" ]] || [[ -z "$PACKAGE_VERSION" ]]; then
        echo "❌ Error: Could not read package name or version from package.json"
        exit 1
    fi

    echo "📦 Package: $PACKAGE_NAME@$PACKAGE_VERSION"

    # Export for use in calling script
    export PACKAGE_NAME PACKAGE_VERSION
}

# Function: Run dry-run validation
run_dry_run() {
    echo "🧪 Running dry-run to verify package..."
    if ! npm publish --dry-run --registry https://npm.pkg.github.com; then
        echo "❌ Dry-run failed! Check package configuration."
        exit 1
    fi
}

# Function: Check if version exists in registry
check_version_exists() {
    echo "🔍 Checking if version already exists..."
    if npm view "$PACKAGE_NAME@$PACKAGE_VERSION" --registry https://npm.pkg.github.com >/dev/null 2>&1; then
        echo "⚠️  Version $PACKAGE_VERSION already exists in registry"
        echo "⚠️  This might cause a conflict, but proceeding anyway..."
    fi
}

# Function: Publish to GitHub Packages
publish_package() {
    echo "📤 Publishing to GitHub Packages..."

    # Determine tag based on version
    local publish_tag="latest"
    if [[ "$PACKAGE_VERSION" == *"-dev"* ]]; then
        publish_tag="latest-dev"
        echo "🔧 Development version detected - using 'latest-dev' tag instead of 'latest'"
    else
        echo "✨ Production version detected - using 'latest' tag"
    fi

    if npm publish --tag "$publish_tag" --registry https://npm.pkg.github.com; then
        echo "✅ Package published successfully!"
        echo ""
        echo "📋 Package details:"
        echo "   Name: $PACKAGE_NAME"
        echo "   Version: $PACKAGE_VERSION"
        echo "   Tag: $publish_tag"
        echo "   Registry: https://npm.pkg.github.com"
        echo "   Repository: https://github.com/vnatures/test-kit/packages"
        return 0
    else
        echo "❌ Publishing failed!"
        return 1
    fi
}
