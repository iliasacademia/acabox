#!/usr/bin/env node

/**
 * Standalone integration test runner for window-monitor.
 *
 * This script can be run directly without Jest for manual testing:
 *   node window-monitor/test/run-integration-test.js
 *
 * Or via npm:
 *   npm run test:window-monitor
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration
const WINDOW_MONITOR_DIR = path.join(__dirname, '..');
const WINDOW_MONITOR_PATH = path.join(WINDOW_MONITOR_DIR, 'window-monitor');
const BUNDLE_ID = process.argv[2] || 'com.microsoft.Word';
const LOG_FILE = path.join(os.tmpdir(), 'window-monitor-test.log');

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
  let stderrOutput = '';

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
        log('cyan', `[EVENT] ${event.event}`);
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

    // Move window
    log('blue', '[ACTION] Moving window...');
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          set position of window 1 to {150, 150}
        end tell
      end tell
    `);
    await delay(2000);

    // Resize window
    log('blue', '[ACTION] Resizing window...');
    runAppleScript(`
      tell application "System Events"
        tell process "Microsoft Word"
          set size of window 1 to {900, 700}
        end tell
      end tell
    `);
    await delay(2000);

    // Switch apps
    log('blue', '[ACTION] Switching to Finder...');
    runAppleScript('tell application "Finder" to activate');
    await delay(1000);

    log('blue', '[ACTION] Switching back to Word...');
    runAppleScript('tell application "Microsoft Word" to activate');
    await delay(1000);

    // Close document
    log('blue', '[ACTION] Closing document...');
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

  // Check repositioning
  if (eventTypes.includes('WINDOW_REPOSITIONING') || eventTypes.includes('WINDOW_REPOSITIONED')) {
    log('green', '[PASS] Window repositioning events captured');
    passed++;
  } else {
    log('red', '[FAIL] Missing repositioning events');
    failed++;
  }

  // Check focus events
  if (eventTypes.includes('APP_UNFOCUSED')) {
    log('green', '[PASS] App unfocused event captured');
    passed++;
  } else {
    log('red', '[FAIL] Missing app unfocused event');
    failed++;
  }

  if (eventTypes.includes('APP_FOCUSED')) {
    log('green', '[PASS] App focused event captured');
    passed++;
  } else {
    log('red', '[FAIL] Missing app focused event');
    failed++;
  }

  // Check window destroyed
  if (eventTypes.includes('WINDOW_DESTROYED')) {
    log('green', '[PASS] Window destroyed event captured');
    passed++;
  } else {
    log('red', '[FAIL] Missing window destroyed event');
    failed++;
  }

  // Check identifier in events
  const hasIdentifier = events.every((e) => e.app && e.app.identifier === BUNDLE_ID && e.app.identifierType === 'bundleId');
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
