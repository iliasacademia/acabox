#!/usr/bin/env bash
# block-secret-reads.sh — PreToolUse hook for the Bash tool.
#
# Blocks commands that read Acabox's own credential files:
#
#   cobuilding-settings.json  — the Anthropic API key and connector auth
#                               headers (encrypted at rest, but the file is
#                               still not the agent's business)
#   claude-config/.claude.json — the approved-key list and `mcpOAuth`, i.e.
#                               access + refresh tokens for every connector
#                               the user has signed in to
#
# This exists because it already happened: an agent read the settings file
# while answering a question and printed the user's API key into the chat
# transcript, where it persisted in the message DB.
#
# SCOPE, honestly: this is a guardrail against incidental leakage, NOT a
# security boundary. Bash is auto-approved and unrestricted, so a determined
# or prompt-injected agent has other ways to reach a file. The defence that
# actually matters is that these values are encrypted with the OS keychain
# (main/secretStore.ts) — this hook just stops the accidental `cat`.

set -euo pipefail

input=$(cat)

# Runs for Bash (scan the command string) and for Read/Edit/Write (scan the
# path). Concatenate whichever fields are present so one script covers both.
command=$(printf '%s' "$input" | jq -r '
  [.tool_input.command // empty, .tool_input.file_path // empty]
  | join(" ")
')

if [ -z "$command" ]; then
  exit 0
fi

# Filenames worth protecting. Matching on the basename catches the file
# however it is addressed — absolute path, ~ expansion, or a relative path
# from some other directory.
patterns=(
  'cobuilding-settings\.json'
  'claude-config'
  '\.claude\.json'
  # The agent server's start config. Holds the raw API key and decrypted
  # connector headers — it is the SDK's input, so unlike settings.json it
  # cannot be encrypted. It lives in userData, not the workspace.
  'agent\.json'
)

matched=""
for pattern in "${patterns[@]}"; do
  if printf '%s' "$command" | grep -qE "$pattern"; then
    matched="$pattern"
    break
  fi
done

if [ -n "$matched" ]; then
  cat >&2 <<EOF
That file holds Acabox's own credentials and is off limits.

Detected in command:
  $command

cobuilding-settings.json holds the user's Anthropic API key and connector auth
headers. The Claude config directory holds OAuth access and refresh tokens for
every connector they have signed in to. Reading either would copy secrets into
this conversation, where they persist in the transcript.

There is no task that needs them:

  - To check whether an API key is configured, just try the work; a missing key
    produces a clear error.
  - To see which connectors exist, ask the user, or read the connector status
    shown in Settings → Connectors.
  - To connect or authenticate a service, use the connector flow: the user adds
    it in Settings → Connectors, then you call
    mcp__<connector>__authenticate and give them the URL it returns.

If the user explicitly asked you to change a credential, tell them to do it in
Settings rather than editing the file.
EOF
  exit 2
fi

exit 0
