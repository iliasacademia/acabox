/**
 * House doctrine (`jobRegistry.test.ts`, lines 1-21): a real temp userData
 * dir declared BEFORE any mock; `electron`/`electron-log` are the only
 * mocks. Every server here is the REAL `echoMcpServer.mjs` fixture (or a
 * real `/bin/false`, or a tiny real shell launcher script this file writes
 * to a temp dir) spawned as a genuine child process — a mocked MCP client
 * would only prove the supervisor agrees with a fake protocol, which is
 * exactly the crash/backoff/health behaviour under test.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcphostsupervisor-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  startServer,
  restartServer,
  stopServer,
  shutdownAll,
  invoke,
  getStatus,
  getTools,
  getEnabledTools,
  updateEnabledTools,
  onStatusChange,
  __setSupervisorTuningForTests,
  __resetSupervisorTuningForTests,
  __resetSupervisorForTests,
} from '../supervisor';
import { hostedServerDir } from '../store';
import log from 'electron-log';
import type { HostedMcpRecord, HostedStatus } from '../../../shared/hostedMcp';

const fixture = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'echoMcpServer.mjs');
const scratchDir = path.join(tmpDir, 'scratch');
fs.mkdirSync(scratchDir, { recursive: true });

function baseRecord(id: string, entry: Partial<HostedMcpRecord['entry']> = {}): HostedMcpRecord {
  return {
    id,
    label: id,
    enabled: true,
    autostart: true,
    install: { kind: 'custom' },
    entry: { command: process.execPath, args: [fixture], ...entry },
    env: { ELECTRON_RUN_AS_NODE: '1' },
    concurrency: 1,
    createdAt: new Date().toISOString(),
  };
}

function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  return content?.find((c) => c.type === 'text')?.text ?? '';
}

/** Waits for a FUTURE status event matching `predicate` — deliberately does
 *  NOT check the current status first, since several tests here need to
 *  observe a TRANSITION (e.g. a crash-triggered restart) rather than a
 *  possibly-already-true static condition left over from an earlier call. */
function waitForNextState(id: string, predicate: (s: HostedStatus) => boolean, timeoutMs = 5000): Promise<HostedStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${id}"; last status: ${JSON.stringify(getStatus(id))}`));
    }, timeoutMs);
    const unsub = onStatusChange((status) => {
      if (status.id === id && predicate(status)) {
        clearTimeout(timer);
        unsub();
        resolve(status);
      }
    });
  });
}

function isTerminalReadiness(s: HostedStatus): boolean {
  return s.state === 'ready' || s.state === 'failed';
}

/**
 * Records the moment of each NEW attempt (transition INTO `starting`), not
 * every status event where the state happens to be `starting`. The
 * supervisor legitimately fires more than one notification while remaining
 * in `starting` for a single attempt (state first, then again once the pid
 * becomes known a moment later) — deduplicating on the state-transition edge
 * is what makes "one timestamp per attempt" true regardless of how many
 * notifications a given attempt produces along the way.
 */
function trackAttemptStarts(id: string): { times: number[]; unsub: () => void } {
  const times: number[] = [];
  let lastState: string | undefined;
  const unsub = onStatusChange((s) => {
    if (s.id !== id) return;
    if (s.state === 'starting' && lastState !== 'starting') times.push(Date.now());
    lastState = s.state;
  });
  return { times, unsub };
}

beforeEach(() => {
  __resetSupervisorTuningForTests();
});

