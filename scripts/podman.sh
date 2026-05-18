#!/bin/bash
# Wrapper to run podman with the cobuilding app's isolated environment.
# Usage: ./scripts/podman.sh [--prod] <any podman command>
# Examples:
#   ./scripts/podman.sh machine list
#   ./scripts/podman.sh --prod machine list
#   ./scripts/podman.sh machine ssh -- podman system reset --force
#   ./scripts/podman.sh machine start
#   ./scripts/podman.sh machine stop

set -euo pipefail

MODE="dev"
if [ "${1:-}" = "--prod" ]; then
  MODE="prod"
  shift
fi

APP_SUPPORT="$HOME/Library/Application Support/academia-electron"

if [ "$MODE" = "prod" ]; then
  USER_DATA_DIR="$APP_SUPPORT"
  PODMAN_HOME="$HOME/.cobuild-podman"
  RUN_DIR="${TMPDIR}cobuild-podman-run"
else
  USER_DATA_DIR="$APP_SUPPORT/development"
  PODMAN_HOME="$HOME/.cobuild-podman-dev"
  RUN_DIR="${TMPDIR}cobuild-podman-run-dev"
fi

PODMAN_BIN="$USER_DATA_DIR/cobuilding-podman-bin/podman"
if [ ! -x "$PODMAN_BIN" ]; then
  echo "Error: podman binary not found at $PODMAN_BIN" >&2
  echo "Run the app once so it downloads the bundled podman binary." >&2
  exit 1
fi

PODMAN_BIN_DIR="$(dirname "$PODMAN_BIN")"
PODMAN_DATA_DIR="$USER_DATA_DIR/cobuilding-podman-data"

export PATH="$PODMAN_BIN_DIR:$PATH"
export CONTAINERS_MACHINE_PROVIDER=applehv
export XDG_CONFIG_HOME="$PODMAN_DATA_DIR/config"
export XDG_DATA_HOME="$PODMAN_DATA_DIR/data"
export XDG_RUNTIME_DIR="$RUN_DIR"
export HOME="$PODMAN_HOME"

exec "$PODMAN_BIN" "$@"
