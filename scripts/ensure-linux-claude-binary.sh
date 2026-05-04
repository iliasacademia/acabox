#!/usr/bin/env bash
# ensure-linux-claude-binary.sh
#
# Ensures the Linux claude binary is present in node_modules for the
# container's architecture. npm skips these packages due to platform
# mismatch, so we fetch them manually.
#
# On arm64 hosts (Apple Silicon) → fetches linux-arm64-musl
# On x64 hosts                   → fetches linux-x64-musl

set -euo pipefail

# Detect host architecture — podman machine matches the host arch.
# Use glibc (non-musl) variant since the container is Ubuntu-based.
HOST_ARCH=$(node -e "console.log(process.arch === 'arm64' ? 'arm64' : 'x64')")
PKG="@anthropic-ai/claude-agent-sdk-linux-${HOST_ARCH}"
PKG_DIR="node_modules/$PKG"
BINARY="$PKG_DIR/claude"

# Skip if already present
if [ -f "$BINARY" ]; then
  echo "[ensure-linux-claude-binary] Binary already present ($HOST_ARCH, glibc), skipping."
  exit 0
fi

# Get the version from the main SDK package
SDK_VERSION=$(node -e "const p = require('fs').readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json','utf8'); console.log(JSON.parse(p).version)")
echo "[ensure-linux-claude-binary] Fetching $PKG@$SDK_VERSION..."

# Download the tarball from npm registry
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

npm pack "$PKG@$SDK_VERSION" --pack-destination "$TMPDIR" 2>/dev/null

# Extract into node_modules
TARBALL=$(ls "$TMPDIR"/*.tgz | head -1)
mkdir -p "$PKG_DIR"
tar xzf "$TARBALL" -C "$PKG_DIR" --strip-components=1

echo "[ensure-linux-claude-binary] Installed $PKG@$SDK_VERSION ($HOST_ARCH)"
