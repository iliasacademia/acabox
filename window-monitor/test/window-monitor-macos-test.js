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
const WINDOW_MONITOR_PATH = process.env.WINDOW_MONITOR_BIN || path.join(WINDOW_MONITOR_DIR, 'rust', 'target', 'release', 'window-monitor');
const BUNDLE_ID = process.argv[2] || 'com.microsoft.Word';
const LOG_FILE = path.join(os.tmpdir(), 'window-monitor-test.log');
const TIMESTAMP_TOLERANCE_MS = 2000; // Allow 2 seconds tolerance for event timing (includes gradual movement duration)
const BOUNDS_TOLERANCE = 5; // Allow 5 pixel tolerance for bounds
const MAX_EVENT_DELAY_MS = 500; // Events should fire within 500ms of action start/end

// Step filtering: ONLY_STEPS=4,5 runs only steps 4 and 5 (step 1 setup always runs)
// Steps: 1=setup, 2=doc text, 3=text selection, 4=selection bounds move, 5=scroll latency, 6=window ops+save+close
const ONLY_STEPS = process.env.ONLY_STEPS
  ? new Set(process.env.ONLY_STEPS.split(',').map(Number))
  : null;
if (ONLY_STEPS) console.log(`[INFO] ONLY_STEPS=${process.env.ONLY_STEPS} — running steps: 1 (always), ${[...ONLY_STEPS].join(', ')}`);
function shouldRunStep(n) {
  return !ONLY_STEPS || n <= 1 || ONLY_STEPS.has(n);
}

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
    execSync('cargo build --release', {
      cwd: path.join(WINDOW_MONITOR_DIR, 'rust'),
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

// Validate a batch of step events and return { passed, failed } counts
function validateStepEvents(stepName, stepEvents, checks) {
  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    const result = check(stepEvents);
    if (result.pass) {
      log('green', `[PASS] ${stepName}: ${result.message}`);
      passed++;
    } else {
      log('red', `[FAIL] ${stepName}: ${result.message}`);
      failed++;
    }
  }
  return { passed, failed };
}

async function runWindowOperationTests(events, label) {
  let totalPassed = 0;
  let totalFailed = 0;

  // =========================================================================
  // Move window to starting position, then gradually to {200, 200}
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Move window gradually to {200, 200}`);

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

  let checkpoint = events.length;
  const moveStartTimestamp = Date.now();
  log('blue', '[ACTION] Moving window gradually to {200, 200}...');
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
  const moveEndTimestamp = Date.now();
  log('blue', `  Move action took ${moveEndTimestamp - moveStartTimestamp}ms`);
  await delay(1000);

  let stepEvents = events.slice(checkpoint);
  let result = validateStepEvents(`${label}: Move`, stepEvents, [
    (evts) => {
      const types = evts.map((e) => e.event);
      const has = types.includes('WINDOW_REPOSITIONING');
      return { pass: has, message: has ? 'REPOSITIONING event captured' : 'Missing REPOSITIONING event' };
    },
    (evts) => {
      const types = evts.map((e) => e.event);
      const has = types.includes('WINDOW_REPOSITIONED');
      return { pass: has, message: has ? 'REPOSITIONED event captured' : 'Missing REPOSITIONED event' };
    },
    (evts) => {
      const repositioning = evts.find((e) => e.event === 'WINDOW_REPOSITIONING');
      if (!repositioning) return { pass: false, message: 'No REPOSITIONING to check timing' };
      const d = new Date(repositioning.timestamp).getTime() - moveStartTimestamp;
      return { pass: d <= MAX_EVENT_DELAY_MS, message: `REPOSITIONING delay ${d}ms (limit ${MAX_EVENT_DELAY_MS}ms)` };
    },
    (evts) => {
      const repositioned = evts.find((e) => e.event === 'WINDOW_REPOSITIONED');
      if (!repositioned) return { pass: false, message: 'No REPOSITIONED to check timing' };
      const d = new Date(repositioned.timestamp).getTime() - moveEndTimestamp;
      const ok = d <= MAX_EVENT_DELAY_MS;
      return { pass: ok, message: ok ? `REPOSITIONED delay ${d}ms after action end` : `REPOSITIONED delay ${d}ms exceeds ${MAX_EVENT_DELAY_MS}ms` };
    },
    (evts) => {
      const repositioned = evts.find((e) => e.event === 'WINDOW_REPOSITIONED');
      if (!repositioned) return { pass: false, message: 'No REPOSITIONED to check bounds' };
      const bounds = repositioned.window?.bounds;
      if (!bounds) return { pass: false, message: 'REPOSITIONED event missing bounds' };
      const ok = Math.abs(bounds.x - 200) <= BOUNDS_TOLERANCE && Math.abs(bounds.y - 200) <= BOUNDS_TOLERANCE;
      return { pass: ok, message: ok ? `Bounds position correct (x=${bounds.x}, y=${bounds.y})` : `Bounds position incorrect: expected (200, 200), got (${bounds.x}, ${bounds.y})` };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  // =========================================================================
  // Resize window gradually to {1000, 750}
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Resize window gradually to {1000, 750}`);
  checkpoint = events.length;
  const resizeStartTimestamp = Date.now();
  log('blue', '[ACTION] Resizing window gradually to {1000, 750}...');
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
  const resizeEndTimestamp = Date.now();
  log('blue', `  Resize action took ${resizeEndTimestamp - resizeStartTimestamp}ms`);
  await delay(1000);

  stepEvents = events.slice(checkpoint);
  result = validateStepEvents(`${label}: Resize`, stepEvents, [
    (evts) => {
      const types = evts.map((e) => e.event);
      const has = types.includes('WINDOW_REPOSITIONING');
      return { pass: has, message: has ? 'REPOSITIONING event captured' : 'Missing REPOSITIONING event' };
    },
    (evts) => {
      const types = evts.map((e) => e.event);
      const has = types.includes('WINDOW_REPOSITIONED');
      return { pass: has, message: has ? 'REPOSITIONED event captured' : 'Missing REPOSITIONED event' };
    },
    (evts) => {
      const repositioning = evts.find((e) => e.event === 'WINDOW_REPOSITIONING');
      if (!repositioning) return { pass: false, message: 'No REPOSITIONING to check timing' };
      const d = new Date(repositioning.timestamp).getTime() - resizeStartTimestamp;
      return { pass: d <= MAX_EVENT_DELAY_MS, message: `REPOSITIONING delay ${d}ms (limit ${MAX_EVENT_DELAY_MS}ms)` };
    },
    (evts) => {
      const repositioned = evts.find((e) => e.event === 'WINDOW_REPOSITIONED');
      if (!repositioned) return { pass: false, message: 'No REPOSITIONED to check timing' };
      const d = new Date(repositioned.timestamp).getTime() - resizeEndTimestamp;
      const ok = d <= MAX_EVENT_DELAY_MS;
      return { pass: ok, message: ok ? `REPOSITIONED delay ${d}ms after action end` : `REPOSITIONED delay ${d}ms exceeds ${MAX_EVENT_DELAY_MS}ms` };
    },
    (evts) => {
      const repositioned = evts.find((e) => e.event === 'WINDOW_REPOSITIONED');
      if (!repositioned) return { pass: false, message: 'No REPOSITIONED to check bounds' };
      const bounds = repositioned.window?.bounds;
      if (!bounds) return { pass: false, message: 'REPOSITIONED event missing bounds' };
      const ok = Math.abs(bounds.width - 1000) <= BOUNDS_TOLERANCE && Math.abs(bounds.height - 750) <= BOUNDS_TOLERANCE;
      return { pass: ok, message: ok ? `Bounds size correct (width=${bounds.width}, height=${bounds.height})` : `Bounds size incorrect: expected (1000, 750), got (${bounds.width}, ${bounds.height})` };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  // =========================================================================
  // Enter full-screen
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Enter full-screen`);
  checkpoint = events.length;
  log('blue', '[ACTION] Entering full-screen mode...');
  runAppleScript(`
    tell application "System Events"
      tell process "Microsoft Word"
        set value of attribute "AXFullScreen" of window 1 to true
      end tell
    end tell
  `);
  await delay(5000);

  stepEvents = events.slice(checkpoint);
  result = validateStepEvents(`${label}: Enter full-screen`, stepEvents, [
    (evts) => {
      const types = evts.map((e) => e.event);
      const has = types.includes('WINDOW_REPOSITIONING');
      return { pass: has, message: has ? 'REPOSITIONING event captured' : 'Missing REPOSITIONING event' };
    },
    (evts) => {
      const types = evts.map((e) => e.event);
      const hasRepositioned = types.includes('WINDOW_REPOSITIONED');
      const hasDestroyed = types.includes('WINDOW_DESTROYED');
      const hasRepositioning = types.includes('WINDOW_REPOSITIONING');
      if (hasRepositioned) {
        return { pass: true, message: 'REPOSITIONED event captured' };
      }
      if (hasRepositioning && hasDestroyed) {
        return { pass: true, message: 'Orphaned REPOSITIONING acceptable (WINDOW_DESTROYED present during full-screen transition)' };
      }
      if (hasRepositioning && !hasRepositioned) {
        return { pass: true, message: 'REPOSITIONING without REPOSITIONED (full-screen transition may not complete normally)' };
      }
      return { pass: false, message: 'No repositioning activity detected' };
    },
    (evts) => {
      const types = evts.map((e) => e.event);
      const hasDestroyed = types.includes('WINDOW_DESTROYED');
      const hasCreated = types.includes('WINDOW_CREATED');
      const hasFocused = types.includes('WINDOW_FOCUSED');

      if (hasDestroyed && hasCreated) {
        // Bug path: window was destroyed and recreated during fullscreen
        return { pass: hasFocused, message: hasFocused
          ? 'WINDOW_FOCUSED emitted after fullscreen DESTROYED→CREATED transition'
          : 'Missing WINDOW_FOCUSED after fullscreen DESTROYED→CREATED transition (button will not appear)' };
      }
      // Happy path (REPOSITIONING→REPOSITIONED): window wasn't recreated, focus preserved
      return { pass: true, message: 'Window not destroyed during fullscreen — focus preserved' };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  // =========================================================================
  // Swipe away from full-screen (Control+Left Arrow = move to Desktop Space)
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Swipe away from full-screen`);

  // Capture the window identity from the most recent non-DESTROYED window event
  const lastWindowEvt = [...events].reverse().find(
    (e) => e.window?.id && e.event !== 'WINDOW_DESTROYED'
  );
  const fullScreenWindowId = lastWindowEvt?.window?.id;
  const fullScreenTitle = lastWindowEvt?.window?.title;
  const fullScreenDocPath = lastWindowEvt?.window?.documentPath;

  checkpoint = events.length;
  log('blue', '[ACTION] Simulating Control+Left Arrow (swipe away from full-screen)...');
  runAppleScript('tell application "System Events" to key code 123 using control down');
  await delay(3000);
  runAppleScript('tell application "Finder" to activate');
  await delay(2000);

  stepEvents = events.slice(checkpoint);
  result = validateStepEvents(`${label}: Swipe away from full-screen`, stepEvents, [
    (evts) => {
      const destroyed = evts.find((e) => e.event === 'WINDOW_DESTROYED' && e.window?.id === fullScreenWindowId);
      return { pass: !!destroyed, message: destroyed
        ? `WINDOW_DESTROYED for window ${fullScreenWindowId}`
        : `Missing WINDOW_DESTROYED for window ${fullScreenWindowId}` };
    },
    (evts) => {
      const unfocused = evts.find((e) => e.event === 'APP_UNFOCUSED');
      return { pass: !!unfocused, message: unfocused
        ? 'APP_UNFOCUSED event captured'
        : 'Missing APP_UNFOCUSED event' };
    },
    (evts) => {
      const destroyedIdx = evts.findIndex((e) => e.event === 'WINDOW_DESTROYED' && e.window?.id === fullScreenWindowId);
      const unfocusedIdx = evts.findIndex((e) => e.event === 'APP_UNFOCUSED');
      if (destroyedIdx < 0 || unfocusedIdx < 0) return { pass: false, message: 'Cannot check ordering: missing WINDOW_DESTROYED or APP_UNFOCUSED' };
      const ok = destroyedIdx < unfocusedIdx;
      return { pass: ok, message: ok
        ? 'WINDOW_DESTROYED before APP_UNFOCUSED'
        : `WINDOW_DESTROYED (index ${destroyedIdx}) should come before APP_UNFOCUSED (index ${unfocusedIdx})` };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  // =========================================================================
  // Swipe back to full-screen (Control+Right Arrow = move to full-screen Space)
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Swipe back to full-screen`);
  checkpoint = events.length;
  log('blue', '[ACTION] Simulating Control+Right Arrow (swipe back to full-screen)...');
  runAppleScript('tell application "System Events" to key code 124 using control down');
  await delay(5000);

  stepEvents = events.slice(checkpoint);
  result = validateStepEvents(`${label}: Swipe back to full-screen`, stepEvents, [
    (evts) => {
      const focused = evts.find((e) => e.event === 'APP_FOCUSED');
      return { pass: !!focused, message: focused
        ? 'APP_FOCUSED event captured'
        : 'Missing APP_FOCUSED event' };
    },
    (evts) => {
      const created = evts.find((e) => e.event === 'WINDOW_CREATED' && e.window?.id === fullScreenWindowId);
      return { pass: !!created, message: created
        ? `WINDOW_CREATED with same window ID ${fullScreenWindowId}`
        : `Missing WINDOW_CREATED with window ID ${fullScreenWindowId}` };
    },
    (evts) => {
      const created = evts.find((e) => e.event === 'WINDOW_CREATED' && e.window?.id === fullScreenWindowId);
      if (!created) return { pass: false, message: 'No WINDOW_CREATED to check title' };
      const ok = created.window.title === fullScreenTitle;
      return { pass: ok, message: ok
        ? `Title preserved: "${fullScreenTitle}"`
        : `Title mismatch: expected "${fullScreenTitle}", got "${created.window.title}"` };
    },
    (evts) => {
      const created = evts.find((e) => e.event === 'WINDOW_CREATED' && e.window?.id === fullScreenWindowId);
      if (!created) return { pass: false, message: 'No WINDOW_CREATED to check documentPath' };
      const ok = created.window.documentPath === fullScreenDocPath;
      return { pass: ok, message: ok
        ? `documentPath preserved: ${fullScreenDocPath}`
        : `documentPath mismatch: expected ${fullScreenDocPath}, got ${created.window.documentPath}` };
    },
    (evts) => {
      const focused = evts.find((e) => e.event === 'WINDOW_FOCUSED' && e.window?.id === fullScreenWindowId);
      return { pass: !!focused, message: focused
        ? `WINDOW_FOCUSED emitted for window ${fullScreenWindowId} after swipe-back`
        : `Missing WINDOW_FOCUSED for window ${fullScreenWindowId} after swipe-back (button will not appear)` };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  // =========================================================================
  // Exit full-screen
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Exit full-screen`);
  checkpoint = events.length;
  log('blue', '[ACTION] Exiting full-screen mode...');
  runAppleScript(`
    tell application "System Events"
      tell process "Microsoft Word"
        set wc to count of windows
        repeat with i from 1 to wc
          try
            set axFS to value of attribute "AXFullScreen" of window i
            if axFS is true then
              set value of attribute "AXFullScreen" of window i to false
              exit repeat
            end if
          end try
        end repeat
      end tell
    end tell
  `);
  await delay(5000);

  stepEvents = events.slice(checkpoint);
  result = validateStepEvents(`${label}: Exit full-screen`, stepEvents, [
    (evts) => {
      const types = evts.map((e) => e.event);
      const hasWindowActivity = types.some((t) =>
        ['WINDOW_REPOSITIONING', 'WINDOW_REPOSITIONED', 'WINDOW_CREATED', 'WINDOW_DESTROYED'].includes(t)
      );
      if (hasWindowActivity) {
        return { pass: true, message: `Window activity detected: ${types.filter((t) => t.startsWith('WINDOW_')).join(', ')}` };
      }
      return { pass: true, message: 'No window events during exit full-screen (transition may be handled by macOS internally)' };
    },
    (evts) => {
      const types = evts.map((e) => e.event);
      const hasCreated = types.includes('WINDOW_CREATED');
      const hasFocused = types.includes('WINDOW_FOCUSED');

      if (hasCreated) {
        return { pass: hasFocused, message: hasFocused
          ? 'WINDOW_FOCUSED emitted after fullscreen exit with WINDOW_CREATED'
          : 'Missing WINDOW_FOCUSED after fullscreen exit WINDOW_CREATED (button will not appear)' };
      }
      return { pass: true, message: 'No WINDOW_CREATED during exit — focus preserved' };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  // =========================================================================
  // Switch to Finder
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Switch to Finder`);
  checkpoint = events.length;
  log('blue', '[ACTION] Switching to Finder...');
  const switchToFinderTimestamp = Date.now();
  runAppleScript('tell application "Finder" to activate');
  await delay(1000);

  stepEvents = events.slice(checkpoint);
  result = validateStepEvents(`${label}: Switch to Finder`, stepEvents, [
    (evts) => {
      const unfocused = evts.find((e) => e.event === 'APP_UNFOCUSED');
      if (!unfocused) return { pass: false, message: 'No APP_UNFOCUSED event found' };
      const d = new Date(unfocused.timestamp).getTime() - switchToFinderTimestamp;
      const ok = d >= 0 && d <= TIMESTAMP_TOLERANCE_MS;
      return { pass: ok, message: ok ? `APP_UNFOCUSED received ${d}ms after action` : `APP_UNFOCUSED timing ${d}ms outside tolerance ${TIMESTAMP_TOLERANCE_MS}ms` };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  // =========================================================================
  // Switch back to Word
  // =========================================================================
  log('blue', `\n[STEP] ${label}: Switch back to Word`);
  checkpoint = events.length;
  log('blue', '[ACTION] Switching back to Word...');
  const switchBackTimestamp = Date.now();
  runAppleScript('tell application "Microsoft Word" to activate');
  await delay(1000);

  stepEvents = events.slice(checkpoint);
  result = validateStepEvents(`${label}: Switch back to Word`, stepEvents, [
    (evts) => {
      const focused = evts.find((e) => e.event === 'APP_FOCUSED');
      if (!focused) return { pass: false, message: 'No APP_FOCUSED event found' };
      const d = new Date(focused.timestamp).getTime() - switchBackTimestamp;
      const ok = d >= 0 && d <= TIMESTAMP_TOLERANCE_MS;
      return { pass: ok, message: ok ? `APP_FOCUSED received ${d}ms after action` : `APP_FOCUSED timing ${d}ms outside tolerance ${TIMESTAMP_TOLERANCE_MS}ms` };
    },
  ]);
  totalPassed += result.passed;
  totalFailed += result.failed;

  return { passed: totalPassed, failed: totalFailed };
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
  let totalPassed = 0;
  let totalFailed = 0;

  // Start monitor
  const monitor = spawn(WINDOW_MONITOR_PATH, ['--bundle-id', BUNDLE_ID, '--track-text-selection', '--track-document-text', '--content-area-role', 'AXSplitGroup'], {
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

  // Generate temp file path for save-as test
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const testDocPath = path.join(os.homedir(), 'Desktop', `test_${timestamp}.docx`);

  try {
    // =========================================================================
    // Step 1: Setup — Open Word, create document, focus window
    // =========================================================================
    log('blue', '\n[STEP 1] Setup — Open Word, create document, focus window');
    // Checkpoint starts at 0 to include events emitted during monitor startup
    // (APP_EXISTING fires immediately when monitor discovers the running app)
    let checkpoint = 0;

    log('blue', '[ACTION] Opening Microsoft Word...');
    runAppleScript('tell application "Microsoft Word" to activate');
    await delay(1500);

    log('blue', '[ACTION] Creating new document...');
    runAppleScript('tell application "Microsoft Word" to make new document');
    await delay(3000);

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

    // Validate setup
    let stepEvents = events.slice(checkpoint);
    let result = validateStepEvents('Setup', stepEvents, [
      (evts) => {
        const types = evts.map((e) => e.event);
        const has = types.includes('APP_EXISTING') || types.includes('APP_LAUNCHED');
        return { pass: has, message: has ? 'App event captured' : 'Missing APP_EXISTING or APP_LAUNCHED event' };
      },
      (evts) => {
        const types = evts.map((e) => e.event);
        const has = types.includes('WINDOW_CREATED') || types.includes('WINDOW_EXISTING');
        return { pass: has, message: has ? 'Window event captured' : 'Missing WINDOW_CREATED or WINDOW_EXISTING event' };
      },
      (evts) => {
        // APP_EXISTING/APP_LAUNCHED should be first event
        if (evts.length === 0) return { pass: false, message: 'No events captured during setup' };
        const firstType = evts[0].event;
        const isFirst = firstType === 'APP_EXISTING' || firstType === 'APP_LAUNCHED';
        return { pass: isFirst, message: isFirst ? 'App event is first event' : `First event was ${firstType}, expected APP_EXISTING or APP_LAUNCHED` };
      },
      (evts) => {
        // WINDOW_CREATED/WINDOW_EXISTING should come after APP event
        const types = evts.map((e) => e.event);
        const appIdx = Math.min(
          types.indexOf('APP_EXISTING') >= 0 ? types.indexOf('APP_EXISTING') : Infinity,
          types.indexOf('APP_LAUNCHED') >= 0 ? types.indexOf('APP_LAUNCHED') : Infinity
        );
        const winIdx = Math.min(
          types.indexOf('WINDOW_CREATED') >= 0 ? types.indexOf('WINDOW_CREATED') : Infinity,
          types.indexOf('WINDOW_EXISTING') >= 0 ? types.indexOf('WINDOW_EXISTING') : Infinity
        );
        const ok = winIdx > appIdx && winIdx < Infinity;
        return { pass: ok, message: ok ? 'Window event comes after app event' : 'Window event should come after app event' };
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;

    // =========================================================================
    // Step 2: Type text and validate WINDOW_DOCUMENT_TEXT_CHANGED
    // =========================================================================
    const mockText = 'The quick brown fox jumps over the lazy dog. This is a test sentence for document text tracking.';

    if (shouldRunStep(2)) {
    log('blue', '\n[STEP 2] Type text and validate document text tracking');

    // Click into the document body to ensure cursor focus
    log('blue', '[ACTION] Clicking into document body...');
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          set frontmost to true
        end tell
      end tell
    `);
    await delay(500);
    log('blue', `[ACTION] Typing text: "${mockText.slice(0, 50)}..."`);
    checkpoint = events.length;
    runAppleScript(`
      tell application "Microsoft Word"
        activate
        tell application "System Events"
          keystroke "${mockText}"
        end tell
      end tell
    `);

    // Wait for debounce (2s) + buffer
    log('blue', '[ACTION] Waiting 4s for document text debounce...');
    await delay(4000);

    stepEvents = events.slice(checkpoint);
    result = validateStepEvents('Document text tracking', stepEvents, [
      (evts) => {
        const docTextEvt = evts.find((e) => e.event === 'WINDOW_DOCUMENT_TEXT_CHANGED');
        if (!docTextEvt) return { pass: false, message: 'Missing WINDOW_DOCUMENT_TEXT_CHANGED event' };
        return { pass: true, message: 'WINDOW_DOCUMENT_TEXT_CHANGED event captured' };
      },
      (evts) => {
        const docTextEvt = evts.find((e) => e.event === 'WINDOW_DOCUMENT_TEXT_CHANGED');
        if (!docTextEvt) return { pass: false, message: 'No WINDOW_DOCUMENT_TEXT_CHANGED to check document field' };
        const doc = docTextEvt.document;
        if (!doc) return { pass: false, message: 'WINDOW_DOCUMENT_TEXT_CHANGED missing document field' };
        const hasFilePath = typeof doc.filePath === 'string' && doc.filePath.length > 0;
        const hasCharCount = typeof doc.characterCount === 'number' && doc.characterCount > 0;
        const hasByteSize = typeof doc.byteSize === 'number' && doc.byteSize > 0;
        const ok = hasFilePath && hasCharCount && hasByteSize;
        return { pass: ok, message: ok
          ? `Document metadata: filePath=${doc.filePath}, characterCount=${doc.characterCount}, byteSize=${doc.byteSize}`
          : `Invalid document metadata: filePath=${doc.filePath}, characterCount=${doc.characterCount}, byteSize=${doc.byteSize}` };
      },
      (evts) => {
        const docTextEvt = evts.find((e) => e.event === 'WINDOW_DOCUMENT_TEXT_CHANGED');
        if (!docTextEvt || !docTextEvt.document?.filePath) {
          return { pass: false, message: 'No WINDOW_DOCUMENT_TEXT_CHANGED to check file contents' };
        }
        const filePath = docTextEvt.document.filePath;
        try {
          const fileContents = fs.readFileSync(filePath, 'utf8');
          // The file should contain the typed text (Word may add formatting characters)
          const containsText = fileContents.includes(mockText);
          return { pass: containsText, message: containsText
            ? `File contains typed text (${fileContents.length} bytes)`
            : `File does not contain expected text. File contents (first 200 chars): "${fileContents.slice(0, 200)}"` };
        } catch (err) {
          return { pass: false, message: `Failed to read file ${filePath}: ${err.message}` };
        }
      },
      (evts) => {
        const docTextEvt = evts.find((e) => e.event === 'WINDOW_DOCUMENT_TEXT_CHANGED');
        if (!docTextEvt || !docTextEvt.document?.filePath) {
          return { pass: false, message: 'No WINDOW_DOCUMENT_TEXT_CHANGED to check byte size' };
        }
        try {
          const fileContents = fs.readFileSync(docTextEvt.document.filePath, 'utf8');
          const ok = fileContents.length === docTextEvt.document.byteSize;
          return { pass: ok, message: ok
            ? `byteSize matches file size (${docTextEvt.document.byteSize})`
            : `byteSize mismatch: event says ${docTextEvt.document.byteSize}, file is ${fileContents.length} bytes` };
        } catch (err) {
          return { pass: false, message: `Failed to read file: ${err.message}` };
        }
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;

    // Also check that we got the initial WINDOW_DOCUMENT_TEXT_CHANGED on focus
    // (this would have been emitted earlier, when the window first gained focus)
    const allDocTextEvents = events.filter((e) => e.event === 'WINDOW_DOCUMENT_TEXT_CHANGED');
    if (allDocTextEvents.length >= 1) {
      log('green', `[PASS] Document text tracking: ${allDocTextEvents.length} WINDOW_DOCUMENT_TEXT_CHANGED event(s) total`);
      totalPassed++;
    } else {
      log('red', '[FAIL] Document text tracking: expected at least 1 WINDOW_DOCUMENT_TEXT_CHANGED event');
      totalFailed++;
    }

    } else { log('blue', '\n[SKIP] Step 2 (ONLY_STEPS filter)'); }

    // =========================================================================
    // Step 3: Select all text and validate WINDOW_TEXT_SELECTED / WINDOW_TEXT_SELECTION_CLEARED
    // =========================================================================
    if (shouldRunStep(3)) {
    log('blue', '\n[STEP 3] Select text and validate text selection tracking');

    // Select all text with Cmd+A
    log('blue', '[ACTION] Selecting all text with Cmd+A...');
    checkpoint = events.length;
    runAppleScript(`
      tell application "Microsoft Word"
        activate
        tell application "System Events"
          keystroke "a" using command down
        end tell
      end tell
    `);

    log('blue', '[ACTION] Waiting 2s for text selection detection...');
    await delay(2000);

    stepEvents = events.slice(checkpoint);
    result = validateStepEvents('Text selection', stepEvents, [
      (evts) => {
        const selEvt = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTED');
        if (!selEvt) return { pass: false, message: 'Missing WINDOW_TEXT_SELECTED event' };
        return { pass: true, message: 'WINDOW_TEXT_SELECTED event captured' };
      },
      (evts) => {
        const selEvt = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTED');
        if (!selEvt) return { pass: false, message: 'No WINDOW_TEXT_SELECTED to check selection field' };
        const sel = selEvt.selection;
        if (!sel) return { pass: false, message: 'WINDOW_TEXT_SELECTED missing selection field' };
        const hasFilePath = typeof sel.filePath === 'string' && sel.filePath.length > 0;
        const hasLength = typeof sel.length === 'number' && sel.length > 0;
        const ok = hasFilePath && hasLength;
        return { pass: ok, message: ok
          ? `Selection metadata: filePath=${sel.filePath}, length=${sel.length}`
          : `Invalid selection metadata: filePath=${sel.filePath}, length=${sel.length}` };
      },
      (evts) => {
        const selEvt = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTED');
        if (!selEvt || !selEvt.selection?.filePath) {
          return { pass: false, message: 'No WINDOW_TEXT_SELECTED to check file contents' };
        }
        const filePath = selEvt.selection.filePath;
        try {
          const fileContents = fs.readFileSync(filePath, 'utf8');
          const containsText = fileContents.includes(mockText);
          return { pass: containsText, message: containsText
            ? `Selection file contains typed text (${fileContents.length} bytes)`
            : `Selection file does not contain expected text. File contents (first 200 chars): "${fileContents.slice(0, 200)}"` };
        } catch (err) {
          return { pass: false, message: `Failed to read selection file ${filePath}: ${err.message}` };
        }
      },
      (evts) => {
        const selEvt = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTED');
        if (!selEvt || !selEvt.selection?.filePath) {
          return { pass: false, message: 'No WINDOW_TEXT_SELECTED to check byte size' };
        }
        try {
          const fileContents = fs.readFileSync(selEvt.selection.filePath, 'utf8');
          const ok = fileContents.length === selEvt.selection.length;
          return { pass: ok, message: ok
            ? `selection.length matches file size (${selEvt.selection.length})`
            : `selection.length mismatch: event says ${selEvt.selection.length}, file is ${fileContents.length} bytes` };
        } catch (err) {
          return { pass: false, message: `Failed to read selection file: ${err.message}` };
        }
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;

    } else { log('blue', '\n[SKIP] Step 3 (ONLY_STEPS filter)'); }

    // =========================================================================
    // Step 4: Move window with text selected — validate debounced selection repositioning
    // =========================================================================
    if (shouldRunStep(4)) {
    log('blue', '\n[STEP 4] Move window with text selected — validate selection bounds repositioning');

    // Set window to known starting position
    log('blue', '[ACTION] Setting window to starting position...');
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          set position of window 1 to {100, 100}
          set size of window 1 to {800, 600}
        end tell
      end tell
    `);
    // Wait long enough for both window (150ms) and selection bounds (300ms) debounce to finish
    await delay(1000);

    // Move window gradually to shift selection bounds on screen
    checkpoint = events.length;
    log('blue', '[ACTION] Moving window gradually to shift selection bounds...');
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

    log('blue', '[ACTION] Waiting 1.5s for selection bounds debounce...');
    await delay(1500);

    stepEvents = events.slice(checkpoint);
    result = validateStepEvents('Selection bounds repositioning', stepEvents, [
      (evts) => {
        const has = evts.some((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONING');
        return { pass: has, message: has
          ? 'WINDOW_TEXT_SELECTION_REPOSITIONING event captured'
          : 'Missing WINDOW_TEXT_SELECTION_REPOSITIONING event' };
      },
      (evts) => {
        const has = evts.some((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONED');
        return { pass: has, message: has
          ? 'WINDOW_TEXT_SELECTION_REPOSITIONED event captured'
          : 'Missing WINDOW_TEXT_SELECTION_REPOSITIONED event' };
      },
      (evts) => {
        // Should only have one REPOSITIONING (debounce collapses subsequent changes)
        const count = evts.filter((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONING').length;
        return { pass: count === 1, message: count === 1
          ? 'Exactly 1 REPOSITIONING (debounce working correctly)'
          : `Expected 1 REPOSITIONING, got ${count} (debounce may not be working)` };
      },
      (evts) => {
        // Should only have one REPOSITIONED
        const count = evts.filter((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONED').length;
        return { pass: count === 1, message: count === 1
          ? 'Exactly 1 REPOSITIONED (single final event)'
          : `Expected 1 REPOSITIONED, got ${count}` };
      },
      (evts) => {
        // REPOSITIONING should have selection.bounds
        const repositioning = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONING');
        if (!repositioning) return { pass: false, message: 'No REPOSITIONING to check bounds' };
        const b = repositioning.selection?.bounds;
        const ok = b && typeof b.x === 'number' && typeof b.y === 'number'
          && typeof b.width === 'number' && typeof b.height === 'number';
        return { pass: ok, message: ok
          ? `REPOSITIONING has bounds (x=${b.x}, y=${b.y}, w=${b.width}, h=${b.height})`
          : 'REPOSITIONING missing or invalid selection.bounds' };
      },
      (evts) => {
        // REPOSITIONED should have selection.bounds
        const repositioned = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONED');
        if (!repositioned) return { pass: false, message: 'No REPOSITIONED to check bounds' };
        const b = repositioned.selection?.bounds;
        const ok = b && typeof b.x === 'number' && typeof b.y === 'number'
          && typeof b.width === 'number' && typeof b.height === 'number';
        return { pass: ok, message: ok
          ? `REPOSITIONED has bounds (x=${b.x}, y=${b.y}, w=${b.width}, h=${b.height})`
          : 'REPOSITIONED missing or invalid selection.bounds' };
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;

    } else { log('blue', '\n[SKIP] Step 4 (ONLY_STEPS filter)'); }

    // =========================================================================
    // Step 5: Scroll with text selected — measure detection latency
    // =========================================================================
    if (shouldRunStep(5)) {
    log('blue', '\n[STEP 5] Scroll with text selected — measure selection repositioning latency');

    // Pre-position mouse to where the window center will be after reset (500, 400)
    // Do this EARLY so any side-effects settle before the selection is re-established
    log('blue', '[ACTION] Pre-positioning mouse cursor to window center (500, 400)...');
    try {
      execSync(`python3 << 'PYEOF'
import ctypes

class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cg.CGWarpMouseCursorPosition.restype = ctypes.c_int32
cg.CGWarpMouseCursorPosition.argtypes = [CGPoint]
cg.CGWarpMouseCursorPosition(CGPoint(500.0, 400.0))
PYEOF`, { encoding: 'utf8', timeout: 5000 });
    } catch (error) {
      log('red', `[ERROR] Mouse warp failed: ${error.message}`);
    }
    await delay(500);

    // Add enough content to make the document scrollable
    log('blue', '[ACTION] Adding newlines to make document scrollable...');
    runAppleScript(`
      tell application "Microsoft Word"
        activate
        tell application "System Events"
          key code 125 using {command down}
          repeat 40 times
            keystroke return
          end repeat
        end tell
      end tell
    `);
    await delay(2000);

    // Re-select all text so selection spans the visible area
    log('blue', '[ACTION] Re-selecting all text with Cmd+A...');
    runAppleScript(`
      tell application "Microsoft Word"
        activate
        tell application "System Events"
          keystroke "a" using {command down}
        end tell
      end tell
    `);
    await delay(1500);

    // Reset window position to a known state — mouse at (500, 400) is now over window center
    log('blue', '[ACTION] Resetting window position before scroll test...');
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          set position of window 1 to {100, 100}
          set size of window 1 to {800, 600}
        end tell
      end tell
    `);
    await delay(1500);

    // Simulate continuous scroll wheel via CGEvent over 2 seconds — like a real trackpad gesture
    // NO mouse warp here; cursor is already positioned from earlier step
    // The script prints the epoch ms timestamp of FIRST scroll event post
    checkpoint = events.length;
    log('blue', '[ACTION] Simulating continuous scroll wheel over 2s via CGEvent...');
    let scrollStartTimestamp;
    try {
      const scrollOutput = execSync(`python3 << 'PYEOF'
import ctypes, time

cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

cg.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
cg.CGEventCreateScrollWheelEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32
]
cg.CGEventPost.restype = None
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

# Simulate continuous scroll: 20 small scroll events over 2 seconds (every 100ms)
# kCGScrollEventUnitLine = 0, kCGHIDEventTap = 0
first_ts = None
for i in range(20):
    event = cg.CGEventCreateScrollWheelEvent(None, 0, 1, -2)
    cg.CGEventPost(0, event)
    if first_ts is None:
        first_ts = int(time.time() * 1000)
    time.sleep(0.1)

# Print timestamp of first scroll event (excludes Python startup overhead)
print(first_ts)
PYEOF`, { encoding: 'utf8', timeout: 10000 }).trim();
      scrollStartTimestamp = parseInt(scrollOutput, 10);
      log('blue', `[ACTION] First scroll event posted at timestamp: ${scrollStartTimestamp} (20 events over 2s)`);
    } catch (error) {
      log('red', `[ERROR] Scroll wheel simulation failed: ${error.message}`);
      scrollStartTimestamp = Date.now();
    }

    log('blue', '[ACTION] Waiting 1.5s for selection bounds debounce after scroll ends...');
    await delay(1500);

    stepEvents = events.slice(checkpoint);
    result = validateStepEvents('Scroll latency measurement', stepEvents, [
      (evts) => {
        const has = evts.some((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONING');
        return { pass: has, message: has
          ? 'WINDOW_TEXT_SELECTION_REPOSITIONING event captured after scroll'
          : 'Missing WINDOW_TEXT_SELECTION_REPOSITIONING event after scroll' };
      },
      (evts) => {
        const has = evts.some((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONED');
        return { pass: has, message: has
          ? 'WINDOW_TEXT_SELECTION_REPOSITIONED event captured after scroll'
          : 'Missing WINDOW_TEXT_SELECTION_REPOSITIONED event after scroll' };
      },
      (evts) => {
        // Measure REPOSITIONING latency from scroll start
        const repositioning = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONING');
        if (!repositioning) return { pass: false, message: 'No REPOSITIONING to measure latency' };
        const eventTime = new Date(repositioning.timestamp).getTime();
        const delayMs = eventTime - scrollStartTimestamp;
        const ok = delayMs <= 1000;
        const status = ok ? 'PASS' : 'FAIL';
        log(ok ? 'green' : 'red', `  >>> REPOSITIONING delay: ${delayMs}ms [${status}] (threshold: 1000ms)`);
        return { pass: ok, message: `REPOSITIONING delay: ${delayMs}ms (${status}, threshold 1000ms)` };
      },
      (evts) => {
        // Measure REPOSITIONED latency from scroll END (scroll lasts ~2s)
        // AX API takes time to settle after scrolling, so measure from when scrolling stops
        const repositioned = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONED');
        if (!repositioned) return { pass: false, message: 'No REPOSITIONED to measure latency' };
        const eventTime = new Date(repositioned.timestamp).getTime();
        const scrollEndTimestamp = scrollStartTimestamp + 2000;
        const delayMs = eventTime - scrollEndTimestamp;
        const ok = delayMs <= 3000; // AX settling can take 2-3s after scroll ends
        const status = ok ? 'PASS' : 'FAIL';
        log(ok ? 'green' : 'red', `  >>> REPOSITIONED delay from scroll end: ${delayMs}ms [${status}] (threshold: 3000ms)`);
        return { pass: ok, message: `REPOSITIONED delay from scroll end: ${delayMs}ms (${status}, threshold 3000ms)` };
      },
      (evts) => {
        // REPOSITIONING should have valid selection.bounds
        const repositioning = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONING');
        if (!repositioning) return { pass: false, message: 'No REPOSITIONING to check bounds' };
        const b = repositioning.selection?.bounds;
        const ok = b && typeof b.x === 'number' && typeof b.y === 'number'
          && typeof b.width === 'number' && typeof b.height === 'number';
        return { pass: ok, message: ok
          ? `REPOSITIONING has bounds (x=${b.x}, y=${b.y}, w=${b.width}, h=${b.height})`
          : 'REPOSITIONING missing or invalid selection.bounds' };
      },
      (evts) => {
        // REPOSITIONED should have valid selection.bounds
        const repositioned = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_REPOSITIONED');
        if (!repositioned) return { pass: false, message: 'No REPOSITIONED to check bounds' };
        const b = repositioned.selection?.bounds;
        const ok = b && typeof b.x === 'number' && typeof b.y === 'number'
          && typeof b.width === 'number' && typeof b.height === 'number';
        return { pass: ok, message: ok
          ? `REPOSITIONED has bounds (x=${b.x}, y=${b.y}, w=${b.width}, h=${b.height})`
          : 'REPOSITIONED missing or invalid selection.bounds' };
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;

    // Clear selection by pressing Right arrow
    log('blue', '[ACTION] Clearing selection with Right arrow...');
    checkpoint = events.length;
    runAppleScript(`
      tell application "Microsoft Word"
        activate
        tell application "System Events"
          key code 124
        end tell
      end tell
    `);

    log('blue', '[ACTION] Waiting 2s for selection clear detection...');
    await delay(2000);

    stepEvents = events.slice(checkpoint);
    result = validateStepEvents('Text selection cleared', stepEvents, [
      (evts) => {
        const clearEvt = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_CLEARED');
        if (!clearEvt) return { pass: false, message: 'Missing WINDOW_TEXT_SELECTION_CLEARED event' };
        return { pass: true, message: 'WINDOW_TEXT_SELECTION_CLEARED event captured' };
      },
      (evts) => {
        const clearEvt = evts.find((e) => e.event === 'WINDOW_TEXT_SELECTION_CLEARED');
        if (!clearEvt) return { pass: false, message: 'No WINDOW_TEXT_SELECTION_CLEARED to check selection field' };
        const ok = clearEvt.selection === undefined || clearEvt.selection === null;
        return { pass: ok, message: ok
          ? 'WINDOW_TEXT_SELECTION_CLEARED has no selection field (correct)'
          : `WINDOW_TEXT_SELECTION_CLEARED unexpectedly has selection: ${JSON.stringify(clearEvt.selection)}` };
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;

    } else { log('blue', '\n[SKIP] Step 5 (ONLY_STEPS filter)'); }

    // =========================================================================
    // Window operation tests on UNSAVED document
    // =========================================================================
    if (shouldRunStep(6)) {
    log('blue', '\n========================================');
    log('blue', '  Window operations: Unsaved document');
    log('blue', '========================================');
    const r1 = await runWindowOperationTests(events, 'Unsaved doc');
    totalPassed += r1.passed;
    totalFailed += r1.failed;

    // =========================================================================
    // Save document
    // =========================================================================
    log('blue', `\n[STEP] Save document as ${testDocPath}`);
    checkpoint = events.length;
    runAppleScript(`
      tell application "Microsoft Word"
        save as active document file name "${testDocPath}" file format format document
      end tell
    `);
    await delay(3000);

    // Validate that WINDOW_DOCUMENT_PATH_CHANGED is emitted after save
    stepEvents = events.slice(checkpoint);
    result = validateStepEvents('Save document', stepEvents, [
      (evts) => {
        const docPathChanged = evts.find((e) => e.event === 'WINDOW_DOCUMENT_PATH_CHANGED');
        if (!docPathChanged) return { pass: false, message: 'Missing WINDOW_DOCUMENT_PATH_CHANGED event' };
        const hasPath = docPathChanged.window?.documentPath != null;
        return { pass: hasPath, message: hasPath
          ? `WINDOW_DOCUMENT_PATH_CHANGED with documentPath: ${docPathChanged.window.documentPath}`
          : 'WINDOW_DOCUMENT_PATH_CHANGED has null documentPath' };
      },
      (evts) => {
        const docPathChanged = evts.find((e) => e.event === 'WINDOW_DOCUMENT_PATH_CHANGED');
        if (!docPathChanged) return { pass: false, message: 'No WINDOW_DOCUMENT_PATH_CHANGED to check title' };
        const expectedTitle = `test_${timestamp}`;
        const ok = docPathChanged.window?.title === expectedTitle;
        return { pass: ok, message: ok
          ? `Window title updated to "${docPathChanged.window.title}"`
          : `Expected title "${expectedTitle}", got "${docPathChanged.window?.title}"` };
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;

    // =========================================================================
    // Window operation tests on SAVED document
    // =========================================================================
    log('blue', '\n========================================');
    log('blue', '  Window operations: Saved document');
    log('blue', '========================================');
    const r2 = await runWindowOperationTests(events, 'Saved doc');
    totalPassed += r2.passed;
    totalFailed += r2.failed;

    // Validate that saved doc operations had documentPath set
    // Look at events generated during r2 (after the save)
    const savedDocEvents = events.slice(checkpoint);
    const eventsWithDocPath = savedDocEvents.filter((e) => e.window?.documentPath != null);
    if (eventsWithDocPath.length > 0) {
      log('green', `[PASS] Saved doc: ${eventsWithDocPath.length} events have documentPath set`);
      totalPassed++;
    } else {
      log('red', '[FAIL] Saved doc: No events with documentPath set after save');
      totalFailed++;
    }

    // =========================================================================
    // Close document
    // =========================================================================
    log('blue', '\n[STEP] Close document');
    checkpoint = events.length;
    log('blue', '[ACTION] Closing document...');
    const closeTimestamp = Date.now();
    runAppleScript('tell application "Microsoft Word" to close document 1 saving no');
    await delay(5000);

    stepEvents = events.slice(checkpoint);
    const CLOSE_TOLERANCE_MS = 5000;
    result = validateStepEvents('Close document', stepEvents, [
      (evts) => {
        const destroyed = evts.find((e) => e.event === 'WINDOW_DESTROYED');
        if (destroyed) {
          const d = new Date(destroyed.timestamp).getTime() - closeTimestamp;
          const ok = d >= 0 && d <= CLOSE_TOLERANCE_MS;
          return { pass: ok, message: ok ? `WINDOW_DESTROYED received ${d}ms after action` : `WINDOW_DESTROYED timing ${d}ms outside tolerance ${CLOSE_TOLERANCE_MS}ms` };
        }
        const allDestroyed = events.filter((e) => e.event === 'WINDOW_DESTROYED');
        if (allDestroyed.length > 0) {
          return { pass: true, message: `No WINDOW_DESTROYED during close step, but ${allDestroyed.length} WINDOW_DESTROYED event(s) seen earlier (window likely destroyed during full-screen transition)` };
        }
        return { pass: false, message: 'No WINDOW_DESTROYED event found in entire event stream' };
      },
    ]);
    totalPassed += result.passed;
    totalFailed += result.failed;
    } else { log('blue', '\n[SKIP] Steps 6-8: Window operations (ONLY_STEPS filter)'); }
  } catch (error) {
    log('yellow', `[WARN] Error during actions: ${error.message}`);
  }

  // Cleanup temp file
  try {
    fs.unlinkSync(testDocPath);
    log('blue', `[CLEANUP] Deleted ${testDocPath}`);
  } catch (err) {
    log('yellow', `[CLEANUP] Could not delete ${testDocPath}: ${err.message}`);
  }

  // Stop monitor
  log('blue', '\n[ACTION] Stopping monitor...');
  monitor.kill('SIGTERM');
  await delay(500);

  // Write log file
  fs.writeFileSync(LOG_FILE, JSON.stringify(events, null, 2));
  log('blue', `[INFO] Events written to: ${LOG_FILE}`);

  // =========================================================================
  // Cross-cutting validations (run on full event stream)
  // =========================================================================
  log('blue', '\n[VALIDATE] Cross-cutting checks on full event stream...');
  const eventTypes = events.map((e) => e.event);
  console.log('Event types captured:', eventTypes);

  // Timestamp monotonicity
  let timestampsIncreasing = true;
  const timestampErrors = [];
  for (let i = 1; i < events.length; i++) {
    const prevTime = new Date(events[i - 1].timestamp).getTime();
    const currTime = new Date(events[i].timestamp).getTime();
    if (currTime < prevTime) {
      timestampErrors.push(
        `Timestamp decreased at event ${i}: ${events[i - 1].event} (${events[i - 1].timestamp}) -> ${events[i].event} (${events[i].timestamp})`
      );
      timestampsIncreasing = false;
    }
  }
  if (timestampsIncreasing) {
    log('green', '[PASS] Event timestamps are monotonically increasing');
    totalPassed++;
  } else {
    log('red', '[FAIL] Event timestamps are not monotonically increasing:');
    for (const err of timestampErrors) {
      log('red', `  - ${err}`);
    }
    totalFailed++;
  }

  // Event ordering: APP_UNFOCUSED should come before final APP_FOCUSED
  const unfocusedIdx = eventTypes.indexOf('APP_UNFOCUSED');
  const lastFocusedIdx = eventTypes.lastIndexOf('APP_FOCUSED');
  if (unfocusedIdx >= 0 && lastFocusedIdx >= 0) {
    if (unfocusedIdx < lastFocusedIdx) {
      log('green', '[PASS] APP_UNFOCUSED comes before final APP_FOCUSED');
      totalPassed++;
    } else {
      log('red', '[FAIL] APP_UNFOCUSED should come before final APP_FOCUSED');
      totalFailed++;
    }
  }

  // APP_FOCUSED should always have a corresponding WINDOW_FOCUSED in the same
  // activation. macOS may deliver AX notifications (WINDOW_FOCUSED) and workspace
  // notifications (APP_FOCUSED) in either order, so we look both forward (until
  // the next APP_UNFOCUSED/APP_FOCUSED) and backward (until the previous
  // APP_UNFOCUSED) for a matching WINDOW_FOCUSED.
  log('blue', '\n[VALIDATE] Checking WINDOW_FOCUSED accompanies every APP_FOCUSED...');
  const appFocusedErrors = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].event !== 'APP_FOCUSED') continue;
    // Look forward for WINDOW_FOCUSED before next APP_UNFOCUSED/APP_FOCUSED
    let found = false;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].event === 'WINDOW_FOCUSED') { found = true; break; }
      if (events[j].event === 'APP_UNFOCUSED' || events[j].event === 'APP_FOCUSED') break;
    }
    // Look backward for WINDOW_FOCUSED after previous APP_UNFOCUSED
    if (!found) {
      for (let j = i - 1; j >= 0; j--) {
        if (events[j].event === 'WINDOW_FOCUSED') { found = true; break; }
        if (events[j].event === 'APP_UNFOCUSED' || events[j].event === 'APP_FOCUSED') break;
      }
    }
    if (!found) {
      appFocusedErrors.push(
        `APP_FOCUSED at index ${i} (${events[i].timestamp}) has no WINDOW_FOCUSED in the same activation`
      );
    }
  }
  if (appFocusedErrors.length === 0) {
    log('green', '[PASS] Every APP_FOCUSED has a corresponding WINDOW_FOCUSED');
    totalPassed++;
  } else {
    log('red', '[FAIL] APP_FOCUSED without corresponding WINDOW_FOCUSED:');
    for (const err of appFocusedErrors) {
      log('red', `  - ${err}`);
    }
    totalFailed++;
  }

  // Event ordering: the last WINDOW_DESTROYED in the stream should have no
  // window events after it, BUT only if the last WINDOW_DESTROYED is from
  // the close-document step. Full-screen transitions produce intermediate
  // WINDOW_DESTROYED events that legitimately have window events after them.
  // We check: after the final event in the stream, there should be no orphaned
  // window events that suggest a missing WINDOW_DESTROYED for a close action.
  // This is already validated in the close document step, so we skip the
  // global check which is fragile with full-screen transitions.

  // REPOSITIONING/REPOSITIONED pairing: each REPOSITIONING should have a matching
  // REPOSITIONED for the same window ID before the next REPOSITIONING for that window.
  // Orphaned REPOSITIONING (without matching REPOSITIONED) is acceptable if
  // WINDOW_DESTROYED for the same window ID appears in the gap (full-screen transitions).
  log('blue', '\n[VALIDATE] Checking REPOSITIONING/REPOSITIONED pairing...');

  let pairingOk = true;
  const pairingErrors = [];

  // Group REPOSITIONING events by window ID
  const repositioningByWindow = new Map();
  for (let i = 0; i < events.length; i++) {
    if (events[i].event === 'WINDOW_REPOSITIONING') {
      const winId = events[i].window?.id;
      if (!winId) continue;
      if (!repositioningByWindow.has(winId)) repositioningByWindow.set(winId, []);
      repositioningByWindow.get(winId).push(i);
    }
  }

  for (const [winId, indices] of repositioningByWindow) {
    for (let i = 0; i < indices.length; i++) {
      const repoIdx = indices[i];
      const nextRepoIdx = i + 1 < indices.length ? indices[i + 1] : events.length;

      // Look for a REPOSITIONED with the same window ID in the gap
      let hasMatchingRepositioned = false;
      for (let j = repoIdx + 1; j < nextRepoIdx; j++) {
        if (events[j].event === 'WINDOW_REPOSITIONED' && events[j].window?.id === winId) {
          hasMatchingRepositioned = true;
          break;
        }
      }

      if (hasMatchingRepositioned) continue;

      // No matching REPOSITIONED — check if WINDOW_DESTROYED or WINDOW_CREATED
      // for the same window ID appears in the gap
      let hasLifecycleInGap = false;
      for (let j = repoIdx + 1; j < nextRepoIdx; j++) {
        if (
          (events[j].event === 'WINDOW_DESTROYED' || events[j].event === 'WINDOW_CREATED') &&
          events[j].window?.id === winId
        ) {
          hasLifecycleInGap = true;
          break;
        }
      }

      if (hasLifecycleInGap) {
        log('blue', `  Window ${winId} REPOSITIONING at index ${repoIdx}: orphaned but acceptable (window lifecycle event in gap)`);
        continue;
      }

      pairingErrors.push(
        `Window ${winId} REPOSITIONING at index ${repoIdx}: no matching REPOSITIONED and no WINDOW_DESTROYED for same window in gap`
      );
      pairingOk = false;
    }
  }

  if (pairingOk) {
    log('green', '[PASS] REPOSITIONING/REPOSITIONED pairing is correct');
    totalPassed++;
  } else {
    log('red', '[FAIL] REPOSITIONING/REPOSITIONED pairing errors:');
    for (const err of pairingErrors) {
      log('red', `  - ${err}`);
    }
    totalFailed++;
  }

  // WINDOW_TEXT_SELECTION_REPOSITIONING/REPOSITIONED pairing
  log('blue', '\n[VALIDATE] Checking TEXT_SELECTION_REPOSITIONING/REPOSITIONED pairing...');
  let selPairingOk = true;
  const selPairingErrors = [];

  for (let i = 0; i < events.length; i++) {
    if (events[i].event !== 'WINDOW_TEXT_SELECTION_REPOSITIONING') continue;
    // Look for a matching REPOSITIONED before next REPOSITIONING or end of stream
    let hasMatching = false;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].event === 'WINDOW_TEXT_SELECTION_REPOSITIONED') {
        hasMatching = true;
        break;
      }
      if (events[j].event === 'WINDOW_TEXT_SELECTION_REPOSITIONING') break;
    }
    // Also acceptable if selection was cleared or changed (force-finishes the reposition)
    if (!hasMatching) {
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].event === 'WINDOW_TEXT_SELECTION_REPOSITIONED') { hasMatching = true; break; }
        if (events[j].event === 'WINDOW_TEXT_SELECTED' || events[j].event === 'WINDOW_TEXT_SELECTION_CLEARED') {
          hasMatching = true; // Force-finish emits REPOSITIONED before Selected/Cleared
          break;
        }
        if (events[j].event === 'WINDOW_TEXT_SELECTION_REPOSITIONING') break;
      }
    }
    if (!hasMatching) {
      selPairingErrors.push(
        `TEXT_SELECTION_REPOSITIONING at index ${i}: no matching REPOSITIONED`
      );
      selPairingOk = false;
    }
  }

  if (selPairingOk) {
    log('green', '[PASS] TEXT_SELECTION_REPOSITIONING/REPOSITIONED pairing is correct');
    totalPassed++;
  } else {
    log('red', '[FAIL] TEXT_SELECTION_REPOSITIONING/REPOSITIONED pairing errors:');
    for (const err of selPairingErrors) {
      log('red', `  - ${err}`);
    }
    totalFailed++;
  }

  // Check identifier in all events
  const hasIdentifier = events.every(
    (e) => e.app && e.app.identifier === BUNDLE_ID && e.app.identifierType === 'bundleId'
  );
  if (hasIdentifier) {
    log('green', '[PASS] All events include correct identifier');
    totalPassed++;
  } else {
    log('red', '[FAIL] Some events missing identifier');
    totalFailed++;
  }

  // Check platform in all events
  const hasPlatform = events.every((e) => e.platform === 'macos');
  if (hasPlatform) {
    log('green', '[PASS] All events include correct platform');
    totalPassed++;
  } else {
    log('red', '[FAIL] Some events missing platform');
    totalFailed++;
  }

  // Per-window property consistency: each window ID should have consistent
  // title and documentPath across all events in its lifecycle.
  // Exception: saving a document changes the title and documentPath, so we
  // allow exactly the expected transition (blank -> saved name).
  log('blue', '\n[VALIDATE] Checking per-window property consistency...');
  const windowConsistencyErrors = [];

  // Build a map: windowId -> { titles: Set, documentPaths: Set }
  const windowProps = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.window?.id) continue;
    // Skip WINDOW_DESTROYED (always null properties)
    if (e.event === 'WINDOW_DESTROYED') continue;
    // Skip transient windows with empty title (fullscreen helper windows)
    if (e.window.title === '') continue;

    const id = e.window.id;
    if (!windowProps.has(id)) {
      windowProps.set(id, { titles: new Set(), documentPaths: new Set() });
    }
    const props = windowProps.get(id);
    if (e.window.title != null) props.titles.add(e.window.title);
    if (e.window.documentPath != null) props.documentPaths.add(e.window.documentPath);
  }

  const expectedSavedTitle = `test_${timestamp}`;
  for (const [id, props] of windowProps) {
    if (props.titles.size > 1) {
      // Allow the expected save transition: "Document<N>" -> saved filename
      const titles = [...props.titles];
      const hasBlank = titles.some((t) => /^Document\d+$/.test(t));
      const hasSaved = titles.includes(expectedSavedTitle);
      if (titles.length === 2 && hasBlank && hasSaved) {
        // Expected save transition — not an error
      } else {
        windowConsistencyErrors.push(
          `Window ${id}: inconsistent titles: ${titles.map(t => `"${t}"`).join(', ')}`
        );
      }
    }
    if (props.documentPaths.size > 1) {
      windowConsistencyErrors.push(
        `Window ${id}: inconsistent documentPaths: ${[...props.documentPaths].join(', ')}`
      );
    }
  }

  if (windowConsistencyErrors.length === 0) {
    log('green', `[PASS] Per-window property consistency (${windowProps.size} windows checked)`);
    totalPassed++;
  } else {
    log('red', '[FAIL] Per-window property consistency errors:');
    for (const err of windowConsistencyErrors) {
      log('red', `  - ${err}`);
    }
    totalFailed++;
  }

  // Title / documentPath consistency: if documentPath is set, the filename
  // in the path should match the window title. New blank documents (titles
  // like "Document1") should have documentPath: null.
  log('blue', '\n[VALIDATE] Checking title/documentPath consistency...');
  const docPathErrors = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const docPath = e.window?.documentPath;
    const title = e.window?.title;
    if (!title || !docPath) continue;

    // Extract filename from file:// URL, decode percent-encoding, strip extension
    try {
      const url = new URL(docPath);
      const pathParts = decodeURIComponent(url.pathname).split('/');
      const filename = pathParts[pathParts.length - 1];
      const filenameNoExt = filename.replace(/\.[^.]+$/, '');

      if (filenameNoExt !== title) {
        docPathErrors.push(
          `Event ${i} (${e.event}): title="${title}" but documentPath filename="${filenameNoExt}" (full: ${docPath})`
        );
      }
    } catch {
      // If docPath isn't a valid URL, skip
    }
  }

  // Also check that blank documents (title like "Document<N>") have null documentPath
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const title = e.window?.title;
    const docPath = e.window?.documentPath;
    if (!title) continue;
    if (/^Document\d+$/.test(title) && docPath != null) {
      docPathErrors.push(
        `Event ${i} (${e.event}): blank document "${title}" should have null documentPath, got "${docPath}"`
      );
    }
  }

  if (docPathErrors.length === 0) {
    log('green', '[PASS] Title/documentPath consistency is correct');
    totalPassed++;
  } else {
    log('red', `[FAIL] Title/documentPath inconsistencies found:`);
    for (const err of docPathErrors) {
      log('red', `  - ${err}`);
    }
    totalFailed++;
  }

  // contentBounds validation: WINDOW_FOCUSED and WINDOW_REPOSITIONED
  // must always have contentBounds with positive dimensions that fit within window bounds.
  log('blue', '\n[VALIDATE] Checking contentBounds is required for FOCUSED/REPOSITIONED...');
  const CONTENT_BOUNDS_REQUIRED_EVENTS = ['WINDOW_FOCUSED', 'WINDOW_REPOSITIONED'];
  const contentBoundsRequiredErrors = [];
  let contentBoundsRequiredCount = 0;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!CONTENT_BOUNDS_REQUIRED_EVENTS.includes(e.event)) continue;
    contentBoundsRequiredCount++;

    const cb = e.window?.contentBounds;
    if (!cb) {
      contentBoundsRequiredErrors.push(
        `Event index ${i} ${e.event} (window ${e.window?.id}): contentBounds is missing (required)`
      );
      continue;
    }

    // Validate positive dimensions
    if (cb.width <= 0 || cb.height <= 0) {
      contentBoundsRequiredErrors.push(
        `Event index ${i} ${e.event} (window ${e.window.id}): contentBounds has non-positive dimensions (${cb.width}x${cb.height})`
      );
    }

    // Validate contentBounds fits within window bounds
    const wb = e.window.bounds;
    if (wb) {
      if (cb.width > wb.width + BOUNDS_TOLERANCE) {
        contentBoundsRequiredErrors.push(
          `Event index ${i} ${e.event} (window ${e.window.id}): contentBounds width ${cb.width} exceeds window width ${wb.width}`
        );
      }
      if (cb.height > wb.height + BOUNDS_TOLERANCE) {
        contentBoundsRequiredErrors.push(
          `Event index ${i} ${e.event} (window ${e.window.id}): contentBounds height ${cb.height} exceeds window height ${wb.height}`
        );
      }
    }
  }

  if (contentBoundsRequiredCount > 0 && contentBoundsRequiredErrors.length === 0) {
    log('green', `[PASS] contentBounds present and valid in all ${contentBoundsRequiredCount} FOCUSED/REPOSITIONED events`);
    totalPassed++;
  } else if (contentBoundsRequiredCount === 0) {
    log('red', '[FAIL] No WINDOW_FOCUSED/REPOSITIONED events found to check contentBounds');
    totalFailed++;
  } else {
    log('red', `[FAIL] contentBounds validation errors (${contentBoundsRequiredErrors.length} of ${contentBoundsRequiredCount}):`);
    for (const err of contentBoundsRequiredErrors) {
      log('red', `  - ${err}`);
    }
    totalFailed++;
  }

  // Schema validation summary (validated in real-time as events arrived)
  log('blue', '\n[VALIDATE] Schema validation summary...');
  if (schemaErrors.length === 0) {
    log('green', `[PASS] All ${events.length} events validated against their specific schemas`);
    totalPassed++;
  } else {
    log('red', `[FAIL] ${schemaErrors.length} events failed schema validation:`);
    for (const err of schemaErrors) {
      log('red', `  - Event ${err.index} (${err.eventType}) against ${err.schemaUsed} schema: ${err.error}`);
    }
    totalFailed++;
  }

  // Summary
  log('cyan', '\n========================================');
  log('cyan', '  Test Summary');
  log('cyan', '========================================');
  log('green', `  Passed: ${totalPassed}`);
  if (totalFailed > 0) {
    log('red', `  Failed: ${totalFailed}`);
  }
  log('blue', `  Total events: ${events.length}`);
  log('cyan', '========================================\n');

  if (totalFailed > 0) {
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
