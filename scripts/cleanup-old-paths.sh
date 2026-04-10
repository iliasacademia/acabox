#!/bin/bash
# Cleanup script for cobuild data paths.
#
# Usage:
#   ./scripts/cleanup-old-paths.sh          # Remove old shared paths only
#   ./scripts/cleanup-old-paths.sh --full   # Full reset: remove ALL dev + prod data
#
# Previously, dev and prod shared these directories:
#   ~/.cobuild-podman/           (podman HOME — VM state, SSH keys, sockets)
#   $TMPDIR/cobuild-podman-run/  (podman runtime sockets)
#   ~/Library/Logs/Academia Coscientist/  (electron-log — shared log dir)
#
# After this migration:
#   ~/.cobuild-podman/     (prod)  and  ~/.cobuild-podman-dev/     (dev)
#   $TMPDIR/cobuild-podman-run/ (prod)  and  cobuild-podman-run-dev/ (dev)
#   Logs now live in ~/Library/Application Support/academia-electron/{development|production}/cobuilding.log

set -e

remove_paths() {
  for p in "$@"; do
    if [ -e "$p" ]; then
      echo "  Removing: $p"
      rm -rf "$p"
    else
      echo "  Already clean: $p"
    fi
  done
}

# Always clean up old shared paths
echo "Cleaning up old shared paths..."
remove_paths \
  "$HOME/.cobuild-podman" \
  "${TMPDIR:-/tmp}/cobuild-podman-run" \
  "$HOME/Library/Logs/Academia Coscientist" \
  "$HOME/.cobuild-podman-prod" \
  "${TMPDIR:-/tmp}/cobuild-podman-run-prod"

if [ "$1" = "--full" ]; then
  echo ""
  echo "Full reset: removing ALL dev and prod data..."

  echo ""
  echo "Production:"
  remove_paths \
    "$HOME/Library/Application Support/academia-electron/production" \
    "$HOME/.cobuild-podman" \
    "${TMPDIR:-/tmp}/cobuild-podman-run" \
    "$HOME/Library/Preferences/com.electron.academia-coscientist.plist"

  echo ""
  echo "Development:"
  remove_paths \
    "$HOME/Library/Application Support/academia-electron/development" \
    "$HOME/.cobuild-podman-dev" \
    "${TMPDIR:-/tmp}/cobuild-podman-run-dev"

  echo ""
  echo "Shared Electron caches:"
  remove_paths \
    "$HOME/Library/Caches/academia-electron"

  echo ""
  echo "Full reset complete. Next launch will be a clean install."
else
  echo ""
  echo "Done. Old shared paths removed."
  echo ""
  echo "To do a full reset (wipe all dev + prod data), run:"
  echo "  ./scripts/cleanup-old-paths.sh --full"
fi
