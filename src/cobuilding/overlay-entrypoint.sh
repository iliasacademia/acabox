#!/bin/sh
set -e

# Install rsync if not present (base image from GHCR may not have it yet)
if ! command -v rsync >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq rsync >/dev/null 2>&1 || true
fi

# The container rootfs is itself overlay (podman storage driver), so the
# upper/work dirs for our overlay can't live on it. Mount a real tmpfs first.
mount -t tmpfs tmpfs /tmp -o size=4G
mkdir -p /tmp/overlay-upper /tmp/overlay-work
mount -t overlay overlay \
  -o lowerdir=/data-host,upperdir=/tmp/overlay-upper,workdir=/tmp/overlay-work \
  /data
exec sleep infinity
