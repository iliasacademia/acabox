#!/bin/bash
set -euo pipefail

# Find the packaged .app in out/
APP_PATH=$(find out -name "*.app" -maxdepth 3 -type d | head -1)

if [ -z "$APP_PATH" ]; then
  echo "ERROR: Could not find any .app in out/"
  exit 1
fi

echo "Found app: $APP_PATH"

# Resolve the binary inside (name matches the .app bundle name without extension)
APP_NAME=$(basename "$APP_PATH" .app)
BINARY="$APP_PATH/Contents/MacOS/$APP_NAME"

if [ ! -x "$BINARY" ]; then
  echo "ERROR: Binary not found or not executable: $BINARY"
  exit 1
fi

echo "Running smoke test with network sandbox..."

LOG_FILE=$(mktemp /tmp/smoke-test-XXXXXX)

# Run with network sandbox + smoke-test flag, 60s timeout
# macOS doesn't ship GNU `timeout`, so use a portable background-process approach
# ELECTRON_ENABLE_LOGGING makes Electron emit internal logs to stderr
ELECTRON_ENABLE_LOGGING=1 sandbox-exec -f scripts/deny-network.sb "$BINARY" --smoke-test \
  >"$LOG_FILE" 2>&1 &
SMOKE_PID=$!

SECONDS=0
while kill -0 "$SMOKE_PID" 2>/dev/null; do
  if [ "$SECONDS" -ge 60 ]; then
    echo "ERROR: Smoke test timed out after 60 seconds"
    echo "--- App output ---"
    cat "$LOG_FILE"
    echo "--- End output ---"
    kill "$SMOKE_PID" 2>/dev/null
    rm -f "$LOG_FILE"
    exit 1
  fi
  sleep 1
done

wait "$SMOKE_PID" && EXIT_CODE=0 || EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "ERROR: Smoke test failed with exit code $EXIT_CODE"
  echo "--- App output ---"
  cat "$LOG_FILE"
  echo "--- End output ---"
  rm -f "$LOG_FILE"
  exit "$EXIT_CODE"
fi

rm -f "$LOG_FILE"
echo "Smoke test passed"
