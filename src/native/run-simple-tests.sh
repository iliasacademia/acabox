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

# Common compilation flags and includes
COMMON_FLAGS="-arch arm64 -arch x86_64 \
    -framework Cocoa \
    -framework WebKit \
    -framework ApplicationServices \
    -framework CoreGraphics \
    -framework QuartzCore \
    -ObjC++ \
    -std=gnu++17 \
    -fobjc-arc \
    -fblocks \
    -Wno-deprecated-declarations \
    -I\"$SCRIPT_DIR\" \
    -I\"$SCRIPT_DIR/bridge/interface\" \
    -I\"$SCRIPT_DIR/bridge/macos\" \
    -I\"$SCRIPT_DIR/bridge/helpers\" \
    -I\"$SCRIPT_DIR/bridge/windows\" \
    -I\"$SCRIPT_DIR/bridge/views\" \
    -I\"$SCRIPT_DIR/bridge/adapters\" \
    -I\"$SCRIPT_DIR/bridge/managers\" \
    -I\"$SCRIPT_DIR/bridge/factory\" \
    -I\"$SCRIPT_DIR/../node_modules/node-addon-api\""

# Common implementation files
COMMON_IMPL="bridge/interface/Message.cpp \
    bridge/interface/MessageRouter.cpp \
    bridge/factory/BridgeFactory.cpp \
    bridge/helpers/ScriptInjector.mm \
    bridge/helpers/HTMLLoader.mm \
    bridge/helpers/PanelStyleHelper.mm \
    bridge/helpers/WebViewConfigHelper.mm \
    bridge/windows/BasePopupWindow.mm \
    bridge/windows/AcademiaNotificationsButton.mm \
    bridge/windows/AcademiaNotificationsPopup.mm \
    bridge/windows/OverallReviewButton.mm \
    bridge/windows/OverallReviewPopup.mm \
    bridge/views/NativeHeaderView.mm \
    bridge/views/ResizeHandleView.mm \
    bridge/views/AcceptingWebView.mm \
    bridge/adapters/MicrosoftWordAdapter.mm \
    bridge/managers/AcademiaManager.mm \
    bridge/macos/MacOSWebViewBridge.mm"

mkdir -p build

# Compile test executables
echo -e "${YELLOW}Step 1: Compiling test executables...${NC}"
echo ""

echo -e "  Compiling SimpleTests..."
eval clang++ $COMMON_FLAGS \
    -o build/SimpleTests \
    bridge/__tests__/SimpleTests.mm \
    $COMMON_IMPL

if [ $? -ne 0 ]; then
    echo -e "${RED}  ✗ SimpleTests compilation failed!${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ SimpleTests compiled${NC}"

echo -e "  Compiling MicrosoftWordAdapter tests..."
eval clang++ $COMMON_FLAGS \
    -o build/MicrosoftWordAdapterTests \
    bridge/adapters/MicrosoftWordAdapter.simple-test.mm \
    $COMMON_IMPL

if [ $? -ne 0 ]; then
    echo -e "${RED}  ✗ MicrosoftWordAdapter tests compilation failed!${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ MicrosoftWordAdapter tests compiled${NC}"

echo -e "  Compiling AcademiaManager tests..."
eval clang++ $COMMON_FLAGS \
    -o build/AcademiaManagerTests \
    bridge/managers/AcademiaManager.simple-test.mm \
    $COMMON_IMPL

if [ $? -ne 0 ]; then
    echo -e "${RED}  ✗ AcademiaManager tests compilation failed!${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ AcademiaManager tests compiled${NC}"

echo ""
echo -e "${GREEN}✓ All test executables compiled successfully${NC}"
echo ""

# Run all test suites
echo -e "${YELLOW}Step 2: Running test suites...${NC}"
echo ""

TOTAL_FAILED=0

# Run SimpleTests
echo -e "${YELLOW}Running SimpleTests...${NC}"
./build/SimpleTests
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ SimpleTests failed!${NC}"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
else
    echo -e "${GREEN}✓ SimpleTests passed!${NC}"
fi
echo ""

# Run MicrosoftWordAdapter tests
echo -e "${YELLOW}Running MicrosoftWordAdapter tests...${NC}"
./build/MicrosoftWordAdapterTests
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ MicrosoftWordAdapter tests failed!${NC}"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
else
    echo -e "${GREEN}✓ MicrosoftWordAdapter tests passed!${NC}"
fi
echo ""

# Run AcademiaManager tests
echo -e "${YELLOW}Running AcademiaManager tests...${NC}"
./build/AcademiaManagerTests
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ AcademiaManager tests failed!${NC}"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
else
    echo -e "${GREEN}✓ AcademiaManager tests passed!${NC}"
fi

echo ""
if [ $TOTAL_FAILED -eq 0 ]; then
    echo -e "${GREEN}======================================"
    echo -e "✓ All test suites passed!"
    echo -e "======================================${NC}"
else
    echo -e "${RED}======================================"
    echo -e "✗ $TOTAL_FAILED test suite(s) failed!"
    echo -e "======================================${NC}"
    exit 1
fi