afterAll(async () => {
  await shutdownAll({ graceMs: 300 }).catch(() => {});
  __resetSupervisorForTests();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('spawn -> readiness -> tools/list', () => {
  it('spawns the real fixture, becomes ready, and the inventory + a real call match', async () => {
    const id = 'echo-ready';
    startServer(baseRecord(id));
    const status = await waitForNextState(id, isTerminalReadiness, 10000);
    expect(status.state).toBe('ready');
    expect(status.pid).toBeGreaterThan(0);

    const tools = getTools(id);
    expect(tools?.map((t) => t.name).sort()).toEqual(['crash', 'echo', 'slow']);

    const result = await invoke(id, 'echo', { text: 'hello supervisor' });
    expect(extractText(result)).toBe('hello supervisor');

    await stopServer(id, { graceMs: 100 });
    const stopped = getStatus(id);
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.pid).toBeUndefined();
  }, 15000);

  it('defaults the child cwd to hostedServerDir(id) when entry.cwd is omitted, creating it if needed', async () => {
    const id = 'echo-defaultcwd';
    const expectedDir = hostedServerDir(id);
    expect(fs.existsSync(expectedDir)).toBe(false);

    startServer(baseRecord(id));
    await waitForNextState(id, isTerminalReadiness, 10000);

    expect(fs.existsSync(expectedDir)).toBe(true);
    await stopServer(id, { graceMs: 100 });
  }, 15000);

  it('logs each lifecycle transition once, on a greppable prefix', async () => {
    // Found by running the real app, not by reading: every log call in
    // main/mcpHost/ used to sit on a FAILURE path, so a healthy
    // starting → ready → stopped wrote nothing at all. A real session that
    // spawned a server, served two chat turns from it and shut it down at
    // quit produced `grep -ci mcphost` = 0 in cobuilding.log, which also made
    // the design doc's own acceptance step ("grep for a stable [McpHost]
    // prefix on every state transition") impossible to carry out.
    const info = (log.info as jest.Mock);
    info.mockClear();

    const id = 'echo-transitions';
    startServer(baseRecord(id));
    await waitForNextState(id, isTerminalReadiness, 10000);
    await stopServer(id, { graceMs: 100 });

    const lines: string[] = info.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes(`"${id}"`));

    // The sequence a healthy server must make audible, in order.
    expect(lines.some((l) => l.includes('→ starting'))).toBe(true);
    expect(lines.some((l) => l.includes('→ ready'))).toBe(true);
    expect(lines.some((l) => l.includes('→ stopped'))).toBe(true);

    // Ready carries the facts an operator actually needs to correlate the
    // line with a process on their machine.
    const ready = lines.find((l) => l.includes('→ ready'))!;
    expect(ready).toMatch(/pid=\d+/);
    expect(ready).toMatch(/tools=3/);

    // Exactly once each: notify() also fires for same-state updates, and
    // without the latch this would repeat a line that says nothing new.
    for (const state of ['→ starting', '→ ready', '→ stopped']) {
      expect(lines.filter((l) => l.includes(state))).toHaveLength(1);
    }
  }, 15000);

  it('an explicit entry.cwd is honoured instead of the default', async () => {
    const id = 'echo-explicitcwd';
    startServer(baseRecord(id, { cwd: scratchDir }));
    await waitForNextState(id, isTerminalReadiness, 10000);
    expect(getStatus(id)?.state).toBe('ready');
    // The default dir must NOT have been created for this id.
    expect(fs.existsSync(hostedServerDir(id))).toBe(false);
    await stopServer(id, { graceMs: 100 });
  }, 15000);
});

describe('crash -> restart', () => {
  it('a crash restarts the server automatically and the same tool works again on a different pid', async () => {
    __setSupervisorTuningForTests({ BACKOFF_INITIAL_MS: 30, BACKOFF_MAX_MS: 200 });
    const id = 'echo-crash';
    startServer(baseRecord(id));
    const first = await waitForNextState(id, isTerminalReadiness, 10000);
    expect(first.state).toBe('ready');
    const firstPid = first.pid;
    expect(firstPid).toBeGreaterThan(0);

    await invoke(id, 'crash', {}).catch(() => {}); // the call itself rejects — the process exits without answering

    const second = await waitForNextState(id, isTerminalReadiness, 10000);
    expect(second.state).toBe('ready');
    expect(second.pid).toBeGreaterThan(0);
    expect(second.pid).not.toBe(firstPid);

    const result = await invoke(id, 'echo', { text: 'still alive' });
    expect(extractText(result)).toBe('still alive');

    await stopServer(id, { graceMs: 100 });
  }, 20000);
});

