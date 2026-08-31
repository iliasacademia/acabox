/**
 * Teardown (`index.ts#shutdown` -> `supervisor.shutdownAll` -> `killTree`)
 * and the R5 orphan story (`store.reconcileOrphans`, driven end to end
 * through `index.ts#startAll`). House doctrine (`jobRegistry.test.ts`,
 * lines 1-21): a real temp userData dir declared BEFORE any mock; real
 * child processes throughout — the `--ignore-sigterm` fixture's grandchild
 * is exactly the shape of thing a mocked process tree could not prove
 * anything about.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcphostteardown-'));

const FAKE_CIPHER_PREFIX = 'FAKE-SEALED:';
jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`${FAKE_CIPHER_PREFIX}${plain}`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const str = buf.toString('utf-8');
      if (!str.startsWith(FAKE_CIPHER_PREFIX)) throw new Error('bad ciphertext');
      return str.slice(FAKE_CIPHER_PREFIX.length);
    },
  },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as mcpHost from '../index';
import { registerHostedServer, updateHostedServer, getHostedServer, type HostedServerRegistration } from '../store';
import { descendantsOf } from '../processTree';
import { __resetSupervisorForTests, __resetSupervisorTuningForTests } from '../supervisor';

const fixture = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'echoMcpServer.mjs');
const unrelated: ChildProcess[] = [];

function alive(pid: number): boolean {
  try { execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf-8' }); return true; }
  catch { return false; }
}

function echoRegistration(id: string, extraArgs: string[] = []): HostedServerRegistration {
  return {
    id,
    label: id,
    autostart: true,
    install: { kind: 'custom' },
    entry: { command: process.execPath, args: [fixture, ...extraArgs] },
    env: { ELECTRON_RUN_AS_NODE: '1' },
    concurrency: 1,
  };
}

async function registerAndEnable(id: string, extraArgs: string[] = []): Promise<void> {
  const reg = await registerHostedServer(echoRegistration(id, extraArgs));
  if (!reg.ok) throw new Error(`registration failed: ${reg.error}`);
  await updateHostedServer(id, { enabled: true });
}

function waitForNextInventoryChange(id: string, predicate: (state: string) => boolean, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error(`Timed out waiting for "${id}"`)); }, timeoutMs);
    const unsub = mcpHost.onInventoryChanged(async (changedId) => {
      if (changedId !== id) return;
      const entry = (await mcpHost.list()).find((e) => e.id === id);
      if (entry && predicate(entry.state)) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

beforeEach(() => {
  __resetSupervisorTuningForTests();
});

afterEach(async () => {
  await mcpHost.shutdown({ graceMs: 300 }).catch(() => {});
  __resetSupervisorForTests();
  try { fs.rmSync(path.join(tmpDir, 'mcp-servers'), { recursive: true, force: true }); } catch { /* not there */ }
});

