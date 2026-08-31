/**
 * Sealed persistence for hosted MCP server configs
 * (`docs/design/mcp-hosting.md`, Increment 2 + the R5 orphan annotation).
 *
 * House doctrine (`jobRegistry.test.ts`, lines 1-21): a real temp userData
 * dir, created BEFORE any mock is declared; `electron` and `electron-log` are
 * the only two mocks. Everything this store actually depends on for its
 * safety property — `fs`, and the real `pidSignatureOf`/`killTree` process
 * tree in the orphan-reaping tests — is real. A mocked `safeStorage` is
 * unavoidable here (jest can't reach the real one: `ELECTRON_RUN_AS_NODE` has
 * no `safeStorage`, per CLAUDE.md's secretStore note), so it lives inside the
 * `electron` mock rather than as a separate one, and it's a REAL, reversible
 * transform rather than a pass-through stub — round-tripping through a no-op
 * "encryption" would prove nothing about whether tamper-detection actually
 * depends on the ciphertext.
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcphoststore-'));

// A controllable, REAL (reversible, order-sensitive) fake of safeStorage.
// `encryptionAvailable` is flipped per-test to exercise both the sealed path
// and the documented "no OS keyring" plaintext fallback in secretStore.ts.
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

import log from 'electron-log';
import {
  listHostedServers,
  getHostedServer,
  registerHostedServer,
  recordSpawn,
  clearSpawn,
  reconcileOrphans,
  isEncryptionAvailable,
  type HostedServerRegistration,
} from '../store';

const storeFile = path.join(tmpDir, 'mcp-servers', 'servers.json');
const children: ChildProcess[] = [];

function baseReg(id: string): HostedServerRegistration {
  return {
    id,
    label: id,
    install: { kind: 'custom' },
    entry: { command: `/usr/bin/${id}`, args: [] },
  };
}

function alive(pid: number): boolean {
  try { execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf-8' }); return true; }
  catch { return false; }
}

/** Same trick as jobRegistry.test.ts: execFileSync reaps the shell, so this leaves no zombie (which would still answer as "alive"). */
function deadPid(): number {
  return Number(execFileSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf-8' }).trim());
}

beforeEach(() => {
  encryptionAvailable = true;
  jest.clearAllMocks();
  try { fs.rmSync(path.dirname(storeFile), { recursive: true, force: true }); } catch { /* not there */ }
});

afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('seal / unseal round trip', () => {
  it('a registered server survives a fresh read of the store file, sealed on disk', async () => {
    const result = await registerHostedServer(baseReg('files'));
    expect(result.ok).toBe(true);
    expect(fs.existsSync(storeFile)).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    expect(onDisk.v).toBe(1);
    expect(typeof onDisk.sealed).toBe('string');
    // The point of sealing: the id is not sitting in the file as plaintext.
    expect(onDisk.sealed).not.toContain('files');

    const all = await listHostedServers();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('files');
    expect(all[0].entry.command).toBe('/usr/bin/files');
  });

  it('when the OS keyring is unavailable, the seal degrades to plaintext but still round-trips (documented, not a bug)', async () => {
    encryptionAvailable = false;
    await registerHostedServer(baseReg('nocrypto'));

    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    expect(onDisk.sealed).not.toMatch(/^FAKE-SEALED:/); // no envelope was applied — the seal is decorative here, honestly
    expect(onDisk.sealed).toContain('nocrypto'); // and therefore plaintext, which the design doc says out loud

    const all = await listHostedServers();
    expect(all.map((r) => r.id)).toEqual(['nocrypto']);
  });
});

describe('a tampered sealed value is dropped, never repaired', () => {
  it('drops every record rather than guessing, and logs loudly', async () => {
    await registerHostedServer(baseReg('a'));
    await registerHostedServer(baseReg('b'));
    expect(await listHostedServers()).toHaveLength(2);

    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    // Corrupt everything AFTER the 'enc:v1:' prefix (7 chars), so this
    // exercises the decrypt-failure path specifically — `isEncrypted()` still
    // says yes, but the base64 payload no longer decodes to the fake cipher's
    // expected prefix, so `decryptString` throws and `decryptSecret` (real
    // code, not mocked) returns ''. A SEPARATE test below covers the outer
    // envelope not being valid JSON at all, which is a different failure mode.
    expect(raw.sealed.startsWith('enc:v1:')).toBe(true);
    raw.sealed = `${raw.sealed.slice(0, 7)}not-the-real-payload-at-all-####`;
    fs.writeFileSync(storeFile, JSON.stringify(raw));

    const all = await listHostedServers();
    expect(all).toEqual([]); // dropped, not partially recovered
    expect((log.error as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('a store file that is not valid JSON at all is also treated as empty, not thrown on', async () => {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, '{ this is not json');

    await expect(listHostedServers()).resolves.toEqual([]);
    expect((log.error as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });
});

describe('registerHostedServer', () => {
  it('always yields enabled: false, even when nothing in the input could ask for true', async () => {
    const result = await registerHostedServer(baseReg('freshserver'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.enabled).toBe(false);

    const stored = await getHostedServer('freshserver');
    expect(stored?.enabled).toBe(false);
  });

  it('refuses an id that collides with an existing hosted server', async () => {
    await registerHostedServer(baseReg('dup'));
    const second = await registerHostedServer(baseReg('dup'));
    expect(second.ok).toBe(false);
    expect(await listHostedServers()).toHaveLength(1);
  });

  it('refuses a reserved relay name', async () => {
    const result = await registerHostedServer(baseReg('knowledge'));
    expect(result.ok).toBe(false);
  });
});

describe('isEncryptionAvailable', () => {
  it('surfaces false so a caller can refuse to autostart and say why', () => {
    encryptionAvailable = false;
    expect(isEncryptionAvailable()).toBe(false);
  });

  it('surfaces true when the OS keyring is reachable', () => {
    encryptionAvailable = true;
    expect(isEncryptionAvailable()).toBe(true);
  });
});

describe('reconcileOrphans (R5)', () => {
  it('kills a real live pid whose signature still matches the recorded one', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid!;

    await registerHostedServer(baseReg('orphaned'));
    const sig = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8' }).trim();
    await recordSpawn('orphaned', pid, sig);

    const result = await reconcileOrphans();
    expect(result.killed).toBe(1);
    expect(result.spared).toBe(0);

    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);

    // The stale pointer is forgotten so the next boot doesn't recheck it.
    const record = await getHostedServer('orphaned');
    expect(record?.lastPid).toBeUndefined();
    expect(record?.lastPidSignature).toBeUndefined();
  }, 15000);

  it('spares a pid whose recorded signature does not match — it belongs to someone else now', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid!;

    await registerHostedServer(baseReg('recycled'));
    // A signature that does NOT match this real, live process — simulating
    // pid reuse, the same way jobRegistry.test.ts's "does not adopt a
    // recycled pid" case does: by writing a wrong signature directly, since
    // forcing genuine OS pid recycling isn't deterministic from a test.
    await recordSpawn('recycled', pid, 'Thu Jan  1 00:00:00 1970 /some/other/process');

    const result = await reconcileOrphans();
    expect(result.killed).toBe(0);
    expect(result.spared).toBe(1);

    expect(alive(pid)).toBe(true); // left alone — never signalled

    const record = await getHostedServer('recycled');
    expect(record?.lastPid).toBeUndefined(); // still forgotten, even though spared
  });

  it('is a no-op when nothing has a stale pid recorded', async () => {
    await registerHostedServer(baseReg('clean'));
    const result = await reconcileOrphans();
    expect(result).toEqual({ killed: 0, spared: 0 });
  });

  it('clearSpawn removes the bookkeeping so a clean stop is never mistaken for an orphan', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid!;

    await registerHostedServer(baseReg('cleanstop'));
    const sig = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8' }).trim();
    await recordSpawn('cleanstop', pid, sig);
    await clearSpawn('cleanstop');

    const result = await reconcileOrphans();
    expect(result).toEqual({ killed: 0, spared: 0 });
    expect(alive(pid)).toBe(true); // never touched — reconcile saw nothing to act on

    child.kill('SIGKILL');
  });
});
