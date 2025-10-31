#!/bin/bash
# Simple Native Tests Runner (No XCTest Required)
# Compiles and runs basic verification tests using standard frameworks

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "======================================"
echo "Running Critical Native Tests (Simple)"
echo "======================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}Error: Tests can only run on macOS${NC}"
    exit 1
fi

# Compile the test executable
echo -e "${YELLOW}Step 1: Compiling test executable...${NC}"

mkdir -p build

clang++ -arch arm64 -arch x86_64 \
    -framework Cocoa \
    -framework WebKit \
    -framework ApplicationServices \
    -framework CoreGraphics \
    -framework QuartzCore \
    -ObjC++ \
    -std=c++17 \
    -fobjc-arc \
    -Wno-deprecated-declarations \
    -I"$SCRIPT_DIR" \
    -I"$SCRIPT_DIR/bridge/interface" \
    -I"$SCRIPT_DIR/bridge/macos" \
    -I"$SCRIPT_DIR/bridge/helpers" \
    -I"$SCRIPT_DIR/bridge/windows" \
    -I"$SCRIPT_DIR/bridge/views" \
    -I"$SCRIPT_DIR/../node_modules/node-addon-api" \
    -o build/SimpleTests \
    bridge/__tests__/SimpleTests.mm \
    bridge/interface/Message.cpp \
    bridge/interface/MessageRouter.cpp \
    bridge/helpers/ScriptInjector.mm \
    bridge/helpers/HTMLLoader.mm \
    bridge/helpers/PanelStyleHelper.mm \
    bridge/helpers/WebViewConfigHelper.mm \
    bridge/windows/BasePopupWindow.mm \
    bridge/windows/BaseNativeWindow.mm \
    bridge/windows/TextPopupWindow.mm \
    bridge/windows/ClickPopupWindow.mm \
    bridge/windows/ButtonOverlayWindow.mm \
    bridge/windows/LineCountButtonWindow.mm \
    bridge/views/NativeHeaderView.mm \
    bridge/views/ResizeHandleView.mm

if [ $? -ne 0 ]; then
    echo -e "${RED}Compilation failed!${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Compilation successful${NC}"
echo ""

# Run tests
echo -e "${YELLOW}Step 2: Running tests...${NC}"
echo ""

./build/SimpleTests

TEST_RESULT=$?

echo ""
if [ $TEST_RESULT -eq 0 ]; then
    echo -e "${GREEN}======================================"
    echo -e "✓ All critical tests passed!"
    echo -e "======================================${NC}"
else
    echo -e "${RED}======================================"
    echo -e "✗ Some tests failed!"
    echo -e "======================================${NC}"
    exit 1
fi
