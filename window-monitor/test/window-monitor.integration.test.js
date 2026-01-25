/**
 * Integration test for window-monitor CLI tool.
 *
 * This test requires:
 * - Microsoft Word to be installed
 * - Accessibility permissions to be granted to the terminal/test runner
 * - The window-monitor binary to be built
 *
 * Run with: npm run test:window-monitor
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration
const WINDOW_MONITOR_PATH = path.join(__dirname, '..', 'window-monitor');
const BUNDLE_ID = 'com.microsoft.Word';
const TEST_TIMEOUT = 60000; // 60 seconds

// Helper to run AppleScript
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    try {
      const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8',
        timeout: 10000,
      });
      resolve(result.trim());
    } catch (error) {
      reject(error);
    }
  });
}

// Helper to delay
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Check if Microsoft Word is installed
async function isWordInstalled() {
  try {
    await runAppleScript(
      'tell application "System Events" to exists (processes where bundle identifier is "com.microsoft.Word")'
    );
    // Also check if app exists
    const result = await runAppleScript(
      'tell application "Finder" to exists application file id "com.microsoft.Word"'
    );
    return result === 'true';
  } catch {
    return false;
  }
}

// Check if window-monitor binary exists
function isBinaryBuilt() {
  return fs.existsSync(WINDOW_MONITOR_PATH);
}

describe('Window Monitor Integration Tests', () => {
  let monitorProcess = null;
  let events = [];
  let stderrOutput = '';

  beforeAll(async () => {
    // Check prerequisites
    if (!isBinaryBuilt()) {
      console.log('Building window-monitor...');
      try {
        execSync('make clean && make', {
          cwd: path.join(__dirname, '..'),
          encoding: 'utf8',
        });
      } catch (error) {
        throw new Error(`Failed to build window-monitor: ${error.message}`);
      }
    }

    const wordInstalled = await isWordInstalled();
    if (!wordInstalled) {
      console.warn('WARNING: Microsoft Word is not installed. Some tests will be skipped.');
    }
  });

  afterEach(async () => {
    // Kill monitor process if running
    if (monitorProcess && !monitorProcess.killed) {
      monitorProcess.kill('SIGTERM');
      await delay(500);
    }
    events = [];
    stderrOutput = '';
  });

  test('should display help with --help flag', () => {
    const result = execSync(`${WINDOW_MONITOR_PATH} --help 2>&1 || true`, {
      encoding: 'utf8',
    });
    expect(result).toContain('Usage:');
    expect(result).toContain('--bundle-id');
    expect(result).toContain('com.microsoft.Word');
  });

  test('should display help with -h flag', () => {
    const result = execSync(`${WINDOW_MONITOR_PATH} -h 2>&1 || true`, {
      encoding: 'utf8',
    });
    expect(result).toContain('Usage:');
  });

  test('should error on unknown option', () => {
    try {
      execSync(`${WINDOW_MONITOR_PATH} --unknown 2>&1`, {
        encoding: 'utf8',
      });
      fail('Should have thrown an error');
    } catch (error) {
      expect(error.stdout || error.stderr || error.message).toContain('Unknown option');
    }
  });

  test('should error when --bundle-id has no argument', () => {
    try {
      execSync(`${WINDOW_MONITOR_PATH} --bundle-id 2>&1`, {
        encoding: 'utf8',
      });
      fail('Should have thrown an error');
    } catch (error) {
      expect(error.stdout || error.stderr || error.message).toContain('requires an argument');
    }
  });

  // Skip Word tests if Word is not installed
  const wordTestFn = process.env.SKIP_WORD_TESTS ? test.skip : test;

  wordTestFn(
    'should capture window events when monitoring Microsoft Word',
    async () => {
      const wordInstalled = await isWordInstalled();
      if (!wordInstalled) {
        console.log('Skipping: Microsoft Word not installed');
        return;
      }

      // Start the monitor
      monitorProcess = spawn(WINDOW_MONITOR_PATH, ['--bundle-id', BUNDLE_ID], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      monitorProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            events.push(event);
          } catch {
            // Ignore non-JSON output (like log messages)
          }
        }
      });

      monitorProcess.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      // Wait for monitor to start
      await delay(2000);

      // Open Word and create a document
      await runAppleScript('tell application "Microsoft Word" to activate');
      await delay(1000);

      await runAppleScript('tell application "Microsoft Word" to make new document');
      await delay(2000);

      // Move the window
      await runAppleScript(`
        tell application "System Events"
          tell process "Microsoft Word"
            set position of window 1 to {100, 100}
          end tell
        end tell
      `);
      await delay(2000);

      // Resize the window
      await runAppleScript(`
        tell application "System Events"
          tell process "Microsoft Word"
            set size of window 1 to {800, 600}
          end tell
        end tell
      `);
      await delay(2000);

      // Switch to another app (Finder) and back
      await runAppleScript('tell application "Finder" to activate');
      await delay(1000);
      await runAppleScript('tell application "Microsoft Word" to activate');
      await delay(1000);

      // Close the document
      await runAppleScript('tell application "Microsoft Word" to close document 1 saving no');
      await delay(2000);

      // Stop monitoring
      monitorProcess.kill('SIGTERM');
      await delay(500);

      // Validate events
      const eventTypes = events.map((e) => e.event);
      console.log('Captured events:', eventTypes);

      // Check that we have app events
      expect(eventTypes).toContain('APP_EXISTING');
      // Or APP_LAUNCHED if Word wasn't running before

      // Check window events - at least some of these should be present
      const hasWindowCreated =
        eventTypes.includes('WINDOW_CREATED') || eventTypes.includes('WINDOW_EXISTING');
      expect(hasWindowCreated).toBe(true);

      // Check for repositioning events (from move/resize)
      const hasRepositioning = eventTypes.some(
        (t) => t === 'WINDOW_REPOSITIONING' || t === 'WINDOW_REPOSITIONED'
      );
      expect(hasRepositioning).toBe(true);

      // Check for focus events
      const hasUnfocused = eventTypes.includes('APP_UNFOCUSED');
      const hasFocused = eventTypes.includes('APP_FOCUSED');
      expect(hasUnfocused).toBe(true);
      expect(hasFocused).toBe(true);

      // Check for window destroyed
      expect(eventTypes).toContain('WINDOW_DESTROYED');

      // Validate event structure
      const firstWindowEvent = events.find(
        (e) => e.event === 'WINDOW_CREATED' || e.event === 'WINDOW_EXISTING'
      );
      if (firstWindowEvent) {
        expect(firstWindowEvent.app).toBeDefined();
        expect(firstWindowEvent.app.name).toBe('Microsoft Word');
        expect(firstWindowEvent.app.identifier).toBe('com.microsoft.Word');
        expect(firstWindowEvent.app.identifierType).toBe('bundleId');
        expect(firstWindowEvent.app.pid).toBeGreaterThan(0);
        expect(firstWindowEvent.platform).toBe('macos');
        expect(firstWindowEvent.window).toBeDefined();
        expect(typeof firstWindowEvent.window.id).toBe('string');
        expect(parseInt(firstWindowEvent.window.id)).toBeGreaterThan(0);
        expect(firstWindowEvent.timestamp).toBeDefined();
      }
    },
    TEST_TIMEOUT
  );

  wordTestFn(
    'should include identifier in all events',
    async () => {
      const wordInstalled = await isWordInstalled();
      if (!wordInstalled) {
        console.log('Skipping: Microsoft Word not installed');
        return;
      }

      // Start the monitor
      monitorProcess = spawn(WINDOW_MONITOR_PATH, ['-b', BUNDLE_ID], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      monitorProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            events.push(event);
          } catch {
            // Ignore non-JSON output
          }
        }
      });

      // Wait for monitor to start
      await delay(2000);

      // Activate Word to generate an event
      await runAppleScript('tell application "Microsoft Word" to activate');
      await delay(2000);

      // Stop monitoring
      monitorProcess.kill('SIGTERM');
      await delay(500);

      // All events should have identifier and platform
      for (const event of events) {
        expect(event.app).toBeDefined();
        expect(event.app.identifier).toBe('com.microsoft.Word');
        expect(event.app.identifierType).toBe('bundleId');
        expect(event.platform).toBe('macos');
      }
    },
    TEST_TIMEOUT
  );
});
