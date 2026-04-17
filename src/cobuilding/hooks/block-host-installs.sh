#!/usr/bin/env bash
# block-host-installs.sh — PreToolUse hook for the Bash tool.
#
# Blocks ALL direct package-manager install invocations, whether on the host
# or routed through `podman exec` / `bash -c` / etc. The install wrapper
# (.applications/install) is the only sanctioned path: it runs the live
# install inside the container AND records the dependency in the app's
# per-registry file.
#
# The wrapper itself runs `podman exec <container> pip install ...` as a
# child process — those calls do NOT go through the agent's Bash tool, so
# they aren't intercepted by this hook. Only commands the agent types into
# the Bash tool are scanned.

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
Direct package installation is not allowed — even via podman exec.

Detected in command:
  $command

To install software into the cobuilding container, use the install wrapper:

  .applications/install pip <package> --app <app_dir_name>
  .applications/install npm <package> --app <app_dir_name>
  .applications/install R   <package> --app <app_dir_name>
  .applications/install apt <package> --app <app_dir_name>
  .applications/install manual .applications/<app>/setup/<script>.sh --app <app_dir_name>

The wrapper installs into the running container AND records the dependency in
the app's per-registry file (requirements.txt, package.json, r-packages.txt,
apt-packages.txt, or setup/*.sh) so it persists across container rebuilds and
travels when the app folder is shared. Running pip/npm/apt/Rscript directly —
even through podman exec — does the live install but does not update the
dependency file, so the install is silently lost on rebuild or share.

For downloading DATA (model weights, datasets, etc.) into the app folder, use
curl or wget to write directly into .applications/<app_dir_name>/. Those are
app-local files, not global installs — the wrapper is not needed.
EOF
  exit 2
fi

exit 0
