/**
 * The façade in `index.ts`, exercised end to end against the REAL store
 * (sealed on a real temp userData dir) and the REAL supervisor (spawning the
 * real `echoMcpServer.mjs` fixture). House doctrine
 * (`jobRegistry.test.ts`, lines 1-21): a real temp dir declared BEFORE any
 * mock; `electron`/`electron-log` are the only mocks, and `safeStorage` is a
 * REAL, reversible transform (not a pass-through stub) so tamper/round-trip
 * behaviour is actually exercised — mirrors `mcpHostStore.test.ts`'s own
 * setup, since this file drives the same store through the façade instead
 * of directly.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcphostindex-'));

let encryptionAvailable = true;
const FAKE_CIPHER_PREFIX = 'FAKE-SEALED:';
jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
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
import * as store from '../store';
import { registerHostedServer, updateHostedServer, type HostedServerRegistration } from '../store';
import { __setSupervisorTuningForTests, __resetSupervisorTuningForTests, __resetSupervisorForTests } from '../supervisor';
import * as jobRegistry from '../../jobRegistry';

const fixture = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'echoMcpServer.mjs');

function echoRegistration(id: string, env: Record<string, string> = {}): HostedServerRegistration {
  return {
    id,
    label: id,
    autostart: true,
    install: { kind: 'custom' },
    entry: { command: process.execPath, args: [fixture] },
    env: { ELECTRON_RUN_AS_NODE: '1', ...env },
    concurrency: 1,
  };
}

async function registerAndEnable(id: string, env: Record<string, string> = {}): Promise<void> {
  const reg = await registerHostedServer(echoRegistration(id, env));
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
  encryptionAvailable = true;
  __resetSupervisorTuningForTests();
});

afterEach(async () => {
  await mcpHost.shutdown({ graceMs: 100 }).catch(() => {});
  __resetSupervisorForTests();
  try { fs.rmSync(path.join(tmpDir, 'mcp-servers'), { recursive: true, force: true }); } catch { /* not there */ }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('startAll — single-flight (R10) and never-throws', () => {
  it('two concurrent calls only reconcile-and-spawn ONCE, not twice', async () => {
    await registerAndEnable('single-flight-a');
    // `startAll` is itself declared `async` (matching the `ensurePythonVenv`
    // precedent exactly), so the outer promises it RETURNS are never `===`
    // across two calls even when correctly single-flighted — an `async
    // function`'s `return somePromise` always wraps in a fresh promise. The
    // property that actually matters is that the expensive work it guards
    // (`reconcileOrphans`, real `ps`/`pgrep` calls) runs once, not once per
    // caller — spying on the real store function is what proves that,
    // rather than an assertion that can never pass regardless of correctness.
    const spy = jest.spyOn(store, 'reconcileOrphans');
    try {
      const p1 = mcpHost.startAll();
      const p2 = mcpHost.startAll();
      await Promise.all([p1, p2]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    await waitForNextInventoryChange('single-flight-a', (s) => s === 'ready');
  }, 15000);

  it('when the OS keyring is unavailable, refuses to autostart anything and says why — never throws', async () => {
    await registerAndEnable('refused-a');
    encryptionAvailable = false;
    await expect(mcpHost.startAll()).resolves.toBeUndefined(); // never throws
    expect(mcpHost.lastStartAllErrorMessage()).toMatch(/OS keyring is not available/);

    const entries = await mcpHost.list();
    const entry = entries.find((e) => e.id === 'refused-a');
    // Nothing was spawned — no live pid, no 'ready'/'starting' state.
    expect(entry?.pid).toBeUndefined();
    expect(entry?.state).not.toBe('ready');
  });
});

describe('list() — masked, never a decrypted env value', () => {
  it('never includes env at all, and the secret string never appears anywhere in the serialized output', async () => {
    const secret = 'canary-secret-token-9f3a';
    await registerAndEnable('masked-a', { MY_TOKEN: secret });

    const entries = await mcpHost.list();
    const entry = entries.find((e) => e.id === 'masked-a');
    expect(entry).toBeDefined();
    expect((entry as unknown as Record<string, unknown>).env).toBeUndefined();
    expect(JSON.stringify(entries)).not.toContain(secret);

    // The safe fields ARE present, so this is a real masking check and not
    // an empty/broken entry.
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.args).toContain(fixture);
  });
});

describe('per-server actions, driven against the real fixture', () => {
  it('start / stop / restart / pause / remove all work through the façade', async () => {
    const id = 'lifecycle-a';
    await registerAndEnable(id);

    const started = await mcpHost.start(id);
    expect(started.ok).toBe(true);
    await waitForNextInventoryChange(id, (s) => s === 'ready');

    const tools = mcpHost.inventory(id);
    expect(tools?.map((t) => t.name).sort()).toEqual(['crash', 'echo', 'slow']);

    const result = await mcpHost.invoke(id, 'echo', { text: 'via facade' });
    expect(JSON.stringify(result)).toContain('via facade');

    const stopped = await mcpHost.stop(id, { graceMs: 100 });
    expect(stopped.ok).toBe(true);
    let entry = (await mcpHost.list()).find((e) => e.id === id);
    expect(entry?.state).toBe('stopped');
    expect(entry?.enabled).toBe(true); // stop() does not disable

    const restarted = await mcpHost.restart(id);
    expect(restarted.ok).toBe(true);
    await waitForNextInventoryChange(id, (s) => s === 'ready');

    const paused = await mcpHost.pause(id, { graceMs: 100 });
    expect(paused.ok).toBe(true);
    entry = (await mcpHost.list()).find((e) => e.id === id);
    expect(entry?.enabled).toBe(false); // pause() DOES disable
    expect(entry?.state === 'paused' || entry?.state === 'stopped').toBe(true);

    const removed = await mcpHost.remove(id, { graceMs: 100 });
    expect(removed.ok).toBe(true);
    entry = (await mcpHost.list()).find((e) => e.id === id);
    expect(entry).toBeUndefined();
  }, 20000);

  it('start() refuses a server that is off, and refuses an unknown id, without touching anything', async () => {
    const id = 'off-a';
    await registerHostedServer(echoRegistration(id)).then((r) => { if (!r.ok) throw new Error(r.error); });
    // Deliberately left disabled (the store's own default).

    const result = await mcpHost.start(id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/off/);

    const unknown = await mcpHost.start('does-not-exist-xyz');
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/No hosted server/);
  });
});

