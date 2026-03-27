#!/usr/bin/env bash
#
# Downloads pre-built podman, gvproxy, and vfkit binaries for macOS.
# Run: npm run download-podman
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_ROOT/podman-bin"

# Versions
PODMAN_VERSION="5.3.1"
GVPROXY_VERSION="0.8.0"
VFKIT_VERSION="0.6.0"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH_LABEL="aarch64" ;;
  x86_64)        ARCH_LABEL="amd64" ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

echo "==> Downloading podman binaries for macOS ($ARCH_LABEL)"
echo "    Target directory: $BIN_DIR"
mkdir -p "$BIN_DIR"

# ── Podman ──────────────────────────────────────────────────────
# Podman distributes macOS binaries as a .pkg installer or via Homebrew.
# We download the universal macOS binary from the official release.
PODMAN_PKG_URL="https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-installer-macos-universal.pkg"
PODMAN_PKG="$BIN_DIR/podman.pkg"

if [ -f "$BIN_DIR/podman" ]; then
  echo "==> podman binary already exists, skipping"
else
  echo "==> Downloading podman v${PODMAN_VERSION}..."
  curl -L -o "$PODMAN_PKG" "$PODMAN_PKG_URL"

  # Extract the binary from the .pkg
  echo "==> Extracting podman binary from .pkg..."
  TEMP_DIR=$(mktemp -d)
  pkgutil --expand-full "$PODMAN_PKG" "$TEMP_DIR/podman-pkg"

  # Find the podman binary inside the extracted package
  PODMAN_BIN=$(find "$TEMP_DIR/podman-pkg" -name "podman" -type f -perm +111 | head -1)
  if [ -z "$PODMAN_BIN" ]; then
    # Try looking in the Payload
    PODMAN_BIN=$(find "$TEMP_DIR/podman-pkg" -path "*/usr/bin/podman" -type f | head -1)
  fi
  if [ -z "$PODMAN_BIN" ]; then
    echo "Error: Could not find podman binary in .pkg"
    echo "Contents of extracted pkg:"
    find "$TEMP_DIR/podman-pkg" -type f | head -20
    rm -rf "$TEMP_DIR" "$PODMAN_PKG"
    exit 1
  fi

  cp "$PODMAN_BIN" "$BIN_DIR/podman"
  chmod +x "$BIN_DIR/podman"
  rm -rf "$TEMP_DIR" "$PODMAN_PKG"
  echo "    ✓ podman"
fi

# ── gvproxy ─────────────────────────────────────────────────────
# Also extracted from the same podman pkg, or downloaded separately
GVPROXY_URL="https://github.com/containers/gvisor-tap-vsock/releases/download/v${GVPROXY_VERSION}/gvproxy-darwin"

if [ -f "$BIN_DIR/gvproxy" ]; then
  echo "==> gvproxy binary already exists, skipping"
else
  echo "==> Downloading gvproxy v${GVPROXY_VERSION}..."
  curl -L -o "$BIN_DIR/gvproxy" "$GVPROXY_URL"
  chmod +x "$BIN_DIR/gvproxy"
  echo "    ✓ gvproxy"
fi

# ── vfkit ───────────────────────────────────────────────────────
VFKIT_URL="https://github.com/crc-org/vfkit/releases/download/v${VFKIT_VERSION}/vfkit"

if [ -f "$BIN_DIR/vfkit" ]; then
  echo "==> vfkit binary already exists, skipping"
else
  echo "==> Downloading vfkit v${VFKIT_VERSION}..."
  curl -L -o "$BIN_DIR/vfkit" "$VFKIT_URL"
  chmod +x "$BIN_DIR/vfkit"
  echo "    ✓ vfkit"
fi

echo ""
echo "==> Done! Binaries available in $BIN_DIR:"
ls -lh "$BIN_DIR"