describe('backoff: /bin/false gives up after exactly 6 attempts, with non-decreasing floors', () => {
  it('reaches failed with restartCount 6, each inter-attempt delay clearing its own non-decreasing floor', async () => {
    const initialMs = 20;
    const maxMs = 200;
    const jitter = 0.3;
    __setSupervisorTuningForTests({ BACKOFF_INITIAL_MS: initialMs, BACKOFF_MAX_MS: maxMs, BACKOFF_JITTER_FRACTION: jitter });

    const id = 'always-false';
    const { times: startTimes, unsub } = trackAttemptStarts(id);

    try {
      startServer({
        id,
        label: id,
        enabled: true,
        autostart: true,
        install: { kind: 'custom' },
        entry: { command: '/bin/false', args: [] },
        env: {},
        concurrency: 1,
        createdAt: new Date().toISOString(),
      });

      const failed = await waitForNextState(id, (s) => s.state === 'failed', 10000);
      expect(failed.restartCount).toBe(6);
    } finally {
      unsub();
    }

    expect(startTimes.length).toBe(6);
    const deltas: number[] = [];
    for (let i = 1; i < startTimes.length; i++) deltas.push(startTimes[i] - startTimes[i - 1]);
    expect(deltas).toHaveLength(5);

    // Each delay must clear its OWN non-decreasing floor (base, before
    // jitter). Jitter only ever ADDS on top of the floor, so this is a
    // lower bound, never an exact value — asserting exact numbers against a
    // randomized delay is how this class of test usually goes flaky.
    const floors = [1, 2, 3, 4, 5].map((n) => Math.min(maxMs, initialMs * Math.pow(2, n - 1)));
    expect(floors).toEqual([...floors].sort((a, b) => a - b)); // the floor SEQUENCE itself is non-decreasing by construction
    for (let i = 0; i < deltas.length; i++) {
      // Small slack for real timer/event-loop scheduling latency, which this
      // measures on top of (setTimeout is a "no earlier than", never exact).
      expect(deltas[i]).toBeGreaterThanOrEqual(floors[i] - 8);
    }
  }, 15000);
});

describe('backoff reset (R5/design: HEALTHY_RESET_MS)', () => {
  /** A real shell launcher that fails its first `failCount` runs (exit 1,
   *  immediately) and execs into the real echo fixture on every run after
   *  that — a genuine flaky process, not a simulated one, so the supervisor's
   *  restartCount is driven by real consecutive failures. */
  function makeFlakyLauncher(dir: string, failCount: number): string {
    const counterFile = path.join(dir, 'flaky-counter');
    fs.writeFileSync(counterFile, '0');
    const script = path.join(dir, 'flaky.sh');
    const body = [
      '#!/bin/sh',
      `COUNT=$(cat "${counterFile}")`,
      'COUNT=$((COUNT + 1))',
      `echo "$COUNT" > "${counterFile}"`,
      `if [ "$COUNT" -le ${failCount} ]; then exit 1; fi`,
      `exec "${process.execPath}" "${fixture}"`,
      '',
    ].join('\n');
    fs.writeFileSync(script, body, { mode: 0o755 });
    return script;
  }

  it('resets the backoff counter after HEALTHY_RESET_MS of continuous readiness — the next failure gets attempt #1\'s delay, not attempt #4\'s', async () => {
    const initialMs = 50;
    __setSupervisorTuningForTests({ BACKOFF_INITIAL_MS: initialMs, BACKOFF_MAX_MS: 5000, HEALTHY_RESET_MS: 200 });

    const dir = fs.mkdtempSync(path.join(tmpDir, 'flaky-'));
    const script = makeFlakyLauncher(dir, 3); // attempts 1-3 fail; attempt 4 reaches ready
    const id = 'flaky-reset';
    const { times: startTimes, unsub } = trackAttemptStarts(id);

    try {
      startServer({
        id,
        label: id,
        enabled: true,
        autostart: true,
        install: { kind: 'custom' },
        entry: { command: script, args: [] },
        env: { ELECTRON_RUN_AS_NODE: '1' },
        concurrency: 1,
        createdAt: new Date().toISOString(),
      });

      const ready = await waitForNextState(id, isTerminalReadiness, 10000);
      expect(ready.state).toBe('ready');
      expect(startTimes).toHaveLength(4); // 3 failures + the successful 4th

      // Stay healthy well past HEALTHY_RESET_MS so the reset timer fires.
      await new Promise((r) => setTimeout(r, 250));

      const beforeCrash = Date.now();
      await invoke(id, 'crash', {}).catch(() => {});
      await waitForNextState(id, (s) => s.state === 'starting', 5000);

      const nextStart = startTimes[startTimes.length - 1];
      const observedDelay = nextStart - beforeCrash;
      const attempt1Floor = initialMs; // 50ms
      const attempt4FloorUnreset = initialMs * Math.pow(2, 3); // 400ms — what it WOULD be without the reset

      expect(observedDelay).toBeGreaterThanOrEqual(attempt1Floor - 10);
      expect(observedDelay).toBeLessThan(attempt4FloorUnreset * 0.7);
    } finally {
      unsub();
      await stopServer(id, { graceMs: 100 }).catch(() => {});
    }
  }, 15000);
});