describe('mcpHost servers are NOT registered in jobRegistry', () => {
  it('activeJobs() stays empty while a real hosted server is running', async () => {
    jobRegistry.__resetJobRegistry();
    const id = 'not-a-job';
    await registerAndEnable(id);
    await mcpHost.start(id);
    await waitForNextInventoryChange(id, (s) => s === 'ready');

    // The server is genuinely alive at this point...
    const entry = (await mcpHost.list()).find((e) => e.id === id);
    expect(entry?.state).toBe('ready');
    expect(entry?.pid).toBeGreaterThan(0);
    if (entry?.pid) {
      expect(() => execFileSync('/bin/ps', ['-p', String(entry.pid), '-o', 'pid='])).not.toThrow();
    }

    // ...but the job registry — the thing that drives the quit dialog's
    // "N pieces of work are still running" — has never heard of it.
    expect(jobRegistry.activeJobs()).toEqual([]);
    expect(jobRegistry.listJobs()).toEqual([]);

    await mcpHost.stop(id, { graceMs: 100 });
  }, 15000);
});

describe('save() — the Advanced form (Increment 3)', () => {
  it('registers a new server, always Off, with envKeys visible but never the values', async () => {
    const secret = 'canary-save-secret-7f2a';
    const result = await mcpHost.save({
      id: 'saved-a',
      label: 'Saved A',
      command: process.execPath,
      args: [fixture],
      envUpdates: { ELECTRON_RUN_AS_NODE: '1', MY_TOKEN: secret },
      envDeletes: [],
      autostart: false,
    });
    expect(result.ok).toBe(true);

    const entries = await mcpHost.list();
    const entry = entries.find((e) => e.id === 'saved-a');
    expect(entry?.enabled).toBe(false); // registration is never negotiable — see registerHostedServer
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.envKeys.slice().sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'MY_TOKEN']);
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it('saving the SAME id twice is an upsert (edit), not a rejected duplicate — no second row', async () => {
    await mcpHost.save({
      id: 'dup-a', label: 'Dup A', command: process.execPath, args: [fixture],
      envUpdates: {}, envDeletes: [], autostart: false,
    });
    const before = (await mcpHost.list()).length;

    const result = await mcpHost.save({
      id: 'dup-a', label: 'Dup A Again', command: process.execPath, args: [fixture],
      envUpdates: {}, envDeletes: [], autostart: false,
    });
    expect(result.ok).toBe(true);
    expect((await mcpHost.list()).length).toBe(before); // still one row, not two
    expect((await mcpHost.list()).find((e) => e.id === 'dup-a')?.label).toBe('Dup A Again');
  });

  it('rejects a reserved id and a blank command, and registers nothing either time', async () => {
    const before = (await mcpHost.list()).length;

    const reserved = await mcpHost.save({
      id: 'workspace', label: 'x', command: process.execPath, args: [fixture],
      envUpdates: {}, envDeletes: [], autostart: false,
    });
    expect(reserved.ok).toBe(false);
    expect(reserved.error).toMatch(/reserved/);

    const blankCommand = await mcpHost.save({
      id: 'blank-command-a', label: 'x', command: '', args: [],
      envUpdates: {}, envDeletes: [], autostart: false,
    });
    expect(blankCommand.ok).toBe(false);

    expect((await mcpHost.list()).length).toBe(before);
  });

  it('editing an existing server merges the env diff onto what was stored — untouched keys survive, deleted keys go', async () => {
    await mcpHost.save({
      id: 'edit-a', label: 'Edit A', command: process.execPath, args: [fixture],
      envUpdates: { ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'still-here', DROP_ME: 'going-away' },
      envDeletes: [], autostart: false,
    });

    const result = await mcpHost.save({
      id: 'edit-a', label: 'Edit A (renamed)', command: process.execPath, args: [fixture, '--noisy'],
      envUpdates: { NEW_KEY: 'fresh' },
      envDeletes: ['DROP_ME'],
      autostart: true,
    });
    expect(result.ok).toBe(true);

    const entry = (await mcpHost.list()).find((e) => e.id === 'edit-a');
    expect(entry?.label).toBe('Edit A (renamed)');
    expect(entry?.args).toEqual([fixture, '--noisy']);
    expect(entry?.autostart).toBe(true);
    expect(entry?.envKeys.slice().sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'KEEP_ME', 'NEW_KEY']);
  });

  it('editing does not touch enabled — save() never starts or stops anything', async () => {
    await registerAndEnable('edit-b'); // enabled: true
    await mcpHost.save({
      id: 'edit-b', label: 'Edit B', command: process.execPath, args: [fixture],
      envUpdates: {}, envDeletes: [], autostart: false,
    });
    const entry = (await mcpHost.list()).find((e) => e.id === 'edit-b');
    expect(entry?.enabled).toBe(true);
  });
});

