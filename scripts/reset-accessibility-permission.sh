#!/bin/bash
# Reset macOS Accessibility permission for Academia so it can be re-granted.
# Useful when the permission was denied and the system won't prompt again.
#
# Usage: ./scripts/reset-accessibility-permission.sh
#
# This runs `tccutil reset Accessibility` for the app's bundle ID,
# which requires an admin password. After resetting, it opens
# System Settings → Privacy & Security → Accessibility so you can
# re-enable the app.

set -e

BUNDLE_ID="com.electron.academia-electron"

echo "Resetting Accessibility permission for ${BUNDLE_ID}..."
echo "You may be prompted for your admin password."

tccutil reset Accessibility "$BUNDLE_ID"

echo "Permission reset. Opening System Settings..."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

echo "Done. Enable Academia in the Accessibility list, then relaunch the app."
