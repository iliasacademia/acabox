#!/usr/bin/env bash
# block-host-installs.sh — PreToolUse hook for the Bash tool.
#
# Blocks ALL direct package-manager install invocations. The install wrapper
# (.applications/install) is the only sanctioned path: it runs the live
# install AND records the dependency in the app's per-registry file so the
# install travels with the app folder when it is shared.
#
# Only commands the agent types into the Bash tool are scanned. The wrapper's
# internal install calls do not go through the agent's Bash tool.
#
# The apt/conda/R patterns below are still blocked even though the wrapper
# cannot install those either — Acabox runs on the user's own machine and must
# not touch its system package managers. The message says so, rather than
# redirecting to a wrapper invocation that would just be refused again.

set -euo pipefail

# Read the full hook payload from stdin.
input=$(cat)

# Extract the command string.
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# No command, nothing to do.
if [ -z "$command" ]; then
  exit 0
fi

# Install-command patterns. These scan the whole command string so that
# invocations routed via `podman exec`, `bash -c`, `sh -c`, or chained with
# && / ; / | are all caught.
#
# Each pattern anchors the tool name at a non-alphanumeric boundary so we
# don't match substrings (e.g. "zipper" should not match "pip").
patterns=(
  '(^|[^[:alnum:]_/.-])pip3?[[:space:]]+install([[:space:]]|$)'
  '(^|[^[:alnum:]_/.-])pipx[[:space:]]+install([[:space:]]|$)'
  '(^|[^[:alnum:]_/.-])python3?[[:space:]]+-m[[:space:]]+pip[[:space:]]+install([[:space:]]|$)'
  '(^|[^[:alnum:]_/.-])(npm|pnpm|yarn)[[:space:]]+(install|i|add)([[:space:]]|$)'
  '(^|[^[:alnum:]_/.-])apt(-get)?[[:space:]]+install([[:space:]]|$)'
  '(^|[^[:alnum:]_/.-])(conda|mamba)[[:space:]]+(install|create)([[:space:]]|$)'
  'install\.packages[[:space:]]*\('
)

blocked_pattern=""
for pattern in "${patterns[@]}"; do
  if printf '%s' "$command" | grep -qE "$pattern"; then
    blocked_pattern="$pattern"
    break
  fi
done

if [ -n "$blocked_pattern" ]; then
  cat >&2 <<EOF
Direct package installation is not allowed.

Detected in command:
  $command

Use the install wrapper to ensure dependencies are tracked:

  .applications/install pip <package> --app <app_dir_name>
  .applications/install npm <package> --app <app_dir_name>
  .applications/install manual .applications/<app>/setup/<script>.sh --app <app_dir_name>

The wrapper installs the package AND records the dependency in the app's
per-registry file (requirements.txt, package.json, or setup/*.sh) so it travels
when the app folder is shared. Running pip/npm directly does the live install
but does not update the dependency file, so the install is silently lost when
the app is shared.

apt, R, and conda have NO wrapper equivalent. Acabox runs on the user's own
machine, so it will not install into their system package manager. If a task
needs one of those, either find a pip/npm alternative or tell the user what to
install themselves — do not retry through the wrapper, it refuses them too.

For downloading DATA (model weights, datasets, etc.) into the app folder, use
curl or wget to write directly into .applications/<app_dir_name>/. Those are
app-local files, not global installs — the wrapper is not needed.
EOF
  exit 2
fi

exit 0
