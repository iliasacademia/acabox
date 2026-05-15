#!/bin/bash
# Clear the image tar cache so the next launch re-downloads (or re-detects local tar).
# Also clears the loaded image version from settings so podman load runs again.
#
# Usage: ./scripts/poc-clear-tar-cache.sh [--prod]

set -euo pipefail

MODE_FLAG="${1:-}"

if [ "$MODE_FLAG" = "--prod" ]; then
  USER_DATA="$HOME/Library/Application Support/academia-electron"
else
  USER_DATA="$HOME/Library/Application Support/academia-electron/development"
fi

IMAGE_CACHE="$USER_DATA/cobuilding-image-cache"
SETTINGS="$USER_DATA/cobuilding-settings.json"

echo "=== Clearing image tar cache ==="

if [ -d "$IMAGE_CACHE" ]; then
  echo "  Removing: $IMAGE_CACHE"
  ls -lh "$IMAGE_CACHE" 2>/dev/null | grep -v total
  rm -rf "$IMAGE_CACHE"
  echo "  Deleted"
else
  echo "  No cache dir found"
fi

if [ -f "$SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
    if (data.loadedImageVersion) {
      delete data.loadedImageVersion;
      fs.writeFileSync('$SETTINGS', JSON.stringify(data, null, 2));
      console.log('  Cleared loadedImageVersion from settings');
    } else {
      console.log('  No loadedImageVersion in settings');
    }
  "
fi

echo ""
echo "=== Done ==="
