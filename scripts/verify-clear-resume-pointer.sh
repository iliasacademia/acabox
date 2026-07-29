#!/usr/bin/env bash
# Verifies `clearSdkSessionId`'s SQL against a REAL cobuilding.db schema.
#
# Why this isn't a jest test: better-sqlite3 is built against Electron's Node
# ABI, so jest cannot open the database at all. Rather than assert against a
# hand-rolled schema that could drift from the migration chain, this runs the
# statement against a *copy* of an actual database — the original is never
# touched, and the schema is by definition the one the app runs on.
#
#   Usage: scripts/verify-clear-resume-pointer.sh [path/to/cobuilding.db]
set -euo pipefail

SRC="${1:-$HOME/Library/Application Support/acabox/production/cobuilding.db}"
[ -f "$SRC" ] || { echo "No database at: $SRC" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# .backup checkpoints the WAL, so the copy reflects committed state.
sqlite3 "$SRC" ".backup '$WORK/db.sqlite'"

fail() { echo "FAIL: $1" >&2; exit 1; }

WS=$(sqlite3 "$WORK/db.sqlite" "SELECT id FROM workspaces LIMIT 1;")
[ -n "$WS" ] || fail "no workspace row to hang a test session off"

sqlite3 "$WORK/db.sqlite" <<SQL
PRAGMA foreign_keys = ON;
INSERT INTO sessions (id, workspace_id, sdk_session_id, title)
VALUES ('verify-thread', '$WS', '4c26c05b-b287-4b77-a1f5-8fde83357c45', 'Verify');
INSERT INTO messages (session_id, type, content)
VALUES ('verify-thread', 'user', '{"text":"hi"}');
SQL

[ "$(sqlite3 "$WORK/db.sqlite" "SELECT sdk_session_id FROM sessions WHERE id='verify-thread';")" \
  = "4c26c05b-b287-4b77-a1f5-8fde83357c45" ] || fail "setup: resume pointer not stored"

# The exact statement clearSdkSessionId runs.
sqlite3 "$WORK/db.sqlite" "UPDATE sessions SET sdk_session_id = NULL WHERE id = 'verify-thread';"

[ "$(sqlite3 "$WORK/db.sqlite" "SELECT sdk_session_id IS NULL FROM sessions WHERE id='verify-thread';")" = "1" ] \
  || fail "resume pointer was not cleared — startLoop would resume the poisoned transcript"
[ "$(sqlite3 "$WORK/db.sqlite" "SELECT COUNT(*) FROM sessions WHERE id='verify-thread';")" = "1" ] \
  || fail "the session row was destroyed; only the agent's memory should be dropped"
[ "$(sqlite3 "$WORK/db.sqlite" "SELECT COUNT(*) FROM messages WHERE session_id='verify-thread';")" = "1" ] \
  || fail "the chat's own history was destroyed"

# Idempotent: a thread that never resumed must survive the same statement.
sqlite3 "$WORK/db.sqlite" "INSERT INTO sessions (id, workspace_id, title) VALUES ('verify-fresh', '$WS', 'Fresh');"
sqlite3 "$WORK/db.sqlite" "UPDATE sessions SET sdk_session_id = NULL WHERE id = 'verify-fresh';"
[ "$(sqlite3 "$WORK/db.sqlite" "SELECT COUNT(*) FROM sessions WHERE id='verify-fresh';")" = "1" ] \
  || fail "clearing an already-null pointer removed the row"

echo "OK: 5/5 — resume pointer cleared, session row and message history intact (schema from $SRC)"
