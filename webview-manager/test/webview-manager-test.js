#!/usr/bin/env node

/**
 * Standalone integration test for webview-manager (macOS).
 *
 * Spawns the webview-manager binary, sends desired state JSON via stdin,
 * and verifies visual behavior by taking screenshots with screencapture
 * and analyzing pixels with the canvas npm package.
 *
 * Run directly:
 *   node webview-manager/test/webview-manager-test.js
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createCanvas, loadImage } = require('canvas');
const readline = require('readline');

// ── Paths ──────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const WEBVIEW_MANAGER_DIR = path.join(PROJECT_ROOT, 'webview-manager');
const BINARY_PATH = process.env.WEBVIEW_MANAGER_BIN ||
  path.join(WEBVIEW_MANAGER_DIR, 'rust', 'target', 'release', 'webview-manager');
const POPUP_DIR = path.join(PROJECT_ROOT, 'dist', 'popup', 'academiaNotificationsButton');
const SCREENSHOT_DIR = path.join(PROJECT_ROOT, 'tmp', 'webview-manager-test');

// ── Test Constants ─────────────────────────────────────────────────────────────

const PANEL_WIDTH = 200;
const PANEL_HEIGHT = 80;
const PANEL_X = 100;           // Cocoa: 100px from left edge
const PANEL_Y = 200;           // Cocoa: 200px from bottom
const REPOSITION_X = 400;      // New position for REPOSITION test
const REPOSITION_Y = 300;
const PAGE_LOAD_DELAY_MS = 4000;  // Wait for URL load + React mount + first poll + re-render
const COMMAND_DELAY_MS = 500;      // Wait after show/hide/reposition for panel to update
const PIXEL_DIFF_THRESHOLD = 0.02; // 2% of pixels must differ to be "significantly different"
const PIXEL_CHANNEL_THRESHOLD = 30; // Sum of |dR|+|dG|+|dB| to consider a pixel "different"

// ── Colors ─────────────────────────────────────────────────────────────────────

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Screenshot Helpers ─────────────────────────────────────────────────────────

let screenHeight = 0;

async function getScreenHeight() {
  // Capture a 1x1 logical-pixel region to determine the Retina scale factor
  const scalePath = path.join(SCREENSHOT_DIR, '_scale_probe.png');
  execSync(`screencapture -x -R 0,0,1,1 -t png "${scalePath}"`);
  const scaleImg = await loadImage(scalePath);
  const scaleFactor = scaleImg.width; // e.g. 2 on Retina

  // Capture full screen to get physical pixel dimensions
  const tmpPath = path.join(SCREENSHOT_DIR, '_screen_size.png');
  execSync(`screencapture -x -t png "${tmpPath}"`);
  const img = await loadImage(tmpPath);
  return img.height / scaleFactor; // logical pixels = Cocoa screen height
}

/**
 * Convert Cocoa coordinates (bottom-left origin) to screencapture coordinates (top-left origin).
 */
function cocoaToScreenCapture(x, y, width, height) {
  return { x, y: screenHeight - y - height, width, height };
}

/**
 * Take a screenshot of a region (in screen coords) and save to SCREENSHOT_DIR.
 */
function takeScreenshot(x, y, w, h, filename) {
  const outputPath = path.join(SCREENSHOT_DIR, filename);
  execSync(`screencapture -x -R ${x},${y},${w},${h} -t png "${outputPath}"`);
  return outputPath;
}

/**
 * Load PNG and return pixel data as Uint8ClampedArray (RGBA).
 */
async function loadPixels(filePath) {
  const img = await loadImage(filePath);
  const cvs = createCanvas(img.width, img.height);
  const ctx = cvs.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height).data;
}

/**
 * Compare two pixel buffers — returns the fraction of pixels that differ significantly.
 */
function pixelDiffFraction(pixels1, pixels2) {
  let diffCount = 0;
  const totalPixels = pixels1.length / 4;
  for (let i = 0; i < pixels1.length; i += 4) {
    const dr = Math.abs(pixels1[i] - pixels2[i]);
    const dg = Math.abs(pixels1[i + 1] - pixels2[i + 1]);
    const db = Math.abs(pixels1[i + 2] - pixels2[i + 2]);
    if (dr + dg + db > PIXEL_CHANNEL_THRESHOLD) diffCount++;
  }
  return diffCount / totalPixels;
}