describe('restartServer — explicit user retry', () => {
  it('resets a failed server\'s backoff and spawns fresh, unconditionally', async () => {
    __setSupervisorTuningForTests({ BACKOFF_INITIAL_MS: 15, BACKOFF_MAX_MS: 50 });
    const id = 'restart-after-failed';
    startServer({
      id,
      label: id,
      enabled: true,
      autostart: true,
      install: { kind: 'custom' },
      entry: { command: '/bin/false', args: [] },
      env: {},
      concurrency: 1,
      createdAt: new Date().toISOString(),
    });
    const failed = await waitForNextState(id, (s) => s.state === 'failed', 10000);
    expect(failed.state).toBe('failed');

    // A plain startServer() call is a no-op once `failed` per its own
    // "already in flight" guard? No — `failed` is not one of the
    // in-flight states, so a fresh startServer() would also work; this test
    // specifically exercises restartServer(), the explicit "ask again" path.
    restartServer(baseRecord(id));
    const ready = await waitForNextState(id, isTerminalReadiness, 10000);
    expect(ready.state).toBe('ready');
    expect(getStatus(id)?.restartCount).toBe(0);

    await stopServer(id, { graceMs: 100 });
  }, 15000);
});

describe('exit-code capture (guards an undocumented SDK internal)', () => {
  /**
   * `captureExitInfo` in the supervisor reads the transport's TypeScript-private
   * `_process` field, because `StdioClientTransport.onclose` is a bare
   * zero-argument callback that throws the child's exit code away. That is a
   * dependency on an SDK internal, and it is written to fail SILENTLY — which
   * is right for production (it degrades to "no exit code", where things stood
   * before) and dangerous for us, because a future SDK rename would quietly
   * gut `diagnose()`'s most useful cases and no other test would notice.
   *
   * So this test exists to be the thing that breaks. It drives a REAL child
   * exiting with a REAL distinctive status and asserts the number survives all
   * the way into the user-facing failure text. Exit 127 specifically: that is
   * the "command not found" code, the one `diagnose()` pairs with
   * `lastHostedPathResolution()` to explain a Finder-launched app that cannot
   * see Homebrew's `node`.
   */
  it('surfaces a real child exit code in the failure, not a generic message', async () => {
    __setSupervisorTuningForTests({ BACKOFF_INITIAL_MS: 20, BACKOFF_MAX_MS: 60, BACKOFF_MAX_ATTEMPTS: 1 });

    const id = 'exits-127';
    startServer({
      id,
      label: id,
      enabled: true,
      autostart: true,
      install: { kind: 'custom' },
      // Exits 127 immediately, before speaking a word of MCP.
      entry: { command: '/bin/sh', args: ['-c', 'exit 127'] },
      env: {},
      concurrency: 1,
      createdAt: new Date().toISOString(),
    });

    const failed = await waitForNextState(id, (s) => s.state === 'failed', 10000);
    expect(failed.error).toBeTruthy();
    // If `_process` is ever renamed upstream, the code is lost and this fails.
    expect(failed.error).toMatch(/127/);
  }, 15000);
});

