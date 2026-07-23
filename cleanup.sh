#!/bin/bash

# Acabox Cleanup Script
# Safely shuts down the app and cleans up native resources
# Use this when the app won't quit normally or has zombie processes

set -e

echo "🧹 Acabox Cleanup Script"
echo "===================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if processes exist
check_processes() {
    local count=$(ps aux | grep -E "Acabox.app/Contents/MacOS|Desktop-app-without-container/node_modules/electron" | grep -v grep | grep -v cleanup.sh | wc -l | tr -d ' ')
    echo $count
}

# Function to show running processes
show_processes() {
    echo -e "${YELLOW}Current Electron processes:${NC}"
    ps aux | grep -E "Acabox.app/Contents/MacOS|Desktop-app-without-container/node_modules/electron" | grep -v grep | grep -v cleanup.sh || echo "  None found"
    echo ""
}

# Step 1: Check current state
echo "📊 Step 1: Checking current state..."
INITIAL_COUNT=$(check_processes)
if [ "$INITIAL_COUNT" -eq "0" ]; then
    echo -e "${GREEN}✓ No processes running - already clean!${NC}"
    exit 0
fi

echo -e "${YELLOW}⚠ Found $INITIAL_COUNT process(es) running${NC}"
show_processes

# Step 2: Try graceful shutdown (SIGTERM)
echo "🛑 Step 2: Attempting graceful shutdown (SIGTERM)..."
pkill -TERM -f "Acabox.app/Contents/MacOS|Desktop-app-without-container/node_modules/electron" 2>/dev/null || true
sleep 3

AFTER_TERM=$(check_processes)
if [ "$AFTER_TERM" -eq "0" ]; then
    echo -e "${GREEN}✓ Graceful shutdown successful!${NC}"
    exit 0
fi

echo -e "${YELLOW}⚠ Still $AFTER_TERM process(es) running after SIGTERM${NC}"

# Step 3: Force-kill fork survivors (SIGTERM, scoped to Acabox)
echo "🔨 Step 3: Attempting scoped pkill of Acabox processes..."
pkill -f "Acabox.app/Contents/MacOS|Desktop-app-without-container/node_modules/electron" 2>/dev/null || true
sleep 3

AFTER_KILLALL=$(check_processes)
if [ "$AFTER_KILLALL" -eq "0" ]; then
    echo -e "${GREEN}✓ Processes terminated!${NC}"
    exit 0
fi

echo -e "${YELLOW}⚠ Still $AFTER_KILLALL process(es) running${NC}"

# Step 4: Force kill with SIGKILL
echo "💥 Step 4: Force killing with SIGKILL..."
pkill -9 -f "Acabox.app/Contents/MacOS|Desktop-app-without-container/node_modules/electron" 2>/dev/null || true
pkill -9 -f "Acabox.app/Contents/MacOS|Desktop-app-without-container/node_modules/electron" 2>/dev/null || true
sleep 3

AFTER_KILL9=$(check_processes)
if [ "$AFTER_KILL9" -eq "0" ]; then
    echo -e "${GREEN}✓ Processes force-killed successfully!${NC}"
    exit 0
fi

# Step 5: Check if in uninterruptible state
echo -e "${RED}⚠️  WARNING: Found zombie processes in uninterruptible state${NC}"
show_processes

echo ""
echo "These processes are stuck in kernel space (UE state)."
echo "This typically happens when native resources weren't cleaned up properly."
echo ""
echo "Recommended actions:"
echo "  1. Try: sudo pkill -9 -f "Acabox.app/Contents/MacOS""
echo "  2. If that fails, restart your Mac"
echo ""
echo "To prevent this in the future:"
echo "  - Always click 'Stop Selection Tracking' before quitting"
echo "  - Use Cmd+Q to quit gracefully"
echo "  - See AGENTS.md for more details"
echo ""

# Try sudo as last resort
read -p "Try sudo pkill -9 -f Acabox? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🔐 Attempting sudo kill..."
    sudo pkill -9 -f "Acabox.app/Contents/MacOS|Desktop-app-without-container/node_modules/electron" 2>/dev/null || true
    sleep 3

    FINAL_COUNT=$(check_processes)
    if [ "$FINAL_COUNT" -eq "0" ]; then
        echo -e "${GREEN}✓ Processes killed with sudo!${NC}"
        exit 0
    else
        echo -e "${RED}✗ Processes still stuck - Mac restart required${NC}"
        exit 1
    fi
else
    echo "Cleanup incomplete. You may need to restart your Mac."
    exit 1
fi