afterAll(() => {
  for (const c of unrelated) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('shutdown() tears down a real process tree', () => {
  it('shutdown({graceMs:300}) against a SIGTERM-ignoring server leaves neither it nor its grandchild alive', async () => {
    const id = 'ignore-sigterm-a';
    await registerAndEnable(id, ['--ignore-sigterm']);
    await mcpHost.start(id);
    await waitForNextInventoryChange(id, (s) => s === 'ready');

    const entry = (await mcpHost.list()).find((e) => e.id === id);
    const pid = entry?.pid;
    expect(pid).toBeGreaterThan(0);

    // Let the fixture install its SIGTERM handler and spawn its own
    // grandchild before we touch it — verified by hand in
    // processTree.test.ts, same timing.
    await new Promise((r) => setTimeout(r, 500));
    const grandchildren = descendantsOf(pid!);
    expect(grandchildren).toHaveLength(1);

    await mcpHost.shutdown({ graceMs: 300 });

    // A SIGKILL'd process can sit briefly in the kernel's process table as
    // "exiting" before `ps` stops reporting it at all — observed directly
    // here (`STAT=E`, `COMMAND=(Electron)`, right after `shutdown()`
    // resolves, gone within 500ms). Same allowance
    // `mcpHostStore.test.ts`'s `reconcileOrphans` test already makes for the
    // identical reason; not a signal that the kill itself was late.
    await new Promise((r) => setTimeout(r, 300));

    expect(alive(pid!)).toBe(false);
    for (const gc of grandchildren) expect(alive(gc)).toBe(false);
  }, 15000);

  it('calling shutdown() twice does not throw, and does not touch an unrelated process spawned in between', async () => {
    const id = 'ignore-sigterm-b';
    await registerAndEnable(id, ['--ignore-sigterm']);
    await mcpHost.start(id);
    await waitForNextInventoryChange(id, (s) => s === 'ready');
    await new Promise((r) => setTimeout(r, 500)); // let the grandchild spawn

    await mcpHost.shutdown({ graceMs: 300 });

    const bystander = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    unrelated.push(bystander);
    const bystanderPid = bystander.pid!;

    await expect(mcpHost.shutdown({ graceMs: 300 })).resolves.toBeUndefined();

    expect(alive(bystanderPid)).toBe(true);
    bystander.kill('SIGKILL');
  }, 15000);
});

describe('R5 — the orphan story: an unclean shutdown does not leave two copies running', () => {
  it('startAll(), after an in-memory-only crash (no clean teardown), reaps the surviving process before spawning a fresh one', async () => {
    const id = 'orphan-a';
    await registerAndEnable(id);

    await mcpHost.startAll();
    await waitForNextInventoryChange(id, (s) => s === 'ready');

    const before = (await mcpHost.list()).find((e) => e.id === id);
    const oldPid = before?.pid;
    expect(oldPid).toBeGreaterThan(0);
    expect(alive(oldPid!)).toBe(true);

    // R5's persisted pointer: `recordSpawn` should have run right after the
    // real spawn above, so the store itself — not just the live process —
    // remembers this pid across what we are about to simulate.
    const storedBefore = await getHostedServer(id);
    expect(storedBefore?.lastPid).toBe(oldPid);
    expect(storedBefore?.lastPidSignature).toBeTruthy();

    // Simulate "the app was killed without running any teardown": drop every
    // bit of in-memory supervisor state while leaving the real OS process
    // (and the store's persisted {lastPid, lastPidSignature}) exactly as
    // they were. This is the crash/SIGKILL/`app.relaunch()` case R5 exists
    // for — clean shutdown paths never reach this state.
    __resetSupervisorForTests();

    // "Reopen the app": startAll() on the SAME store, with no memory of
    // anything above.
    await mcpHost.startAll();
    await waitForNextInventoryChange(id, (s) => s === 'ready');

    const after = (await mcpHost.list()).find((e) => e.id === id);
    const newPid = after?.pid;
    expect(newPid).toBeGreaterThan(0);
    expect(newPid).not.toBe(oldPid);

    // The old process is gone (reaped by reconcileOrphans before the fresh
    // spawn) and exactly one new one is running.
    expect(alive(oldPid!)).toBe(false);
    expect(alive(newPid!)).toBe(true);

    // The tool still works through the fresh copy — this was a real respawn, not a zombie entry.
    const result = await mcpHost.invoke(id, 'echo', { text: 'reborn' });
    expect(JSON.stringify(result)).toContain('reborn');

    // Explicit cleanup, verified in THIS test rather than left entirely to
    // `afterEach` — this respawned copy is exactly the process a ghost
    // restart (see `__resetSupervisorForTests`'s own comment) could leave
    // behind uncleaned if the attempt-settling fix there ever regressed.
    await mcpHost.stop(id, { graceMs: 100 });
    expect(alive(newPid!)).toBe(false);
  }, 20000);
});
