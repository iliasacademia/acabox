# Academia Electron - Agent Documentation

## Native Module Architecture

This application uses a native Objective-C++ module for MS Word text selection tracking. The native module provides:

- **Real-time selection detection** using macOS Accessibility APIs
- **Native button rendering** with NSWindow (< 5ms latency)
- **Hover popup** with selected text (< 1ms)
- **Scroll detection** with 50ms polling
- **App activation detection** to restore button when Word returns to foreground

### Native Resources

The module manages several macOS resources that require proper cleanup:

1. **AXObserver** - Accessibility notification observer
2. **NSTimer** (2 instances) - Position monitoring (50ms) and scroll debounce (300ms)
3. **NSWorkspace observer** - App activation notifications
4. **NSWindow** - Native button window with React popup (WKWebView)
5. **WKWebView** - WebKit view for rendering React UI
6. **WKScriptMessageHandler** - Message handler for React button clicks
7. **CFRunLoopSource** - Run loop source for accessibility events

## Proper Shutdown Procedure

### ⚠️ IMPORTANT: Always Graceful Shutdown

**Never force-kill the Electron app while selection tracking is active.** This can leave native resources in an uninterruptible state, creating zombie processes.

### Recommended Shutdown Steps

1. **Stop Selection Tracking First**
   - Click "Stop Selection Tracking" button in the app
   - Wait for confirmation that tracking has stopped
   - This ensures all native resources are released properly

2. **Then Quit the Application**
   - Use Cmd+Q or File > Quit
   - The app will trigger `before-quit` handler
   - Native module cleanup runs automatically

### What Happens During Cleanup

When `stopObserving()` is called:

```
1. Stop timers (synchronously on main thread)
   - Invalidate _scrollDebounceTimer
   - Invalidate _positionMonitorTimer

2. Hide and destroy button window with WKWebView cleanup
   - Stop WKWebView loading
   - Hide popup
   - Order out window
   - Close window
   - Remove WKScriptMessageHandler
   - Clear WKWebView navigation delegate

3. Remove notification observers
   - Remove NSWorkspace observer

4. Stop accessibility observer
   - Remove AX notifications
   - Remove from run loop
   - Release AXObserver

5. Clear state
   - Reset flags and stored text
```

## Troubleshooting

### Zombie Processes (UE State)

**Symptoms:**
- Electron process won't terminate
- Process shows `UE` status (uninterruptible sleep)
- `kill -9` doesn't work

**Cause:**
- Native resources weren't cleaned up before force-kill
- Run loop sources still active in kernel
- NSTimer or notification observer stuck in system call

**Solution:**

**Use the automated cleanup script (recommended):**
```bash
npm run cleanup
# or directly:
./cleanup.sh
```

The cleanup script will:
- Check for running processes
- Try graceful shutdown (SIGTERM)
- Try killall Electron
- Force kill with SIGKILL if needed
- Prompt for sudo if processes are stuck
- Show helpful error messages and next steps

**Manual cleanup steps:**

1. **First attempt - Clean killall:**
   ```bash
   killall Electron
   ```

2. **If that fails - Force with sudo:**
   ```bash
   sudo killall -9 Electron
   ```

3. **If still stuck - Restart required:**
   - The processes are stuck in kernel space
   - macOS restart is the only way to clear them
   - This is a known macOS issue with certain system calls

**Prevention:**
- Always use "Stop Selection Tracking" before quitting
- Never use `pkill -9` or `killall -9` while tracking is active
- Let the app quit gracefully with Cmd+Q

### App Window Not Responding

**Symptoms:**
- Window frozen after force-kill attempt
- Can't click buttons
- App appears running but unresponsive

**Cause:**
- Previous instance's native resources are blocking
- Zombie processes holding locks

**Solution:**

1. **Check for zombie processes:**
   ```bash
   ps aux | grep "academia-electron" | grep -v grep
   ```

2. **Kill them cleanly:**
   ```bash
   killall Electron
   sleep 3
   ```

3. **Restart the app:**
   ```bash
   npm start
   ```

### Button Not Appearing After Restart

