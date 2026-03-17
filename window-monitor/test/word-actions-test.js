#!/usr/bin/env node

/**
 * Integration test for word-actions binary.
 *
 * Opens a new Microsoft Word document and tests the --json one-off mode
 * for search_all, scroll, set_cursor, and read_document actions.
 *
 * Usage:
 *   node window-monitor/test/word-actions-test.js
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');

const RUST_DIR = path.join(__dirname, '..', 'rust');
const WORD_ACTIONS_BIN = process.env.WORD_ACTIONS_BIN || path.join(RUST_DIR, 'target', 'release', 'word-actions');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function runAppleScript(script) {
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf8',
      timeout: 15000,
    });
    return result.trim();
  } catch (error) {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the CGWindowID for the frontmost Microsoft Word document window.
 */
function getWordWindowId() {
  const swift = [
    'import CoreGraphics',
    'let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []',
    'for w in info {',
    '    let owner = w["kCGWindowOwnerName"] as? String ?? ""',
    '    let layer = w["kCGWindowLayer"] as? Int ?? -1',
    '    let bounds = w["kCGWindowBounds"] as? [String: Any] ?? [:]',
    '    let width = bounds["Width"] as? Double ?? 0',
    '    if owner == "Microsoft Word" && layer == 0 && width > 100 {',
    '        if let num = w["kCGWindowNumber"] as? Int { print(num); exit(0) }',
    '    }',
    '}',
    'print("NOT_FOUND")',
  ].map(line => `-e '${line}'`).join(' ');

  try {
    const result = execSync(`swift ${swift}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
    return result.trim();
  } catch (error) {
    log('yellow', `[WARN] Swift error: ${error.message}`);
    return null;
  }
}

/**
 * Run a one-off action using --json flag.
 */
function runOneOff(action) {
  const jsonStr = JSON.stringify(action);
  const result = execFileSync(WORD_ACTIONS_BIN, ['--json', jsonStr], {
    encoding: 'utf8',
    timeout: 10000,
  });
  return JSON.parse(result.trim());
}

async function main() {
  let passed = 0;
  let failed = 0;

  // =========================================================================
  // Build
  // =========================================================================
  log('blue', '\n[BUILD] Building word-actions (release)...');
  try {
    execSync('cargo build --release', {
      cwd: RUST_DIR,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    log('green', '[BUILD] Build successful');
  } catch (error) {
    log('red', `[BUILD] Build failed: ${error.message}`);
    process.exit(1);
  }

  // =========================================================================
  // Check Word is installed
  // =========================================================================
  log('blue', '\n[SETUP] Checking if Microsoft Word is installed...');
  const wordInstalled = runAppleScript(
    'tell application "Finder" to exists application file id "com.microsoft.Word"'
  );
  if (wordInstalled !== 'true') {
    log('yellow', '[SKIP] Microsoft Word is not installed. Skipping test.');
    process.exit(0);
  }
  log('green', '[SETUP] Microsoft Word is installed');

  // =========================================================================
  // Open Word and create a new document
  // =========================================================================
  log('blue', '\n[SETUP] Opening Microsoft Word...');
  runAppleScript('tell application "Microsoft Word" to activate');
  await delay(2000);

  log('blue', '[SETUP] Creating new document...');
  runAppleScript('tell application "Microsoft Word" to make new document');
  await delay(3000);

  // Focus the window
  runAppleScript(`
    tell application "System Events"
      tell process "Microsoft Word"
        set frontmost to true
        perform action "AXRaise" of window 1
      end tell
    end tell
  `);
  await delay(1000);

  // =========================================================================
  // Insert test content via AppleScript
  // =========================================================================
  log('blue', '[SETUP] Inserting test content via AppleScript...');
  runAppleScript(
    'tell application "Microsoft Word" to insert text "Hello from word-actions! This is test content. UNIQUE_MARKER here. And UNIQUE_MARKER again." at end of text object of active document'
  );
  await delay(1000);

  // =========================================================================
  // Get the CGWindowID
  // =========================================================================
  log('blue', '[SETUP] Getting Word window ID...');
  const windowId = getWordWindowId();
  if (!windowId || windowId === 'NOT_FOUND') {
    log('red', '[FAIL] Could not find Word window ID');
    process.exit(1);
  }
  const wid = parseInt(windowId, 10);
  log('green', `[SETUP] Word window ID: ${wid}`);

  // =========================================================================
  // Test 1: read_document
  // =========================================================================
  log('blue', '\n[TEST 1] Reading document via read_document action...');
  try {
    const result = runOneOff({
      action: 'read_document',
      window_id: wid,
    });

    if (result.success === true && result.action === 'read_document' && typeof result.text === 'string' && result.text.includes('Hello from word-actions!')) {
      log('green', `[PASS] read_document returned text (${result.length} chars)`);
      passed++;
    } else {
      log('red', `[FAIL] read_document returned: ${JSON.stringify(result).slice(0, 200)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] read_document failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 2: search_all (single match)
  // =========================================================================
  log('blue', '\n[TEST 2] search_all for "Hello from word-actions!"...');
  try {
    const result = runOneOff({
      action: 'search_all',
      window_id: wid,
      text: 'Hello from word-actions!',
    });

    if (result.success === true && result.action === 'search_all' && Array.isArray(result.matches) && result.matches.length === 1) {
      const m = result.matches[0];
      log('green', `[PASS] search_all found 1 match at position ${m.position}, length ${m.length}`);
      if (typeof m.context === 'string' && m.context.includes('Hello from word-actions!')) {
        log('green', `[PASS] search_all match has context: "${m.context.slice(0, 60)}..."`);
        passed++;
      } else {
        log('red', `[FAIL] search_all match missing context`);
        failed++;
      }
      passed++;
    } else {
      log('red', `[FAIL] search_all returned: ${JSON.stringify(result).slice(0, 200)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] search_all failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 3: search_all (multiple matches)
  // =========================================================================
  log('blue', '\n[TEST 3] search_all for "UNIQUE_MARKER" (should find 2)...');
  try {
    const result = runOneOff({
      action: 'search_all',
      window_id: wid,
      text: 'UNIQUE_MARKER',
    });

    if (result.success === true && Array.isArray(result.matches) && result.matches.length === 2) {
      log('green', `[PASS] search_all found 2 matches for duplicate text`);
      log('green', `  Match 0: position=${result.matches[0].position}`);
      log('green', `  Match 1: position=${result.matches[1].position}`);
      passed++;
    } else {
      log('red', `[FAIL] search_all for duplicates returned: ${JSON.stringify(result).slice(0, 300)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] search_all multi-match failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 4: search_all (no matches)
  // =========================================================================
  log('blue', '\n[TEST 4] search_all for non-existent text...');
  try {
    const result = runOneOff({
      action: 'search_all',
      window_id: wid,
      text: 'THIS_DOES_NOT_EXIST_ANYWHERE_99999',
    });

    if (result.success === true && result.action === 'search_all' && Array.isArray(result.matches) && result.matches.length === 0) {
      log('green', '[PASS] search_all correctly returned empty matches for non-existent text');
      passed++;
    } else {
      log('red', `[FAIL] search_all should have returned empty matches: ${JSON.stringify(result).slice(0, 200)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] search_all failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 5: set_cursor (position only)
  // =========================================================================
  log('blue', '\n[TEST 5] Setting cursor position...');
  try {
    const result = runOneOff({
      action: 'set_cursor',
      window_id: wid,
      position: 0,
    });

    if (result.success === true && result.action === 'set_cursor') {
      log('green', '[PASS] set_cursor returned success');
      passed++;
    } else {
      log('red', `[FAIL] set_cursor returned: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] set_cursor failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 6: set_cursor (with selection range)
  // =========================================================================
  log('blue', '\n[TEST 6] Setting cursor with selection range...');
  try {
    const result = runOneOff({
      action: 'set_cursor',
      window_id: wid,
      position: 0,
      length: 5,
    });

    if (result.success === true && result.action === 'set_cursor') {
      log('green', '[PASS] set_cursor with range returned success');
      passed++;
    } else {
      log('red', `[FAIL] set_cursor with range returned: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] set_cursor with range failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 7: scroll
  // =========================================================================
  log('blue', '\n[TEST 7] Scrolling to position 0...');
  try {
    const result = runOneOff({
      action: 'scroll',
      window_id: wid,
      position: 0,
    });

    if (result.success === true && result.action === 'scroll') {
      log('green', '[PASS] scroll returned success');
      passed++;
    } else {
      log('red', `[FAIL] scroll returned: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] scroll failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 8: Unknown action
  // =========================================================================
  log('blue', '\n[TEST 8] Sending unknown action...');
  try {
    const result = runOneOff({
      action: 'nonexistent_action',
      window_id: wid,
    });

    if (result.success === false && result.error && result.error.includes('Unknown action')) {
      log('green', '[PASS] Unknown action correctly returned error');
      passed++;
    } else {
      log('red', `[FAIL] Unknown action should have errored: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] Unknown action test failed: ${error.message}`);
    failed++;
  }

  // =========================================================================
  // Test 9: Save document to temp path for close/open tests
  // =========================================================================
  log('blue', '\n[SETUP] Saving document to temp path for close/open tests...');
  const os = require('os');
  const fs = require('fs');
  const tmpDir = os.tmpdir();
  const tmpDocPath = path.join(tmpDir, `word-actions-test-${Date.now()}.docx`);
  runAppleScript(
    `tell application "Microsoft Word" to save as active document file name "${tmpDocPath.replace(/"/g, '\\"')}"`
  );
  await delay(2000);

  // =========================================================================
  // Test 9: close_window
  // =========================================================================
  log('blue', '\n[TEST 9] Closing document via close_window action...');
  try {
    const result = runOneOff({
      action: 'close_window',
      window_id: wid,
      activate: true,
      save: false,
    });

    if (result.success === true && result.action === 'close_window') {
      log('green', '[PASS] close_window returned success');
      passed++;
    } else {
      log('red', `[FAIL] close_window returned: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] close_window failed: ${error.message}`);
    failed++;
  }
  await delay(1000);

  // =========================================================================
  // Test 10: open_window
  // =========================================================================
  log('blue', `\n[TEST 10] Opening document via open_window action (${tmpDocPath})...`);
  try {
    const result = runOneOff({
      action: 'open_window',
      file_path: tmpDocPath,
    });

    if (result.success === true && result.action === 'open_window') {
      log('green', '[PASS] open_window returned success');
      passed++;
    } else {
      log('red', `[FAIL] open_window returned: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (error) {
    log('red', `[FAIL] open_window failed: ${error.message}`);
    failed++;
  }
  await delay(3000);

  // =========================================================================
  // Test 11: read_document on reopened file
  // =========================================================================
  log('blue', '\n[TEST 11] Reading reopened document...');
  const newWid = (() => {
    const id = getWordWindowId();
    return id && id !== 'NOT_FOUND' ? parseInt(id, 10) : null;
  })();

  if (newWid) {
    log('green', `[SETUP] Reopened document window ID: ${newWid}`);
    try {
      const result = runOneOff({
        action: 'read_document',
        window_id: newWid,
        activate: true,
      });

      if (result.success === true && result.action === 'read_document' && typeof result.text === 'string' && result.text.includes('Hello from word-actions!')) {
        log('green', `[PASS] read_document on reopened file returned text (${result.length} chars)`);
        passed++;
      } else {
        log('red', `[FAIL] read_document on reopened file returned: ${JSON.stringify(result).slice(0, 200)}`);
        failed++;
      }
    } catch (error) {
      log('red', `[FAIL] read_document on reopened file failed: ${error.message}`);
      failed++;
    }
  } else {
    log('red', '[FAIL] Could not get window ID for reopened document');
    failed++;
  }

  // =========================================================================
  // Cleanup
  // =========================================================================
  log('blue', '\n[CLEANUP] Closing document without saving...');
  runAppleScript(
    'tell application "Microsoft Word" to close active document saving no'
  );
  await delay(500);

  // Clean up temp file
  try { fs.unlinkSync(tmpDocPath); } catch (_) {}

  // =========================================================================
  // Summary
  // =========================================================================
  log('blue', '\n========================================');
  log('green', `  Passed: ${passed}`);
  if (failed > 0) log('red', `  Failed: ${failed}`);
  log('blue', '========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log('red', `[ERROR] ${err.message}`);
  process.exit(1);
});
