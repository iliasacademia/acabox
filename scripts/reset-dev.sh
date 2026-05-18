#!/bin/bash
# Reset the dev podman environment to simulate a fresh user.
# This destroys the VM, clears all podman state, and removes loaded images.
# The image tar in the cache dir is kept (simulates a downloaded tar).
#
# After running this, start the app with:
#   COBUILDING_LOCAL_IMAGE=1 COBUILDING_IMAGE_TIER=core npm start
#
# Usage: ./scripts/poc-reset-dev.sh [--prod]

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

echo "=== Resetting podman VM only ==="
echo ""

# ── Step 1: Stop and destroy the VM ──
echo "=== [1/2] Destroying podman VM ==="
$PODMAN machine stop 2>/dev/null || true
$PODMAN machine rm -f 2>/dev/null || true
echo "  Done"
echo ""

# ── Step 2: Clear podman HOME and runtime (VM state + sockets) ──
echo "=== [2/2] Clearing VM state ==="
for dir in "$PODMAN_HOME" "$RUN_DIR"; do
  if [ -d "$dir" ]; then
    rm -rf "$dir"
    echo "  Removed: $dir"
  fi
done
echo ""

echo "=== Ready ==="
echo "User data and settings preserved."
echo "Start the app with:"
echo "  COBUILDING_LOCAL_IMAGE=1 COBUILDING_IMAGE_TIER=core npm start"
