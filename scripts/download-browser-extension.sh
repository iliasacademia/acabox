#!/bin/bash
set -euo pipefail

# Download a specific version of the browser extension from GitHub releases.
# Reads the version from package.json "browserExtensionVersion" field.
# Skips download if the correct version is already present.
#
# Usage:
#   ./scripts/download-browser-extension.sh
#
# Output:
#   browser-extension/extension.zip
#   browser-extension/VERSION  (tracks which version is downloaded)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$PROJECT_ROOT/browser-extension"
REPO="melvyn-academia/writing-agent-browser-extension"

# Read version from package.json
VERSION=$(node -e "const pkg = require('./package.json'); console.log(pkg.browserExtensionVersion || '')" 2>/dev/null)

if [ -z "$VERSION" ]; then
  echo "No browserExtensionVersion defined in package.json, skipping browser extension download"
  exit 0
fi

echo "=== Browser extension version: $VERSION ==="

# Check if we already have this version
if [ -f "$EXT_DIR/VERSION" ] && [ -f "$EXT_DIR/extension.zip" ]; then
  CURRENT=$(cat "$EXT_DIR/VERSION")
  if [ "$CURRENT" = "$VERSION" ]; then
    echo "Already have version $VERSION, skipping download"
    exit 0
  fi
fi

mkdir -p "$EXT_DIR"

# Download release asset using gh CLI (repo is private)
TAG="v$VERSION"

echo "Downloading extension.zip from release $TAG ..."
gh release download "$TAG" \
  --repo "$REPO" \
  --pattern "extension.zip" \
  --dir "$EXT_DIR" \
  --clobber

# Record the version
echo "$VERSION" > "$EXT_DIR/VERSION"

echo "Downloaded browser extension $VERSION to $EXT_DIR/extension.zip ($(du -h "$EXT_DIR/extension.zip" | cut -f1))"
