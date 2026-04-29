#!/bin/bash
#
# Sideload the Academia test add-in for Microsoft Word, PowerPoint, and Excel on macOS.
# Copies the manifest XML to each app's wef folder.
# The add-in is served by the cobuild desktop app on https://localhost:23112.
#

set -e

ADDIN_ID="e56ffae3-be6a-463a-a4a2-9ec965f8d2d7"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST_SRC="$PROJECT_DIR/ms_office_addin/manifest-local.xml"
MANIFEST_FILENAME="${ADDIN_ID}.manifest.xml"

if [ ! -f "$MANIFEST_SRC" ]; then
  echo "ERROR: manifest not found at $MANIFEST_SRC"
  exit 1
fi

echo "=== Sideloading Office Add-in ==="
echo ""

APPS=("com.microsoft.Word" "com.microsoft.Powerpoint" "com.microsoft.Excel")
NAMES=("Word" "PowerPoint" "Excel")

for i in "${!APPS[@]}"; do
  WEF_DIR="$HOME/Library/Containers/${APPS[$i]}/Data/Documents/wef"
  mkdir -p "$WEF_DIR"
  cp "$MANIFEST_SRC" "$WEF_DIR/$MANIFEST_FILENAME"
  echo "  ✓ ${NAMES[$i]}: $WEF_DIR"
done

echo ""
echo "=== Done! ==="
echo ""
echo "Next steps:"
echo "  1. Make sure the cobuild desktop app is running"
echo "  2. Quit Word / PowerPoint / Excel completely (Cmd+Q)"
echo "  3. Reopen the app and open a document"
echo "  4. Look for 'Academia Test' group in the Home ribbon tab"
echo "     OR go to Insert → My Add-ins → look for 'Academia Test Add-in'"
echo "  5. Click 'Hello World' button to open the task pane"
echo ""
