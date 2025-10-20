#!/bin/bash

# Test script for native resource cleanup
# Verifies that Electron processes are properly cleaned up without leaving zombies

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "================================================"
echo "Native Resource Cleanup Test"
echo "================================================"
echo ""

# Function to check for Electron processes
check_processes() {
    # Look for processes with our project directory path in them
    local process_count=$(ps aux | grep "Desktop/Academia/academia-electron" | grep -v grep | grep -v "test-cleanup" | wc -l | tr -d ' ')
    echo "$process_count"
}

# Function to check for zombie processes (UE state)
check_zombies() {
    local zombie_count=$(ps aux | grep -i "electron" | grep -v grep | grep " UE " | wc -l | tr -d ' ')
    echo "$zombie_count"
}

# Function to wait for processes to terminate
wait_for_cleanup() {
    local max_wait=$1
    local waited=0

    while [ $waited -lt $max_wait ]; do
        local count=$(check_processes)
        if [ "$count" -eq "0" ]; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done

    return 1
}

# Test 1: Check initial state
echo "Test 1: Checking initial state..."
initial_count=$(check_processes)
if [ "$initial_count" -gt "0" ]; then
    echo -e "${RED}✗ FAIL${NC}: Found $initial_count existing Electron processes"
    echo "Please stop all Electron processes before running this test:"
    echo "  npm run cleanup"
    exit 1
fi
echo -e "${GREEN}✓ PASS${NC}: No existing Electron processes"
echo ""

# Test 2: Start and graceful shutdown (Ctrl+C)
echo "Test 2: Testing graceful shutdown (SIGINT)..."
echo "Starting app in background..."
npm start > /dev/null 2>&1 &
APP_PID=$!

# Wait for app to start (check for Electron processes)
sleep 8
running_count=$(check_processes)
if [ "$running_count" -eq "0" ]; then
    echo -e "${RED}✗ FAIL${NC}: App failed to start"
    exit 1
fi
echo "App started (found $running_count processes)"

# Send SIGINT (Ctrl+C) to all Electron processes
echo "Sending SIGINT (simulating Ctrl+C)..."
# Use pkill to send to all matching processes
pkill -INT -f "Desktop/Academia/academia-electron" 2>/dev/null || true

# Wait for cleanup (15 seconds to allow all processes to terminate)
if wait_for_cleanup 15; then
    echo -e "${GREEN}✓ PASS${NC}: All processes cleaned up gracefully"
else
    remaining=$(check_processes)
    echo -e "${RED}✗ FAIL${NC}: $remaining processes still running after 10 seconds"
    echo "Processes:"
    ps aux | grep -i "electron" | grep -v grep | grep -v "test-cleanup"
    exit 1
fi

# Check for zombies
zombie_count=$(check_zombies)
if [ "$zombie_count" -gt "0" ]; then
    echo -e "${RED}✗ FAIL${NC}: Found $zombie_count zombie processes (UE state)"
    exit 1
fi
echo -e "${GREEN}✓ PASS${NC}: No zombie processes"
echo ""

# Wait between tests to ensure full cleanup
echo "Waiting for system to settle..."
sleep 5

# Test 3: Cleanup script test
echo "Test 3: Testing cleanup script..."
echo "Starting app in background..."
npm start > /dev/null 2>&1 &
APP_PID=$!

sleep 8
running_count=$(check_processes)
if [ "$running_count" -eq "0" ]; then
    echo -e "${RED}✗ FAIL${NC}: App failed to start"
    exit 1
fi
echo "App started (found $running_count processes)"

# Use cleanup script
echo "Running cleanup script..."
./cleanup.sh

# Wait for cleanup
sleep 3
remaining=$(check_processes)
if [ "$remaining" -eq "0" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Cleanup script successfully stopped all processes"
else
    echo -e "${RED}✗ FAIL${NC}: $remaining processes still running after cleanup"
    exit 1
fi
echo ""

# Final summary
echo "================================================"
echo -e "${GREEN}ALL TESTS PASSED${NC}"
echo "================================================"
echo ""
echo "Summary:"
echo "  ✓ Initial state clean"
echo "  ✓ SIGINT (Ctrl+C) cleanup works"
echo "  ✓ Cleanup script works"
echo "  ✓ No zombie processes created"
echo ""
echo "Native resource cleanup is working correctly!"
