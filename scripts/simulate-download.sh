#!/bin/bash
# Simulate the download step by placing a locally-built core image tar
# where imageTarManager/containerService expect it, and pre-setting
# the version in cobuilding-settings.json.
#
# After running this, start the app with:
#   COBUILDING_LOCAL_IMAGE=1 COBUILDING_IMAGE_TIER=core npm start
#
# Usage: ./scripts/poc-simulate-download.sh [--prod]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MODE_FLAG="${1:-}"

if [ "$MODE_FLAG" = "--prod" ]; then
  USER_DATA="$HOME/Library/Application Support/academia-electron"
else
  USER_DATA="$HOME/Library/Application Support/academia-electron/development"
fi

IMAGE_CACHE="$USER_DATA/cobuilding-image-cache"
SETTINGS="$USER_DATA/cobuilding-settings.json"
TAR_NAME="cobuilding-base-core-arm64.tar"
TAR_PATH="$IMAGE_CACHE/$TAR_NAME"
VERSION="local-dev"

# ── Step 1: Build the core image if needed ──
echo "=== Checking for core image tar ==="
if [ -f "$TAR_PATH" ]; then
  echo "  Tar already exists: $TAR_PATH ($(du -h "$TAR_PATH" | cut -f1))"
else
  echo "  Building core image..."
  docker buildx build \
    --platform "linux/$(uname -m | sed 's/x86_64/amd64/')" \
    -f "$SCRIPT_DIR/../src/cobuilding/Dockerfile.base-core" \
    -t cobuilding-base-core:local \
    --load \
    "$SCRIPT_DIR/../src/cobuilding"

  echo "  Saving to tar..."
  mkdir -p "$IMAGE_CACHE"
  docker save cobuilding-base-core:local -o "$TAR_PATH"
  echo "  Saved: $TAR_PATH ($(du -h "$TAR_PATH" | cut -f1))"
fi
echo ""

# ── Step 2: Clear the loaded version so containerService will load it ──
echo "=== Updating settings ==="
if [ -f "$SETTINGS" ]; then
  # Remove any existing loadedImageVersion.core so it forces a podman load
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
    if (data.loadedImageVersion) delete data.loadedImageVersion.core;
    fs.writeFileSync('$SETTINGS', JSON.stringify(data, null, 2));
    console.log('  Cleared loadedImageVersion.core');
  "
else
  echo "  No settings file yet (will be created on first run)"
fi
echo ""

echo "=== Ready ==="
echo "Tar: $TAR_PATH"
echo ""
echo "Start the app with:"
echo "  COBUILDING_LOCAL_IMAGE=1 COBUILDING_IMAGE_TIER=core npm start"