describe('test() — the probe, reached through the façade with a stored-env merge base', () => {
  it('probing an unsaved draft (no id) uses only the submitted env', async () => {
    const result = await mcpHost.test({
      command: process.execPath,
      args: [fixture],
      envUpdates: { ELECTRON_RUN_AS_NODE: '1' },
      envDeletes: [],
    });
    expect(result.ok).toBe(true);
    expect(result.toolNames.slice().sort()).toEqual(['crash', 'echo', 'slow']);
  }, 15000);

  it('probing an existing server\'s id merges the diff onto its STORED env, never registering or persisting the probe itself', async () => {
    await mcpHost.save({
      id: 'probe-existing-a', label: 'P', command: process.execPath, args: [fixture],
      envUpdates: { ELECTRON_RUN_AS_NODE: '1' }, envDeletes: [], autostart: false,
    });

    const result = await mcpHost.test({
      id: 'probe-existing-a',
      command: process.execPath,
      args: [fixture],
      envUpdates: {}, // nothing new — relies entirely on the stored ELECTRON_RUN_AS_NODE
      envDeletes: [],
    });
    expect(result.ok).toBe(true);

    // The stored record itself is untouched by probing it.
    const entry = (await mcpHost.list()).find((e) => e.id === 'probe-existing-a');
    expect(entry?.enabled).toBe(false);
    expect(entry?.state).not.toBe('ready');
  }, 15000);
});