/**
 * Take a screenshot at the given Cocoa position and compare with a baseline.
 * Returns { diff, path } where diff is the fraction of significantly different pixels.
 */
async function captureAndCompare(cocoaX, cocoaY, width, height, filename, baselinePixels) {
  const sc = cocoaToScreenCapture(cocoaX, cocoaY, width, height);
  const screenshotPath = takeScreenshot(sc.x, sc.y, sc.width, sc.height, filename);
  const pixels = await loadPixels(screenshotPath);
  const diff = pixelDiffFraction(baselinePixels, pixels);
  return { diff, path: screenshotPath };
}

// ── Communication with webview-manager ─────────────────────────────────────────

/**
 * Send a desired state to webview-manager's stdin and wait for expectedResponseCount
 * JSON response lines on stdout.
 */
function sendState(proc, rl, state, expectedResponseCount) {
  return new Promise((resolve, reject) => {
    const responses = [];

    if (expectedResponseCount === 0) {
      proc.stdin.write(JSON.stringify(state) + '\n');
      resolve(responses);
      return;
    }

    const timeout = setTimeout(() => {
      rl.removeListener('line', handler);
      reject(new Error(`Timeout waiting for responses (got ${responses.length}/${expectedResponseCount})`));
    }, 10000);

    const handler = (line) => {
      try {
        const resp = JSON.parse(line);
        responses.push(resp);
        if (responses.length >= expectedResponseCount) {
          clearTimeout(timeout);
          rl.removeListener('line', handler);
          resolve(responses);
        }
      } catch {
        // Not JSON, keep waiting
      }
    };
    rl.on('line', handler);
    proc.stdin.write(JSON.stringify(state) + '\n');
  });
}

// ── Click Simulation ──────────────────────────────────────────────────────────

/**
 * Simulate a mouse click at screen coordinates (top-left origin) using CGEvent via JXA.
 * Moves the cursor first, then sends mouseDown + mouseUp with a small delay.
 * Requires Accessibility permission for the terminal.
 * Returns true if the click was dispatched, false if permission was denied.
 */
