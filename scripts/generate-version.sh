#!/bin/bash

# Generate timestamp-based version for Academia Electron App
# Format: YYYYMMDDHHMMSS[-beta]
# Example: 20250106143022 (stable) or 20250106143022-beta (beta)

set -e

# Generate timestamp in UTC
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)

# Determine channel (default to stable if not set)
# Only supports: stable, beta
CHANNEL="${CHANNEL:-stable}"

# Validate channel
if [ "$CHANNEL" != "stable" ] && [ "$CHANNEL" != "beta" ]; then
  echo "Error: Invalid channel '$CHANNEL'. Only 'stable' and 'beta' are supported."
  exit 1
fi

# Create version string
if [ "$CHANNEL" = "stable" ]; then
  VERSION="$TIMESTAMP"
else
  VERSION="$TIMESTAMP-beta"
fi

# Update package.json with new version (without creating git tag)
npm version "$VERSION" --no-git-tag-version --allow-same-version

echo "Version set to: $VERSION"
echo "Channel: $CHANNEL"
echo "VERSION=$VERSION" >> "$GITHUB_OUTPUT" 2>/dev/null || true