describe('invoke — not-ready refusals', () => {
  it('rejects immediately, naming the state, for a server that was never started', async () => {
    await expect(invoke('never-started-xyz', 'echo', { text: 'x' })).rejects.toThrow(/stopped/);
  });

  it('rejects for a paused/stopped server rather than hanging', async () => {
    const id = 'echo-notready';
    startServer(baseRecord(id));
    await waitForNextState(id, isTerminalReadiness, 10000);
    await stopServer(id, { graceMs: 100 });
    await expect(invoke(id, 'echo', { text: 'x' })).rejects.toThrow(/stopped/);
  }, 15000);
});

/**
 * Increment 7's write gate, Layer 2 read side (design:
 * `docs/design/mcp-hosting.md`, DECISION (2026-08-13)). `getEnabledTools`/
 * `updateEnabledTools` are what `main/mcpHost/index.ts`'s `isToolEnabled`/
 * `setEnabledTools` sit on top of — tested directly here, against the real
 * spawned fixture, rather than only through the façade.
 */
describe('getEnabledTools / updateEnabledTools — Increment 7', () => {
  it('a handle with no enabledTools set reads as undefined ("every tool"); a handle that was never started also reads as undefined', async () => {
    const id = 'gate-sup-absent';
    startServer(baseRecord(id));
    await waitForNextState(id, isTerminalReadiness, 10000);
    expect(getEnabledTools(id)).toBeUndefined();

    // Never-started id: no handle exists at all yet.
    expect(getEnabledTools('gate-sup-never-started-xyz')).toBeUndefined();
  }, 15000);

  it('updateEnabledTools refreshes the live record in place, with no restart (same pid) and no state change', async () => {
    const id = 'gate-sup-live-update';
    startServer(baseRecord(id));
    const ready = await waitForNextState(id, isTerminalReadiness, 10000);
    expect(ready.state).toBe('ready');
    const pidBefore = getStatus(id)?.pid;

    const changes: unknown[] = [];
    const unsub = onStatusChange((s) => { if (s.id === id) changes.push(s.state); });
    updateEnabledTools(id, ['echo']);
    unsub();

    expect(getEnabledTools(id)).toEqual(['echo']);
    // Same process the whole time — a tool-selection edit must not respawn.
    expect(getStatus(id)?.pid).toBe(pidBefore);
    expect(getStatus(id)?.state).toBe('ready');
    // The one notify() this call fires still reports 'ready' — not a
    // transition through 'starting'/'restarting' — proving nothing was torn
    // down and re-spawned to apply the change.
    expect(changes.every((s) => s === 'ready')).toBe(true);
    expect(changes.length).toBeGreaterThan(0); // it DID notify — the re-push mechanism
  }, 15000);

  it('updateEnabledTools on an id with no handle is a silent no-op — no throw', () => {
    expect(() => updateEnabledTools('gate-sup-no-handle-xyz', ['echo'])).not.toThrow();
    expect(getEnabledTools('gate-sup-no-handle-xyz')).toBeUndefined();
  });

  it('an empty array is a real, distinct selection from undefined', async () => {
    const id = 'gate-sup-empty';
    startServer(baseRecord(id));
    await waitForNextState(id, isTerminalReadiness, 10000);

    updateEnabledTools(id, []);
    expect(getEnabledTools(id)).toEqual([]);
    expect(getEnabledTools(id)).not.toBeUndefined();
  }, 15000);
});
