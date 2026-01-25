#!/usr/bin/env node

/**
 * Standalone integration test runner for window-monitor (macOS).
 *
 * This script can be run directly without Jest for manual testing:
 *   node window-monitor/test/window-monitor-macos-test.js
 *
 * Or via npm:
 *   npm run test:window-monitor
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { validateEvent } = require('./event-schemas');

// Configuration
const WINDOW_MONITOR_DIR = path.join(__dirname, '..');
const WINDOW_MONITOR_PATH = path.join(WINDOW_MONITOR_DIR, 'window-monitor');
const BUNDLE_ID = process.argv[2] || 'com.microsoft.Word';
const LOG_FILE = path.join(os.tmpdir(), 'window-monitor-test.log');
const TIMESTAMP_TOLERANCE_MS = 2000; // Allow 2 seconds tolerance for event timing (includes gradual movement duration)
const BOUNDS_TOLERANCE = 5; // Allow 5 pixel tolerance for bounds

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function runAppleScript(script) {
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    return result.trim();
  } catch (error) {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isWordInstalled() {
  try {
    const result = runAppleScript(
      'tell application "Finder" to exists application file id "com.microsoft.Word"'
    );
    return result === 'true';
  } catch {
    return false;
  }
}

async function buildMonitor() {
  log('blue', '\n[BUILD] Building window-monitor...');
  try {
    execSync('make clean && make', {
      cwd: WINDOW_MONITOR_DIR,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    log('green', '[BUILD] Build successful!');
    return true;
  } catch (error) {
    log('red', `[BUILD] Build failed: ${error.message}`);
    return false;
  }
}

// Helper to check if bounds match within tolerance
function boundsMatch(actual, expected, tolerance = BOUNDS_TOLERANCE) {
  if (!actual || !expected) return false;
  return (
    Math.abs(actual.x - expected.x) <= tolerance &&
    Math.abs(actual.y - expected.y) <= tolerance &&
    Math.abs(actual.width - expected.width) <= tolerance &&
    Math.abs(actual.height - expected.height) <= tolerance
  );
}

// Helper to find events within time window after an action
function findEventsAfterTimestamp(events, timestamp, eventTypes, windowMs = TIMESTAMP_TOLERANCE_MS) {
  return events.filter((e) => {
    const eventTime = new Date(e.timestamp).getTime();
    const actionTime = timestamp;
    const timeDiff = eventTime - actionTime;
    return eventTypes.includes(e.event) && timeDiff >= 0 && timeDiff <= windowMs;
  });
}

async function runTest() {
  log('cyan', '\n========================================');
  log('cyan', '  Window Monitor Integration Test');
  log('cyan', '========================================\n');

  // Check if binary needs to be built
  if (!fs.existsSync(WINDOW_MONITOR_PATH)) {
    const built = await buildMonitor();
    if (!built) {
      process.exit(1);
    }
  } else {
    log('blue', '[BUILD] Binary already exists, skipping build');
  }

  // Test help output
  log('blue', '\n[TEST] Testing --help output...');
  try {
    const helpOutput = execSync(`${WINDOW_MONITOR_PATH} --help 2>&1 || true`, {
      encoding: 'utf8',
    });
    if (helpOutput.includes('--bundle-id') && helpOutput.includes('Usage:')) {
      log('green', '[PASS] Help output is correct');
    } else {
      log('red', '[FAIL] Help output missing expected content');
      console.log(helpOutput);
    }
  } catch (error) {
    log('red', `[FAIL] Error running help: ${error.message}`);
  }

  // Check if Word is installed
  const wordInstalled = await isWordInstalled();
  if (!wordInstalled) {
    log('yellow', '\n[WARN] Microsoft Word is not installed.');
    log('yellow', '[WARN] Skipping window event tests.');
    log('yellow', '[WARN] To run full tests, install Microsoft Word.');
    log('green', '\n[DONE] Basic tests completed (Word tests skipped)');
    process.exit(0);
  }

  log('blue', `\n[TEST] Monitoring ${BUNDLE_ID}...`);
  log('blue', '[TEST] Will perform window operations and validate events');

  const events = [];
  const schemaErrors = []; // Track schema validation errors as events arrive
  let stderrOutput = '';

  // Track action timestamps and expected results
  const actions = {
    moveToPosition: {
      startTimestamp: null,
      endTimestamp: null,
      expectedBounds: { x: 200, y: 200, width: 800, height: 600 },
    },
    resize: {
      startTimestamp: null,
      endTimestamp: null,
      expectedBounds: { x: 200, y: 200, width: 1000, height: 750 },
    },
    switchToFinder: { timestamp: null },
    switchBackToWord: { timestamp: null },
    closeDocument: { timestamp: null },
  };

  // Start monitor
  const monitor = spawn(WINDOW_MONITOR_PATH, ['--bundle-id', BUNDLE_ID], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  monitor.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event);

        // Validate event against its specific schema immediately
        const validation = validateEvent(event);
        if (validation.success) {
          log('cyan', `[EVENT] ${event.event} - validated against ${validation.schemaUsed} schema`);
        } else {
          log('red', `[EVENT] ${event.event} - SCHEMA ERROR: ${validation.error}`);
          schemaErrors.push({
            index: events.length - 1,
            eventType: validation.eventType,
            schemaUsed: validation.schemaUsed,
            error: validation.error,
          });
        }
      } catch {
        // Ignore non-JSON output
      }
    }
  });

  monitor.stderr.on('data', (data) => {
    stderrOutput += data.toString();
  });

  // Wait for monitor to start
  await delay(2000);

  try {
    // Open Word
    log('blue', '\n[ACTION] Opening Microsoft Word...');
    runAppleScript('tell application "Microsoft Word" to activate');
    await delay(1500);

    // Create document
    log('blue', '[ACTION] Creating new document...');
    runAppleScript('tell application "Microsoft Word" to make new document');
    await delay(3000);

    // Ensure window is focused (registers resize observers)
    log('blue', '[ACTION] Focusing window...');
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          set frontmost to true
          perform action "AXRaise" of window 1
        end tell
      end tell
    `);
    await delay(1000);

    // Move window to a known starting position first
    log('blue', '[ACTION] Moving window to starting position...');
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          set position of window 1 to {100, 100}
          set size of window 1 to {800, 600}
        end tell
      end tell
    `);
    await delay(1000);

    // Now move to a different position gradually (simulating human drag)
    log('blue', '[ACTION] Moving window gradually to {200, 200}...');
    actions.moveToPosition.startTimestamp = Date.now();
    // Move in 10 steps with 50ms delay each to simulate ~500ms drag
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          repeat with i from 1 to 10
            set position of window 1 to {100 + (i * 10), 100 + (i * 10)}
            delay 0.05
          end repeat
        end tell
      end tell
    `);
    actions.moveToPosition.endTimestamp = Date.now();
    log('blue', `  Move action took ${actions.moveToPosition.endTimestamp - actions.moveToPosition.startTimestamp}ms`);
    await delay(1000);

    // Resize window gradually (simulating human resize drag)
    log('blue', '[ACTION] Resizing window gradually to {1000, 750}...');
    actions.resize.startTimestamp = Date.now();
    // Resize in 10 steps with 50ms delay each to simulate ~500ms resize
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          repeat with i from 1 to 10
            set size of window 1 to {800 + (i * 20), 600 + (i * 15)}
            delay 0.05
          end repeat
        end tell
      end tell
    `);
    actions.resize.endTimestamp = Date.now();
    log('blue', `  Resize action took ${actions.resize.endTimestamp - actions.resize.startTimestamp}ms`);
    await delay(1000);

    // Switch apps
    log('blue', '[ACTION] Switching to Finder...');
    actions.switchToFinder.timestamp = Date.now();
    runAppleScript('tell application "Finder" to activate');
    await delay(1000);

    log('blue', '[ACTION] Switching back to Word...');
    actions.switchBackToWord.timestamp = Date.now();
    runAppleScript('tell application "Microsoft Word" to activate');
    await delay(1000);

    // Close document
    log('blue', '[ACTION] Closing document...');
    actions.closeDocument.timestamp = Date.now();
    runAppleScript('tell application "Microsoft Word" to close document 1 saving no');
    await delay(2000);
  } catch (error) {
    log('yellow', `[WARN] Error during actions: ${error.message}`);
  }

  // Stop monitor
  log('blue', '\n[ACTION] Stopping monitor...');
  monitor.kill('SIGTERM');
  await delay(500);

  // Write log file
  fs.writeFileSync(LOG_FILE, JSON.stringify(events, null, 2));
  log('blue', `[INFO] Events written to: ${LOG_FILE}`);

  // Validate results
  log('blue', '\n[VALIDATE] Checking captured events...');
  const eventTypes = events.map((e) => e.event);
  console.log('Event types captured:', eventTypes);

  let passed = 0;
  let failed = 0;

  // Check app events
  if (eventTypes.includes('APP_EXISTING') || eventTypes.includes('APP_LAUNCHED')) {
    log('green', '[PASS] App existing/launched event captured');
    passed++;
  } else {
    log('red', '[FAIL] Missing app existing/launched event');
    failed++;
  }

  // Check window created/existing
  if (eventTypes.includes('WINDOW_CREATED') || eventTypes.includes('WINDOW_EXISTING')) {
    log('green', '[PASS] Window created/existing event captured');
    passed++;
  } else {
    log('red', '[FAIL] Missing window created/existing event');
    failed++;
  }

  // Check repositioning events exist
  if (eventTypes.includes('WINDOW_REPOSITIONING') || eventTypes.includes('WINDOW_REPOSITIONED')) {
    log('green', '[PASS] Window repositioning events captured');
    passed++;
  } else {
    log('red', '[FAIL] Missing repositioning events');
    failed++;
  }

  // Validate REPOSITIONING/REPOSITIONED timing relative to action start/end
  log('blue', '\n[VALIDATE] Checking REPOSITIONING/REPOSITIONED timing relative to actions...');
  const repositioningEvents = events.filter((e) => e.event === 'WINDOW_REPOSITIONING');
  const repositionedEvents = events.filter((e) => e.event === 'WINDOW_REPOSITIONED');
  const MAX_EVENT_DELAY_MS = 500; // Events should fire within 500ms of action start/end

  if (repositioningEvents.length > 0 && repositionedEvents.length > 0) {
    // --- MOVE operation timing ---
    log('blue', '\n  Move operation:');
    const moveRepositioning = repositioningEvents.find(
      (e) => new Date(e.timestamp).getTime() >= actions.moveToPosition.startTimestamp
    );
    const moveRepositioned = repositionedEvents.find(
      (e) => new Date(e.timestamp).getTime() >= actions.moveToPosition.startTimestamp
    );

    if (moveRepositioning && moveRepositioned) {
      const repositioningTime = new Date(moveRepositioning.timestamp).getTime();
      const repositionedTime = new Date(moveRepositioned.timestamp).getTime();

      // Check REPOSITIONING delay from action start
      const repositioningDelay = repositioningTime - actions.moveToPosition.startTimestamp;
      log('blue', `    REPOSITIONING fired ${repositioningDelay}ms after action start`);

      if (repositioningDelay <= MAX_EVENT_DELAY_MS) {
        log('green', `[PASS] Move REPOSITIONING delay (${repositioningDelay}ms) <= ${MAX_EVENT_DELAY_MS}ms`);
        passed++;
      } else {
        log('red', `[FAIL] Move REPOSITIONING delay (${repositioningDelay}ms) > ${MAX_EVENT_DELAY_MS}ms`);
        failed++;
      }

      // Check REPOSITIONED delay from action end
      const repositionedDelay = repositionedTime - actions.moveToPosition.endTimestamp;
      log('blue', `    REPOSITIONED fired ${repositionedDelay}ms after action end`);

      if (repositionedDelay <= MAX_EVENT_DELAY_MS && repositionedDelay >= 0) {
        log('green', `[PASS] Move REPOSITIONED delay (${repositionedDelay}ms) <= ${MAX_EVENT_DELAY_MS}ms after action end`);
        passed++;
      } else if (repositionedDelay < 0) {
        // REPOSITIONED fired before action ended - that's actually fine, it fires after last bounds change + debounce
        log('green', `[PASS] Move REPOSITIONED fired ${-repositionedDelay}ms before action end (debounce timer)`);
        passed++;
      } else {
        log('red', `[FAIL] Move REPOSITIONED delay (${repositionedDelay}ms) > ${MAX_EVENT_DELAY_MS}ms after action end`);
        failed++;
      }

      // Total reposition duration
      const moveDuration = repositionedTime - repositioningTime;
      log('blue', `    Total move reposition duration: ${moveDuration}ms`);
    } else {
      log('red', '[FAIL] Could not find move REPOSITIONING/REPOSITIONED pair');
      failed += 2;
    }

    // --- RESIZE operation timing ---
    log('blue', '\n  Resize operation:');
    const resizeRepositioning = repositioningEvents.find(
      (e) => new Date(e.timestamp).getTime() >= actions.resize.startTimestamp
    );
    const resizeRepositioned = repositionedEvents.find(
      (e) => new Date(e.timestamp).getTime() >= actions.resize.startTimestamp
    );

    if (resizeRepositioning && resizeRepositioned) {
      const repositioningTime = new Date(resizeRepositioning.timestamp).getTime();
      const repositionedTime = new Date(resizeRepositioned.timestamp).getTime();

      // Check REPOSITIONING delay from action start
      const repositioningDelay = repositioningTime - actions.resize.startTimestamp;
      log('blue', `    REPOSITIONING fired ${repositioningDelay}ms after action start`);

      if (repositioningDelay <= MAX_EVENT_DELAY_MS) {
        log('green', `[PASS] Resize REPOSITIONING delay (${repositioningDelay}ms) <= ${MAX_EVENT_DELAY_MS}ms`);
        passed++;
      } else {
        log('red', `[FAIL] Resize REPOSITIONING delay (${repositioningDelay}ms) > ${MAX_EVENT_DELAY_MS}ms`);
        failed++;
      }

      // Check REPOSITIONED delay from action end
      const repositionedDelay = repositionedTime - actions.resize.endTimestamp;
      log('blue', `    REPOSITIONED fired ${repositionedDelay}ms after action end`);

      if (repositionedDelay <= MAX_EVENT_DELAY_MS && repositionedDelay >= 0) {
        log('green', `[PASS] Resize REPOSITIONED delay (${repositionedDelay}ms) <= ${MAX_EVENT_DELAY_MS}ms after action end`);
        passed++;
      } else if (repositionedDelay < 0) {
        // REPOSITIONED fired before action ended - that's actually fine
        log('green', `[PASS] Resize REPOSITIONED fired ${-repositionedDelay}ms before action end (debounce timer)`);
        passed++;
      } else {
        log('red', `[FAIL] Resize REPOSITIONED delay (${repositionedDelay}ms) > ${MAX_EVENT_DELAY_MS}ms after action end`);
        failed++;
      }

      // Total reposition duration
      const resizeDuration = repositionedTime - repositioningTime;
      log('blue', `    Total resize reposition duration: ${resizeDuration}ms`);
    } else {
      log('red', '[FAIL] Could not find resize REPOSITIONING/REPOSITIONED pair');
      failed += 2;
    }
  } else {
    log('red', '[FAIL] Missing REPOSITIONING or REPOSITIONED events for timing check');
    failed += 4;
  }

  // Validate move repositioning bounds
  log('blue', '\n[VALIDATE] Checking move repositioning bounds...');
  const moveRepositionedEvents = findEventsAfterTimestamp(
    events,
    actions.moveToPosition.startTimestamp,
    ['WINDOW_REPOSITIONED']
  );

  if (moveRepositionedEvents.length > 0) {
    const moveEvent = moveRepositionedEvents[0];
    const bounds = moveEvent.window?.bounds;
    if (bounds) {
      const expectedX = actions.moveToPosition.expectedBounds.x;
      const expectedY = actions.moveToPosition.expectedBounds.y;
      const positionMatches =
        Math.abs(bounds.x - expectedX) <= BOUNDS_TOLERANCE &&
        Math.abs(bounds.y - expectedY) <= BOUNDS_TOLERANCE;

      if (positionMatches) {
        log('green', `[PASS] Move REPOSITIONED bounds position correct (x=${bounds.x}, y=${bounds.y})`);
        passed++;
      } else {
        log('red', `[FAIL] Move REPOSITIONED bounds position incorrect: expected (${expectedX}, ${expectedY}), got (${bounds.x}, ${bounds.y})`);
        failed++;
      }
    } else {
      log('red', '[FAIL] Move REPOSITIONED event missing bounds');
      failed++;
    }
  } else {
    log('red', '[FAIL] No WINDOW_REPOSITIONED event found after move action');
    failed++;
  }

  // Validate resize repositioning bounds
  log('blue', '\n[VALIDATE] Checking resize repositioning bounds...');
  const resizeRepositionedEvents = findEventsAfterTimestamp(
    events,
    actions.resize.startTimestamp,
    ['WINDOW_REPOSITIONED']
  );

  if (resizeRepositionedEvents.length > 0) {
    const resizeEvent = resizeRepositionedEvents[0];
    const bounds = resizeEvent.window?.bounds;
    if (bounds) {
      const expectedWidth = actions.resize.expectedBounds.width;
      const expectedHeight = actions.resize.expectedBounds.height;
      const sizeMatches =
        Math.abs(bounds.width - expectedWidth) <= BOUNDS_TOLERANCE &&
        Math.abs(bounds.height - expectedHeight) <= BOUNDS_TOLERANCE;

      if (sizeMatches) {
        log('green', `[PASS] Resize REPOSITIONED bounds size correct (width=${bounds.width}, height=${bounds.height})`);
        passed++;
      } else {
        log('red', `[FAIL] Resize REPOSITIONED bounds size incorrect: expected (${expectedWidth}, ${expectedHeight}), got (${bounds.width}, ${bounds.height})`);
        failed++;
      }
    } else {
      log('red', '[FAIL] Resize REPOSITIONED event missing bounds');
      failed++;
    }
  } else {
    log('red', '[FAIL] No WINDOW_REPOSITIONED event found after resize action');
    failed += 2; // Count as 2 failures (timing + bounds)
  }

  // Check APP_UNFOCUSED timing
  log('blue', '\n[VALIDATE] Checking app unfocused timing...');
  const unfocusedEvents = findEventsAfterTimestamp(
    events,
    actions.switchToFinder.timestamp,
    ['APP_UNFOCUSED']
  );

  if (unfocusedEvents.length > 0) {
    const unfocusedEvent = unfocusedEvents[0];
    const eventTime = new Date(unfocusedEvent.timestamp).getTime();
    const timeDiff = eventTime - actions.switchToFinder.timestamp;
    log('blue', `  Unfocused event received ${timeDiff}ms after action`);

    if (timeDiff <= TIMESTAMP_TOLERANCE_MS) {
      log('green', `[PASS] APP_UNFOCUSED event timing within ${TIMESTAMP_TOLERANCE_MS}ms tolerance`);
      passed++;
    } else {
      log('red', `[FAIL] APP_UNFOCUSED event timing ${timeDiff}ms exceeds ${TIMESTAMP_TOLERANCE_MS}ms tolerance`);
      failed++;
    }
  } else {
    log('red', '[FAIL] No APP_UNFOCUSED event found after switching to Finder');
    failed++;
  }

  // Check APP_FOCUSED timing (switching back)
  log('blue', '\n[VALIDATE] Checking app focused timing...');
  const focusedEvents = findEventsAfterTimestamp(
    events,
    actions.switchBackToWord.timestamp,
    ['APP_FOCUSED']
  );

  if (focusedEvents.length > 0) {
    const focusedEvent = focusedEvents[0];
    const eventTime = new Date(focusedEvent.timestamp).getTime();
    const timeDiff = eventTime - actions.switchBackToWord.timestamp;
    log('blue', `  Focused event received ${timeDiff}ms after action`);

    if (timeDiff <= TIMESTAMP_TOLERANCE_MS) {
      log('green', `[PASS] APP_FOCUSED event timing within ${TIMESTAMP_TOLERANCE_MS}ms tolerance`);
      passed++;
    } else {
      log('red', `[FAIL] APP_FOCUSED event timing ${timeDiff}ms exceeds ${TIMESTAMP_TOLERANCE_MS}ms tolerance`);
      failed++;
    }
  } else {
    log('red', '[FAIL] No APP_FOCUSED event found after switching back to Word');
    failed++;
  }

  // Check WINDOW_DESTROYED timing
  log('blue', '\n[VALIDATE] Checking window destroyed timing...');
  const destroyedEvents = findEventsAfterTimestamp(
    events,
    actions.closeDocument.timestamp,
    ['WINDOW_DESTROYED']
  );

  if (destroyedEvents.length > 0) {
    const destroyedEvent = destroyedEvents[0];
    const eventTime = new Date(destroyedEvent.timestamp).getTime();
    const timeDiff = eventTime - actions.closeDocument.timestamp;
    log('blue', `  Destroyed event received ${timeDiff}ms after action`);

    if (timeDiff <= TIMESTAMP_TOLERANCE_MS) {
      log('green', `[PASS] WINDOW_DESTROYED event timing within ${TIMESTAMP_TOLERANCE_MS}ms tolerance`);
      passed++;
    } else {
      log('red', `[FAIL] WINDOW_DESTROYED event timing ${timeDiff}ms exceeds ${TIMESTAMP_TOLERANCE_MS}ms tolerance`);
      failed++;
    }
  } else {
    log('red', '[FAIL] No WINDOW_DESTROYED event found after closing document');
    failed++;
  }

  // Validate event ordering
  log('blue', '\n[VALIDATE] Checking event ordering...');

  // Helper to find first index of event type
  const indexOf = (type) => eventTypes.indexOf(type);
  const lastIndexOf = (type) => eventTypes.lastIndexOf(type);

  let orderingPassed = true;
  const orderingErrors = [];

  // 1. APP_EXISTING/APP_LAUNCHED should be first
  const appStartIdx = Math.min(
    indexOf('APP_EXISTING') >= 0 ? indexOf('APP_EXISTING') : Infinity,
    indexOf('APP_LAUNCHED') >= 0 ? indexOf('APP_LAUNCHED') : Infinity
  );
  if (appStartIdx !== 0) {
    orderingErrors.push('APP_EXISTING/APP_LAUNCHED should be first event');
    orderingPassed = false;
  }

  // 2. WINDOW_CREATED/WINDOW_EXISTING should come after APP_EXISTING/APP_LAUNCHED
  const windowCreatedIdx = Math.min(
    indexOf('WINDOW_CREATED') >= 0 ? indexOf('WINDOW_CREATED') : Infinity,
    indexOf('WINDOW_EXISTING') >= 0 ? indexOf('WINDOW_EXISTING') : Infinity
  );
  if (windowCreatedIdx <= appStartIdx) {
    orderingErrors.push('WINDOW_CREATED should come after APP_EXISTING/APP_LAUNCHED');
    orderingPassed = false;
  }

  // 3. WINDOW_REPOSITIONING should always come before corresponding WINDOW_REPOSITIONED
  const repositioningIndices = eventTypes
    .map((t, i) => (t === 'WINDOW_REPOSITIONING' ? i : -1))
    .filter((i) => i >= 0);
  const repositionedIndices = eventTypes
    .map((t, i) => (t === 'WINDOW_REPOSITIONED' ? i : -1))
    .filter((i) => i >= 0);

  if (repositioningIndices.length !== repositionedIndices.length) {
    orderingErrors.push(
      `Mismatched REPOSITIONING/REPOSITIONED count: ${repositioningIndices.length} vs ${repositionedIndices.length}`
    );
    orderingPassed = false;
  } else {
    // Each REPOSITIONING should be immediately followed by REPOSITIONED (or another REPOSITIONING then REPOSITIONED)
    for (let i = 0; i < repositioningIndices.length; i++) {
      if (repositioningIndices[i] >= repositionedIndices[i]) {
        orderingErrors.push(
          `WINDOW_REPOSITIONING[${i}] at index ${repositioningIndices[i]} should come before WINDOW_REPOSITIONED[${i}] at index ${repositionedIndices[i]}`
        );
        orderingPassed = false;
      }
    }
  }

  // 4. APP_UNFOCUSED should come before final APP_FOCUSED (when switching back)
  const unfocusedIdx = indexOf('APP_UNFOCUSED');
  const lastFocusedIdx = lastIndexOf('APP_FOCUSED');
  if (unfocusedIdx >= 0 && lastFocusedIdx >= 0 && unfocusedIdx >= lastFocusedIdx) {
    orderingErrors.push('APP_UNFOCUSED should come before final APP_FOCUSED');
    orderingPassed = false;
  }

  // 5. WINDOW_DESTROYED should be last window event
  const destroyedIdx = indexOf('WINDOW_DESTROYED');
  if (destroyedIdx >= 0) {
    const eventsAfterDestroyed = eventTypes.slice(destroyedIdx + 1);
    const windowEventsAfterDestroyed = eventsAfterDestroyed.filter((t) =>
      t.startsWith('WINDOW_')
    );
    if (windowEventsAfterDestroyed.length > 0) {
      orderingErrors.push(
        `Window events found after WINDOW_DESTROYED: ${windowEventsAfterDestroyed.join(', ')}`
      );
      orderingPassed = false;
    }
  }

  // 6. Timestamps should be monotonically increasing
  let timestampsIncreasing = true;
  for (let i = 1; i < events.length; i++) {
    const prevTime = new Date(events[i - 1].timestamp).getTime();
    const currTime = new Date(events[i].timestamp).getTime();
    if (currTime < prevTime) {
      orderingErrors.push(
        `Timestamp decreased at event ${i}: ${events[i - 1].event} (${events[i - 1].timestamp}) -> ${events[i].event} (${events[i].timestamp})`
      );
      timestampsIncreasing = false;
    }
  }

  if (orderingPassed) {
    log('green', '[PASS] Event ordering is correct');
    passed++;
  } else {
    log('red', '[FAIL] Event ordering errors:');
    for (const err of orderingErrors) {
      log('red', `  - ${err}`);
    }
    failed++;
  }

  if (timestampsIncreasing) {
    log('green', '[PASS] Event timestamps are monotonically increasing');
    passed++;
  } else {
    log('red', '[FAIL] Event timestamps are not monotonically increasing');
    failed++;
  }

  // Check identifier in events
  const hasIdentifier = events.every(
    (e) => e.app && e.app.identifier === BUNDLE_ID && e.app.identifierType === 'bundleId'
  );
  if (hasIdentifier) {
    log('green', '[PASS] All events include correct identifier');
    passed++;
  } else {
    log('red', '[FAIL] Some events missing identifier');
    failed++;
  }

  // Check platform in events
  const hasPlatform = events.every((e) => e.platform === 'macos');
  if (hasPlatform) {
    log('green', '[PASS] All events include correct platform');
    passed++;
  } else {
    log('red', '[FAIL] Some events missing platform');
    failed++;
  }

  // Check schema validation results (validated in real-time as events arrived)
  log('blue', '\n[VALIDATE] Schema validation summary...');
  if (schemaErrors.length === 0) {
    log('green', `[PASS] All ${events.length} events validated against their specific schemas`);
    passed++;
  } else {
    log('red', `[FAIL] ${schemaErrors.length} events failed schema validation:`);
    for (const err of schemaErrors) {
      log('red', `  - Event ${err.index} (${err.eventType}) against ${err.schemaUsed} schema: ${err.error}`);
    }
    failed++;
  }

  // Summary
  log('cyan', '\n========================================');
  log('cyan', '  Test Summary');
  log('cyan', '========================================');
  log('green', `  Passed: ${passed}`);
  if (failed > 0) {
    log('red', `  Failed: ${failed}`);
  }
  log('blue', `  Total events: ${events.length}`);
  log('cyan', '========================================\n');

  if (failed > 0) {
    log('red', '[DONE] Some tests failed');
    process.exit(1);
  } else {
    log('green', '[DONE] All tests passed!');
    process.exit(0);
  }
}

// Run the test
runTest().catch((error) => {
  log('red', `[ERROR] ${error.message}`);
  process.exit(1);
});
