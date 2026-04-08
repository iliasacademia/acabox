#!/usr/bin/env bash
#
# Benchmark building Dockerfile.base with Docker (via Colima) and/or Podman.
# Runs each available engine with --no-cache and reports wall-clock time.
#
# Prerequisites:
#   Podman:  brew install podman && podman machine init && podman machine start
#   Docker:  brew install colima docker docker-buildx && colima start
#            (Uses Docker Engine in a Lima VM — no Docker Desktop needed)
#
# Usage:
#   ./bench-build.sh              # test whichever of docker/podman is installed
#   ./bench-build.sh docker       # test docker only
#   ./bench-build.sh podman       # test podman only
#   ./bench-build.sh both         # test both (default when no arg given)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTEXT_DIR="$SCRIPT_DIR/.."
DOCKERFILE="$CONTEXT_DIR/Dockerfile.base"
IMAGE_TAG_PREFIX="cobuilding-base-bench"

requested="${1:-both}"

has_docker() { command -v docker &>/dev/null; }
has_podman() { command -v podman &>/dev/null; }

# Check if Docker daemon is reachable (Colima or Docker Desktop)
docker_ready() {
  docker info &>/dev/null 2>&1
}

# Check if Podman machine is running
podman_ready() {
  podman info &>/dev/null 2>&1
}

ensure_docker() {
  if ! has_docker; then
    echo "Error: docker CLI not found. Install with: brew install docker docker-buildx"
    return 1
  fi
  if ! docker_ready; then
    # Try to start Colima if installed
    if command -v colima &>/dev/null; then
      echo "Docker daemon not running. Starting Colima..."
      colima start
    else
      echo "Error: Docker daemon not running and Colima not installed."
      echo "Install with: brew install colima docker docker-buildx"
      echo "Then run:     colima start"
      return 1
    fi
  fi
}

ensure_podman() {
  if ! has_podman; then
    echo "Error: podman not found. Install with: brew install podman"
    return 1
  fi
  if ! podman_ready; then
    echo "Podman machine not running. Starting..."
    podman machine start 2>/dev/null || podman machine init && podman machine start
  fi
}

engines=()
case "$requested" in
  docker)
    ensure_docker || exit 1
    engines=(docker)
    ;;
  podman)
    ensure_podman || exit 1
    engines=(podman)
    ;;
  both|"")
    has_docker && docker_ready && engines+=(docker)
    has_podman && podman_ready && engines+=(podman)
    # If nothing is ready, try starting them
    if [ ${#engines[@]} -eq 0 ]; then
      has_docker && ensure_docker 2>/dev/null && engines+=(docker)
      has_podman && ensure_podman 2>/dev/null && engines+=(podman)
    fi
    ;;
  *)
    echo "Usage: $0 [docker|podman|both]"
    exit 1
    ;;
esac

if [ ${#engines[@]} -eq 0 ]; then
  echo "Error: no container engine available."
  echo ""
  echo "Install one or both:"
  echo "  Podman:  brew install podman && podman machine init && podman machine start"
  echo "  Docker:  brew install colima docker docker-buildx && colima start"
  exit 1
fi

build_with_docker() {
  local tag="$1"
  # Use buildx if available for BuildKit parallelism
  if docker buildx version &>/dev/null; then
    docker buildx build \
      --no-cache \
      --platform linux/amd64 \
      --load \
      -t "$tag" \
      -f "$DOCKERFILE" \
      "$CONTEXT_DIR"
  else
    docker build \
      --no-cache \
      --platform linux/amd64 \
      -t "$tag" \
      -f "$DOCKERFILE" \
      "$CONTEXT_DIR"
  fi
}

build_with_podman() {
  local tag="$1"
  podman build \
    --no-cache \
    --platform linux/amd64 \
    -t "$tag" \
    -f "$DOCKERFILE" \
    "$CONTEXT_DIR"
}

run_build() {
  local engine="$1"
  local tag="${IMAGE_TAG_PREFIX}:${engine}"

  echo "════════════════════════════════════════════════════"
  echo "  Engine: $engine"
  echo "  Tag:    $tag"
  echo "  Time:   $(date '+%Y-%m-%d %H:%M:%S')"
  echo "════════════════════════════════════════════════════"
  echo ""

  # Show version
  "$engine" --version
  if [ "$engine" = "docker" ] && docker buildx version &>/dev/null; then
    echo -n "  buildx: "; docker buildx version
  fi
  echo ""

  local start end elapsed
  start=$(date +%s)

  if "build_with_${engine}" "$tag"; then
    end=$(date +%s)
    elapsed=$((end - start))

    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))

    echo ""
    echo "────────────────────────────────────────────────────"
    printf "  %-8s  %dm %02ds  (%d seconds total)\n" "$engine" "$mins" "$secs" "$elapsed"
    echo "────────────────────────────────────────────────────"
    echo ""

    eval "${engine}_elapsed=$elapsed"
  else
    end=$(date +%s)
    elapsed=$((end - start))

    echo ""
    echo "────────────────────────────────────────────────────"
    printf "  %-8s  FAILED after %ds\n" "$engine" "$elapsed"
    echo "────────────────────────────────────────────────────"
    echo ""

    eval "${engine}_elapsed=FAILED"
  fi
}

echo ""
echo "Building $DOCKERFILE with: ${engines[*]}"
echo ""

for engine in "${engines[@]}"; do
  run_build "$engine"
done

# Summary
if [ ${#engines[@]} -gt 1 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║                   SUMMARY                       ║"
  echo "╠══════════════════════════════════════════════════╣"
  for engine in "${engines[@]}"; do
    val_var="${engine}_elapsed"
    val="${!val_var}"
    if [ "$val" = "FAILED" ]; then
      printf "║  %-8s  FAILED                              \n" "$engine"
    else
      mins=$((val / 60))
      secs=$((val % 60))
      printf "║  %-8s  %dm %02ds  (%d seconds)              \n" "$engine" "$mins" "$secs" "$val"
    fi
  done
  echo "╚══════════════════════════════════════════════════╝"
fi