**Possible causes:**
- Selection tracking wasn't stopped properly
- Native module state corrupted

**Solution:**
1. Stop selection tracking
2. Quit app completely (Cmd+Q)
3. Ensure no zombie processes (`ps aux | grep Electron`)
4. Restart app fresh

## Development Best Practices

### Testing Native Module Changes

When modifying `bridge.mm`:

1. **Stop tracking before rebuilding:**
   ```bash
   # In app: Click "Stop Selection Tracking"
   npm run build:native
   ```

2. **Always restart app after rebuild:**
   ```bash
   npm start
   ```

3. **Never hot-reload native modules** - full restart required

### Debugging Native Code

**Enable verbose logging:**
- Check console for `[SELECTION-TRACKER]` logs
- Native module logs appear in main process console
- Use `console.log()` in Objective-C++ with NSLog

**Common issues:**
- `dispatch_sync` deadlock - don't call from main thread
- Timer not invalidating - check timer is set to nil after invalidate
- Window not closing - ensure `close()` is called, not just `orderOut()`

## Architecture Notes

### Why dispatch_sync in stopObserving?

The `stopObserving` method uses `dispatch_sync(dispatch_get_main_queue())` to ensure synchronous cleanup:

```objc
dispatch_sync(dispatch_get_main_queue(), ^{
    // Stop timers and windows
});
```

This blocks the calling thread until all UI resources are destroyed, preventing race conditions where the app quits before cleanup completes.

### Why CFRunLoopRemoveSource?

Simply releasing the AXObserver isn't enough - the run loop source must be explicitly removed:

```objc
CFRunLoopRemoveSource(CFRunLoopGetCurrent(),
                     AXObserverGetRunLoopSource(_observer),
                     kCFRunLoopDefaultMode);
```

Without this, the run loop keeps running and the process can't terminate.

## Signal Handlers

The application now handles terminal signals for proper cleanup:

**Handled signals:**
- `SIGINT` - Ctrl+C in terminal → cleanup runs ✅
- `SIGTERM` - `kill <pid>` command → cleanup runs ✅
- `SIGHUP` - Terminal window closed → cleanup runs ✅

**Not handled:**
- `SIGKILL` (`kill -9`) - Cannot be caught, cleanup skipped ❌

When any handled signal is received:
1. Logs the signal type
2. Calls `stopObserving()` to clean up native resources
3. Exits with code 0

This means **Ctrl+C in terminal now safely stops the app** without leaving zombie processes!

## Testing Cleanup

### Automated Test Script

To verify proper cleanup after changes to native code:

```bash
npm run test:cleanup
```

This script automatically tests:
- ✅ SIGINT (Ctrl+C) cleanup
- ✅ SIGTERM shutdown cleanup
- ✅ Cleanup script functionality
- ✅ Zombie process detection (UE state)
- ✅ Complete resource release

**When to run:**
- After modifying `bridge.mm`
- After changing window management code
- After updating WKWebView handling
- Before committing native code changes

**What it does:**
1. Starts the app in background
2. Sends various termination signals
3. Verifies all processes terminate within 10 seconds
4. Checks for zombie processes (UE state)
5. Reports pass/fail for each test

Example output:
```
================================================
Native Resource Cleanup Test
================================================

Test 1: Checking initial state...
✓ PASS: No existing Electron processes

Test 2: Testing graceful shutdown (SIGINT)...
App started (found 4 processes)
Sending SIGINT (simulating Ctrl+C)...
✓ PASS: All processes cleaned up gracefully
✓ PASS: No zombie processes

...

================================================
ALL TESTS PASSED
================================================
```

## Summary

✅ **DO:**
- Use Ctrl+C in terminal (now safe!)
- Use Cmd+Q for graceful shutdown
- Let cleanup handlers run
- Use `npm run cleanup` if processes get stuck
- Run `npm run test:cleanup` after native code changes

❌ **DON'T:**
- Force-kill with `kill -9` (cleanup can't run)
- Hot-reload native modules
- Use `killall -9` unnecessarily
- Skip cleanup tests after modifying `bridge.mm`

Following these practices prevents zombie processes and ensures clean app lifecycle.
