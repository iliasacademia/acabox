#!/bin/bash
# Reset ALL download state to simulate a fresh install for the Download Manager.
# Removes: podman binaries, image tar cache, VM, and related settings.
#
# Usage: ./scripts/reset-downloads.sh [--prod]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MODE_FLAG="${1:-}"

if [ "$MODE_FLAG" = "--prod" ]; then
  USER_DATA="$HOME/Library/Application Support/academia-electron/production"
  PODMAN_HOME="$HOME/.cobuild-podman"
  RUN_DIR="${TMPDIR}cobuild-podman-run"
else
  USER_DATA="$HOME/Library/Application Support/academia-electron/development"
  PODMAN_HOME="$HOME/.cobuild-podman-dev"
  RUN_DIR="${TMPDIR}cobuild-podman-run-dev"
fi

PODMAN="$SCRIPT_DIR/podman.sh $MODE_FLAG"

echo "=== Resetting all downloads (${MODE_FLAG:-dev}) ==="
echo ""

# ── Step 1: Stop and destroy the VM ──
echo "[1/5] Destroying podman VM..."
$PODMAN machine stop 2>/dev/null || true
$PODMAN machine rm -f 2>/dev/null || true
echo "  Done"

# ── Step 2: Remove podman binaries ──
BIN_DIR="$USER_DATA/cobuilding-podman-bin"
echo "[2/5] Removing podman binaries..."
if [ -d "$BIN_DIR" ]; then
  rm -rf "$BIN_DIR"
  echo "  Removed: $BIN_DIR"
else
  echo "  Already clean"
fi

# ── Step 3: Remove image tar cache ──
CACHE_DIR="$USER_DATA/cobuilding-image-cache"
echo "[3/5] Removing image tar cache..."
if [ -d "$CACHE_DIR" ]; then
  rm -rf "$CACHE_DIR"
  echo "  Removed: $CACHE_DIR"
else
  echo "  Already clean"
fi

# ── Step 4: Clear VM state (HOME + runtime sockets) ──
echo "[4/5] Clearing VM state..."
for dir in "$PODMAN_HOME" "$RUN_DIR"; do
  if [ -d "$dir" ]; then
    rm -rf "$dir"
    echo "  Removed: $dir"
  fi
done

# ── Step 5: Reset download-related settings ──
SETTINGS="$USER_DATA/cobuilding-settings.json"
echo "[5/5] Resetting settings..."
if [ -f "$SETTINGS" ]; then
  # Remove loadedImageVersion and imageTier, keep other settings
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, sys
with open('$SETTINGS') as f:
    data = json.load(f)
data.pop('loadedImageVersion', None)
data.pop('imageTier', None)
with open('$SETTINGS', 'w') as f:
    json.dump(data, f, indent=2)
print('  Cleared loadedImageVersion and imageTier from settings')
"
  else
    echo "  python3 not found, deleting entire settings file"
    rm -f "$SETTINGS"
  fi
else
  echo "  No settings file"
fi

echo ""
echo "=== All download state cleared ==="
echo "Start the app with: npm start"
