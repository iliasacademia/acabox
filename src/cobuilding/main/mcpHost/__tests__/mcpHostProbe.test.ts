/**
 * `probeServer` — the Servers page's "Test" button (`docs/design/mcp-hosting.md`,
 * Increment 3). House doctrine (`jobRegistry.test.ts`, lines 1-21): a real
 * temp userData dir before any mock; `electron`/`electron-log` are the only
 * mocks; the real `echoMcpServer.mjs` fixture is spawned as a genuine child
 * process, matching `mcpHostSupervisor.test.ts`'s own setup.
 *
 * The two properties that matter and that a mocked client could not prove:
 * a probe reuses the real spawn/handshake path (so its result is trustworthy)
 * AND leaves nothing behind — no live handle, no live process — regardless
 * of whether it succeeded or failed.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcphostprobe-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  probeServer,
  listStatuses,
  onStatusChange,
  __setSupervisorTuningForTests,
  __resetSupervisorTuningForTests,
  __resetSupervisorForTests,
} from '../supervisor';

const fixture = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'echoMcpServer.mjs');

beforeEach(() => {
  __resetSupervisorTuningForTests();
});

afterEach(() => {
  __resetSupervisorForTests();
});

describe('probeServer — success', () => {
  it('spawns the real fixture, reads its tools, then kills and forgets the process', async () => {
    let capturedPid: number | undefined;
    const unsub = onStatusChange((status) => {
      if (status.id.startsWith('__probe__') && status.pid != null) capturedPid = status.pid;
    });

    const result = await probeServer({
      command: process.execPath,
      args: [fixture],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    unsub();

    expect(result.ok).toBe(true);
    expect(result.toolNames.slice().sort()).toEqual(['crash', 'echo', 'slow']);
    // `process.execPath` already contains a `/`, so it is returned verbatim —
    // no PATH search needed for an already-qualified path.
    expect(result.resolvedCommand).toBe(process.execPath);
    expect(typeof result.pathResolved).toBe('boolean');
    expect(result.error).toBeUndefined();

    // Nothing registered or persisted: the probe's private `__probe__<uuid>`
    // handle must not survive in the supervisor's own live map.
    expect(listStatuses().some((s) => s.id.startsWith('__probe__'))).toBe(false);

    // And the real OS process is actually gone, not just forgotten in-memory.
    expect(capturedPid).toBeDefined();
    await new Promise((r) => setTimeout(r, 400));
    expect(() => execFileSync('/bin/ps', ['-p', String(capturedPid), '-o', 'pid='])).toThrow();
  }, 15000);

  it('two probes in a row do not collide or leak a status entry', async () => {
    const r1 = await probeServer({ command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const r2 = await probeServer({ command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(listStatuses().some((s) => s.id.startsWith('__probe__'))).toBe(false);
  }, 15000);
});

describe('probeServer — failure', () => {
  it('a command that does not exist reports ok:false with a plain-language ENOENT message, and registers nothing', async () => {
    const result = await probeServer({
      command: '/nonexistent/binary/acabox-probe-test-xyz',
      args: [],
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not find/i);
    expect(listStatuses().some((s) => s.id.startsWith('__probe__'))).toBe(false);
  });

  it('a handshake that never answers times out and reports failure rather than hanging', async () => {
    __setSupervisorTuningForTests({ READINESS_DEFAULT_MS: 300 });
    // `sleep` never speaks MCP at all, so `initialize` never resolves — the
    // readiness deadline is what has to end this, not the process exiting.
    const result = await probeServer({ command: '/bin/sleep', args: ['5'], env: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(listStatuses().some((s) => s.id.startsWith('__probe__'))).toBe(false);
  }, 10000);
});
