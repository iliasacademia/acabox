#!/usr/bin/env bash
# warn-podman-exec.sh — PreToolUse hook for the Bash tool.
#
# Warns when the agent emits a Bash command containing "podman exec
# cobuilding-container". Since the agent now runs inside the container,
# the prefix is unnecessary and likely a stale pattern from training data
# or outdated custom skills.

set -euo pipefail

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

if [ -z "$command" ]; then
  exit 0
fi

if printf '%s' "$command" | grep -q 'podman exec.*cobuilding-container'; then
  cat >&2 <<EOF
You are running inside the container. Drop the 'podman exec cobuilding-container'
prefix and run commands directly.

Instead of:
  podman exec cobuilding-container python3 script.py

Just run:
  python3 script.py
EOF
  exit 2
fi

exit 0
