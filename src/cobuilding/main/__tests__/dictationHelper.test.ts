import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Integration tests for the REAL Swift dictation helper binary — not a mock of
 * it. The host's whole contract with dictation is this process's stdio
 * protocol, so testing a reimplementation of that protocol would prove nothing.
 *
 * Deliberately never sends `start`. That would engage the microphone and, more
 * importantly, attribute a Speech Recognition TCC grant to whatever process is
 * running jest rather than to Acabox — a real change to the developer's
 * machine that a test has no business making. Live recognition has to be
 * exercised by hand through `npm start`; everything reachable without the mic
 * is covered here.
 */

const BINARY = path.join(
  __dirname,
  '../../swift/dictation-mac/build/dictation-mac',
);

const built = process.platform === 'darwin' && fs.existsSync(BINARY);

// The build is intentionally non-fatal (no Command Line Tools => no helper), so
// skip rather than fail where it was never produced.
const maybeDescribe = built ? describe : describe.skip;

if (!built && process.platform === 'darwin') {
  // eslint-disable-next-line no-console
  console.warn(`[dictationHelper.test] Helper not built at ${BINARY} — skipping.`);
}

function runProbe(locale: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(BINARY, ['--probe', '--locale', locale], { timeout: 20_000 }, (err, stdout) => {
      if (err) return reject(err);
      // Speech logs unsupported-locale complaints to stdout, so mirror the
      // service's parsing: take the last parseable line, not the first.
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (!line) return reject(new Error('probe produced no output'));
      resolve(JSON.parse(line));
    });
  });
}

/** Drives the helper's stdin protocol and collects every emitted event. */
function runSession(commands: string[]): Promise<{ events: Record<string, unknown>[]; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const events: Record<string, unknown>[] = [];
    let buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) events.push(JSON.parse(line.trim()));
      }
    });

    child.on('error', reject);
    child.on('exit', (code) => resolve({ events, code }));

    for (const command of commands) child.stdin.write(`${command}\n`);
    child.stdin.end();

    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('helper did not exit'));
    }, 20_000);
    child.on('exit', () => clearTimeout(guard));
  });
}

maybeDescribe('dictation helper — capability probe', () => {
  it('reports a supported locale as available, on-device, with an engine', async () => {
    const probe = await runProbe('en-US');
    expect(probe.type).toBe('probe');
    expect(probe.available).toBe(true);
    expect(['transcriber', 'sfspeech']).toContain(probe.engine);
    expect(probe.locale).toBe('en-US');
  }, 30_000);

  it('reports an unsupported locale as unavailable rather than throwing', async () => {
    // The mic button keys off `available`; a bogus locale must turn it off, not
    // crash the probe and leave the capability unknown.
    const probe = await runProbe('xx-XX');
    expect(probe.available).toBe(false);
  }, 30_000);

  it('does not request permission — the probe must never raise a TCC prompt', async () => {
    // This is the property that lets a composer probe on mount. If probing ever
    // starts prompting, the mic button becomes the thing that nags users on
    // every page load. `speechAuth` is reported, never requested, so a
    // not-determined machine stays not-determined across a probe.
    const before = await runProbe('en-US');
    const after = await runProbe('en-US');
    expect(after.speechAuth).toBe(before.speechAuth);
    expect(['authorized', 'denied', 'restricted', 'notDetermined']).toContain(after.speechAuth);
  }, 40_000);
});

maybeDescribe('dictation helper — stdio protocol', () => {
  it('announces itself with a pid so the host can reap an orphan', async () => {
    const { events } = await runSession(['{"cmd":"quit"}']);
    expect(events[0]).toMatchObject({ type: 'hello' });
    expect(typeof events[0].pid).toBe('number');
  }, 30_000);

  it('answers stop-before-start with `stopped` instead of erroring', async () => {
    // The renderer can send stop on unmount without knowing whether a session
    // ever started; that must not produce a user-visible error.
    const { events, code } = await runSession(['{"cmd":"stop"}', '{"cmd":"quit"}']);
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(code).toBe(0);
  }, 30_000);

  it('ignores malformed input rather than dying on it', async () => {
    const { events, code } = await runSession([
      'not json at all',
      '{"unrelated":"object"}',
      '',
      '{"cmd":"quit"}',
    ]);
    // Survived to process the final command.
    expect(code).toBe(0);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 30_000);

  it('reports an unknown command without terminating the session', async () => {
    const { events, code } = await runSession(['{"cmd":"bogus"}', '{"cmd":"quit"}']);
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ code: 'unknown-command' });
    expect(code).toBe(0);
  }, 30_000);

  it('exits when stdin closes, so a crashed host cannot orphan the microphone', async () => {
    // Without this the helper would outlive Acabox holding the audio device —
    // the same class of bug as the shell commands that survived app quit.
    const { code } = await runSession([]);
    expect(code).toBe(0);
  }, 30_000);
});