function simulateClick(screenX, screenY) {
  try {
    // Use kCGHIDEventTap for all events so the window server assigns proper
    // window numbers. Move the cursor first so macOS knows which window is
    // under the pointer, then click.
    execSync(`osascript -l JavaScript -e '
      ObjC.import("CoreGraphics");
      var point = $.CGPointMake(${screenX}, ${screenY});

      // Move cursor so window server updates hit-test tracking
      var move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
      $.CGEventPost($.kCGHIDEventTap, move);
      delay(0.2);

      // Click via global HID tap — window server routes to correct window
      var down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, 1);
      $.CGEventPost($.kCGHIDEventTap, down);
      delay(0.05);
      var up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, 1);
      $.CGEventPost($.kCGHIDEventTap, up);
    '`, { timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

// ── Test HTTP Server ───────────────────────────────────────────────────────────

let clickCallbackReceived = false;

function startTestServer() {
  return new Promise((resolve) => {
    const MIME = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // Mock poll endpoint: GET /word/:pid/poll
      if (/^\/word\/\d+\/poll$/.test(pathname)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          notificationCount: 1,
          isActive: true,
          shouldShowButtonV2: true,
        }));
        return;
      }

      // Static file serving from dist/popup/
      // URL: /ui/popup/academiaNotificationsButton/... → dist/popup/academiaNotificationsButton/...
      if (pathname.startsWith('/ui/popup/')) {
        const relPath = pathname.replace('/ui/popup/', '');
        // Serve index.html for directory requests
        const filePath = relPath.endsWith('/') || !path.extname(relPath)
          ? path.join(POPUP_DIR, 'index.html')
          : path.join(PROJECT_ROOT, 'dist', 'popup', relPath);

        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath);
          const contentType = MIME[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      // Click-test page: red body that turns green on any mouse event
      if (pathname === '/click-test') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><body style="margin:0;background:#ff0000;height:100vh;display:flex;align-items:center;justify-content:center">
<span style="color:#fff;font-size:20px;pointer-events:none">CLICK</span>
<script>
document.body.addEventListener('mousedown', function() {
  document.body.style.background = '#00ff00';
  document.querySelector('span').textContent = 'OK';
  fetch('/click-callback').catch(function(){});
});
</script>
</body></html>`);
        return;
      }

      // Click callback — records that a click reached the web content
      if (pathname === '/click-callback') {
        clickCallbackReceived = true;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// ── Test Runner ────────────────────────────────────────────────────────────────

async function runTest() {
  let totalPassed = 0;
  let totalFailed = 0;
  let proc = null;
  let testServer = null;

  function assert(stepName, condition, diff) {
    if (condition) {
      const msg = diff != null ? ` (${(diff * 100).toFixed(1)}% pixel diff)` : '';
      log('green', `[PASS] ${stepName}${msg}`);
      totalPassed++;
    } else {
      const msg = diff != null ? ` (${(diff * 100).toFixed(1)}% pixel diff)` : '';
      log('red', `[FAIL] ${stepName}${msg}`);
      totalFailed++;
    }
  }

  log('cyan', '\nwebview-manager integration test');
  log('cyan', '---');

  try {
    // ── Prerequisites ──────────────────────────────────────────────────────────

    // Clean and create screenshot directory
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // Build popup if needed
    if (!fs.existsSync(path.join(POPUP_DIR, 'index.html'))) {
      log('blue', 'Building popup...');
      execSync('npm run build:popup', { cwd: PROJECT_ROOT, stdio: 'inherit' });
      log('blue', 'Building popup... done');
    }

    // Build binary if needed
    if (!fs.existsSync(BINARY_PATH)) {
      log('blue', 'Building binary...');
      execSync('cargo build --release', {
        cwd: path.join(WEBVIEW_MANAGER_DIR, 'rust'),
        stdio: 'inherit',
      });
      log('blue', 'Building binary... done');
    }

    // Get screen height
    screenHeight = await getScreenHeight();
    log('blue', `Screen height: ${screenHeight}`);

    // ── Start Test HTTP Server ─────────────────────────────────────────────────

    const { server, port } = await startTestServer();
    testServer = server;
    log('blue', `Test server listening on port ${port}`);

    // ── Take Baseline Screenshot ───────────────────────────────────────────────

    const sc1 = cocoaToScreenCapture(PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT);
    const baselinePath1 = takeScreenshot(sc1.x, sc1.y, sc1.width, sc1.height, '01-baseline-pos1.png');
    const baselinePixels1 = await loadPixels(baselinePath1);

    // ── Spawn webview-manager ──────────────────────────────────────────────────

    const debugLogPath = path.join(SCREENSHOT_DIR, 'webview-manager-debug.log');
    proc = spawn(BINARY_PATH, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WEBVIEW_MANAGER_DEBUG_LOG: debugLogPath },
    });

    let stderrOutput = '';
    proc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    const rl = readline.createInterface({ input: proc.stdout });

    // Wait for the binary to be ready (it prints "webview-manager: ready" to stderr)
    await new Promise((resolve) => {
      const checkReady = (data) => {
        if (data.toString().includes('ready')) {
          proc.stderr.removeListener('data', checkReady);
          resolve();
        }
      };
      proc.stderr.on('data', checkReady);
      // Timeout in case "ready" message is already consumed
      setTimeout(resolve, 2000);
    });

    log('blue', `Spawned webview-manager (pid ${proc.pid})`);

    // ── Shared state for test steps ──────────────────────────────────────────

    const createUrl = `http://127.0.0.1:${port}/ui/popup/academiaNotificationsButton/?pid=12345`;
    const frame1 = { x: PANEL_X, y: PANEL_Y, width: PANEL_WIDTH, height: PANEL_HEIGHT };
    const frame2 = { x: REPOSITION_X, y: REPOSITION_Y, width: PANEL_WIDTH, height: PANEL_HEIGHT };

    // ── Step 1: CREATE (hidden) ───────────────────────────────────────────────

    log('blue', '\n[STEP 1] CREATE (panel starts hidden)');
    const createResps = await sendState(proc, rl, {
      'wv-1': { url: createUrl, visible: false, frame: frame1 },
    }, 1);
    assert('CREATE: Response status is OK', createResps[0].status === 'OK');
    assert('CREATE: Response command is CREATE', createResps[0].command === 'CREATE');

    await delay(COMMAND_DELAY_MS);
    const { diff: createDiff } = await captureAndCompare(
      PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '02-after-create.png', baselinePixels1
    );
    assert('CREATE: Panel is hidden', createDiff < PIXEL_DIFF_THRESHOLD, createDiff);

    // ── Step 2: SHOW ───────────────────────────────────────────────────────────

    log('blue', '\n[STEP 2] SHOW');
    const showResps = await sendState(proc, rl, {
      'wv-1': { url: createUrl, visible: true, frame: frame1 },
    }, 1);
    assert('SHOW: Response status is OK', showResps[0].status === 'OK');
    assert('SHOW: Response command is SHOW', showResps[0].command === 'SHOW');

    await delay(PAGE_LOAD_DELAY_MS); // First show — page loads + polls + re-renders
    const showPath = path.join(SCREENSHOT_DIR, '03-after-show.png');
    {
      const sc = cocoaToScreenCapture(PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT);
      takeScreenshot(sc.x, sc.y, sc.width, sc.height, '03-after-show.png');
    }
    const showPixels1 = await loadPixels(showPath);
    const showDiff = pixelDiffFraction(baselinePixels1, showPixels1);
    assert('SHOW: Button is visible', showDiff >= PIXEL_DIFF_THRESHOLD, showDiff);

    // ── Step 3: HIDE ───────────────────────────────────────────────────────────

    log('blue', '\n[STEP 3] HIDE');
    const hideResps = await sendState(proc, rl, {
      'wv-1': { url: createUrl, visible: false, frame: frame1 },
    }, 1);
    assert('HIDE: Response status is OK', hideResps[0].status === 'OK');
    assert('HIDE: Response command is HIDE', hideResps[0].command === 'HIDE');

    await delay(COMMAND_DELAY_MS);
    // Compare against the panel-visible screenshot — if panel is hidden, pixels should differ
    const { diff: hideDiff } = await captureAndCompare(
      PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '04-after-hide.png', showPixels1
    );
    assert('HIDE: Panel is hidden', hideDiff >= PIXEL_DIFF_THRESHOLD, hideDiff);

    // ── Step 4: SHOW again ─────────────────────────────────────────────────────

    log('blue', '\n[STEP 4] SHOW again');
    const show2Resps = await sendState(proc, rl, {
      'wv-1': { url: createUrl, visible: true, frame: frame1 },
    }, 1);
    assert('SHOW-2: Response status is OK', show2Resps[0].status === 'OK');
    assert('SHOW-2: Response command is SHOW', show2Resps[0].command === 'SHOW');

    await delay(COMMAND_DELAY_MS); // Page already loaded, just unhiding
    const { diff: show2Diff } = await captureAndCompare(
      PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '05-after-show2.png', baselinePixels1
    );
    assert('SHOW-2: Button is visible', show2Diff >= PIXEL_DIFF_THRESHOLD, show2Diff);

    // ── Step 5: REPOSITION ─────────────────────────────────────────────────────

    log('blue', '\n[STEP 5] REPOSITION');

    // Take new baseline at the reposition target (no panel there yet)
    const sc2 = cocoaToScreenCapture(REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT);
    const baselinePath2 = takeScreenshot(sc2.x, sc2.y, sc2.width, sc2.height, '06-baseline-pos2.png');
    const baselinePixels2 = await loadPixels(baselinePath2);

    // Take fresh snapshot of old position WITH the panel visible (for comparison after move)
    const scOldBefore = cocoaToScreenCapture(PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT);
    const oldBeforeRepoPath = takeScreenshot(scOldBefore.x, scOldBefore.y, scOldBefore.width, scOldBefore.height, '06b-old-before-reposition.png');
    const oldBeforeRepoPixels = await loadPixels(oldBeforeRepoPath);

    const repoResps = await sendState(proc, rl, {
      'wv-1': { url: createUrl, visible: true, frame: frame2 },
    }, 1);
    assert('REPOSITION: Response status is OK', repoResps[0].status === 'OK');
    assert('REPOSITION: Response command is REPOSITION', repoResps[0].command === 'REPOSITION');

    await delay(COMMAND_DELAY_MS);

    // Check new position — button should be visible there
    const { diff: repoNewDiff } = await captureAndCompare(
      REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '07-after-reposition-new.png', baselinePixels2
    );
    assert('REPOSITION: Button visible at new position', repoNewDiff >= PIXEL_DIFF_THRESHOLD, repoNewDiff);

    // Check old position — panel moved away, so should differ from pre-reposition (panel was there)
    const { diff: repoOldDiff } = await captureAndCompare(
      PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '08-after-reposition-old.png', oldBeforeRepoPixels
    );
    assert('REPOSITION: Old position is clear', repoOldDiff >= PIXEL_DIFF_THRESHOLD, repoOldDiff);

    // ── Step 5b: RESIZE to 1x1 ────────────────────────────────────────────────

    log('blue', '\n[STEP 5b] RESIZE to 1x1');

    // Capture before-shrink at the current position (panel visible, normal size)
    const scBeforeShrink = cocoaToScreenCapture(REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT);
    const beforeShrinkPath = takeScreenshot(scBeforeShrink.x, scBeforeShrink.y, scBeforeShrink.width, scBeforeShrink.height, '08a-before-shrink.png');
    const beforeShrinkPixels = await loadPixels(beforeShrinkPath);

    const frame1x1 = { x: REPOSITION_X, y: REPOSITION_Y, width: 1, height: 1 };
    const shrinkResps = await sendState(proc, rl, {
      'wv-1': { url: createUrl, visible: true, frame: frame1x1 },
    }, 1);
    assert('RESIZE-1x1: Response status is OK', shrinkResps[0].status === 'OK');
    assert('RESIZE-1x1: Response command is REPOSITION', shrinkResps[0].command === 'REPOSITION');

    await delay(COMMAND_DELAY_MS);

    // The normal-size region should now look different (panel shrank to 1x1)
    const { diff: shrinkDiff } = await captureAndCompare(
      REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '08b-after-shrink.png', beforeShrinkPixels
    );
    assert('RESIZE-1x1: Panel no longer fills region', shrinkDiff >= PIXEL_DIFF_THRESHOLD, shrinkDiff);

    // ── Step 5c: RESIZE back to normal ─────────────────────────────────────────

    log('blue', '\n[STEP 5c] RESIZE back to normal');

    // Capture the shrunk state for comparison (panel is 1x1, region looks like no panel)
    const scAfterShrink = cocoaToScreenCapture(REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT);
    const afterShrinkPath = takeScreenshot(scAfterShrink.x, scAfterShrink.y, scAfterShrink.width, scAfterShrink.height, '08b2-after-shrink-baseline.png');
    const afterShrinkPixels = await loadPixels(afterShrinkPath);

    const growResps = await sendState(proc, rl, {
      'wv-1': { url: createUrl, visible: true, frame: frame2 },
    }, 1);
    assert('RESIZE-RESTORE: Response status is OK', growResps[0].status === 'OK');
    assert('RESIZE-RESTORE: Response command is REPOSITION', growResps[0].command === 'REPOSITION');

    await delay(COMMAND_DELAY_MS);

    // After growing back, the region should differ from the shrunk state (panel visible again)
    const { diff: growDiff } = await captureAndCompare(
      REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '08c-after-grow.png', afterShrinkPixels
    );
    assert('RESIZE-RESTORE: Panel restored to normal size', growDiff >= PIXEL_DIFF_THRESHOLD, growDiff);

    // ── Step 5d: FIRST-CLICK TEST ──────────────────────────────────────────────

    log('blue', '\n[STEP 5d] FIRST-CLICK (acceptsFirstMouse)');

    // Reset callback flag
    clickCallbackReceived = false;

    // Switch wv-1 to the click-test page (URL change → DESTROY old + CREATE new)
    // Use a large, centered panel so it's easy to find and click
    const clickTestUrl = `http://127.0.0.1:${port}/click-test`;
    const clickFrame = { x: 400, y: 300, width: 400, height: 300 };
    const clickResps = await sendState(proc, rl, {
      'wv-1': { url: clickTestUrl, visible: true, frame: clickFrame },
    }, 3); // DESTROY + CREATE + SHOW
    assert('CLICK-SETUP: All responses OK',
      clickResps.every((r) => r.status === 'OK'),
    );

    await delay(PAGE_LOAD_DELAY_MS); // Wait for page load

    // Screenshot before click — page should be red
    const scClick = cocoaToScreenCapture(clickFrame.x, clickFrame.y, clickFrame.width, clickFrame.height);
    const beforeClickPath = takeScreenshot(scClick.x, scClick.y, scClick.width, scClick.height, '08d-before-click.png');
    const beforeClickPixels = await loadPixels(beforeClickPath);

    // Synthetic click — scClick gives top-left-origin rect; center it
    const clickCenterX = scClick.x + clickFrame.width / 2;
    const clickCenterY = scClick.y + clickFrame.height / 2;
    log('blue', `  Click coords: (${clickCenterX}, ${clickCenterY}) [screen top-left origin]`);
    log('blue', `  Panel scRect: (${scClick.x}, ${scClick.y}, ${scClick.width}, ${scClick.height})`);
    const clickDispatched = simulateClick(clickCenterX, clickCenterY);
    assert('FIRST-CLICK: CGEvent click dispatched', clickDispatched);
    await delay(2000);

    if (clickCallbackReceived) {
      const { diff: clickDiff } = await captureAndCompare(
        clickFrame.x, clickFrame.y, clickFrame.width, clickFrame.height,
        '08e-after-click.png', beforeClickPixels
      );
      assert('FIRST-CLICK: Click reached web content (acceptsFirstMouse works)', true);
      assert('FIRST-CLICK: Page changed color on click', clickDiff >= PIXEL_DIFF_THRESHOLD, clickDiff);
    } else {
      assert('FIRST-CLICK: Click reached web content (acceptsFirstMouse works)', false);
    }

    // ── Step 6: DESTROY ────────────────────────────────────────────────────────

    log('blue', '\n[STEP 6] DESTROY');

    // Capture the panel-visible state right before destroy (the background may
    // have changed since the earlier baseline due to terminal scrolling, so a
    // fresh "before" snapshot is needed for a reliable comparison)
    const sc2Before = cocoaToScreenCapture(REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT);
    const beforeDestroyPath = takeScreenshot(sc2Before.x, sc2Before.y, sc2Before.width, sc2Before.height, '09a-before-destroy.png');
    const beforeDestroyPixels = await loadPixels(beforeDestroyPath);

    // Send empty state → destroy all webviews
    const destroyResps = await sendState(proc, rl, {}, 1);
    assert('DESTROY: Response status is OK', destroyResps[0].status === 'OK');
    assert('DESTROY: Response command is DESTROY', destroyResps[0].command === 'DESTROY');

    await delay(COMMAND_DELAY_MS);

    // After destroy the panel should be gone — the region should look different
    // from the before-destroy screenshot (which had the panel visible)
    const { diff: destroyDiff } = await captureAndCompare(
      REPOSITION_X, REPOSITION_Y, PANEL_WIDTH, PANEL_HEIGHT,
      '09b-after-destroy.png', beforeDestroyPixels
    );
    assert('DESTROY: Panel is gone', destroyDiff >= PIXEL_DIFF_THRESHOLD, destroyDiff);

  } catch (error) {
    log('red', `\n[ERROR] ${error.message}`);
    if (error.stack) log('yellow', error.stack);
    totalFailed++;
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────

    if (proc && !proc.killed) {
      proc.stdin.end();
      // Give it a moment to shut down cleanly
      await delay(500);
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    }

    if (testServer) {
      testServer.close();
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  log('cyan', '\n---');
  log('cyan', `Results: ${totalPassed} passed, ${totalFailed} failed`);

  if (totalFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTest().catch((error) => {
  log('red', `[ERROR] ${error.message}`);
  process.exit(1);
});
