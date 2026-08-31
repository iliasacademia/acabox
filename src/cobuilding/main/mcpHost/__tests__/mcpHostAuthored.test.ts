/**
 * Increment 5, host half (`docs/design/mcp-hosting.md`) — `main/mcpHost/
 * authored.ts`, exercised end to end against the REAL sealed store (a real
 * temp userData dir), the REAL supervisor (spawning the REAL
 * `manage-mcp-server` scaffold — `src/cobuilding/skills/manage-mcp-server/
 * assets/scaffold/index.mjs`, copied verbatim, never a hand-rolled stand-in),
 * and a REAL workspace-shaped `.mcp-servers/<id>/` directory tree on disk.
 *
 * House doctrine (`jobRegistry.test.ts`, lines 1-21; mirrored by every other
 * file in this directory): a real temp dir declared BEFORE any mock;
 * `electron`/`electron-log` are the only two mocks, and `safeStorage` is a
 * REAL, reversible transform, not a pass-through stub.
 *
 * `app.getPath('userData')` is mocked to `tmpDir` for BOTH halves of this
 * subsystem's split brain: `<tmpDir>/mcp-servers/` is the sealed store +
 * promoted copies (`store.hostedServerDir`), and `<tmpDir>/workspace-data/
 * .mcp-servers/` is the fake "workspace" this file writes fixtures into —
 * `authored.ts`'s own `workspaceRoot()` derives that path from the exact same
 * `userData` value `WorkspaceController.getAgentControlledDir()` does in the
 * real app, so no separate injection point is needed to fake it here.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcphostauthored-'));

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

import * as authored from '../authored';
import * as store from '../store';
import * as supervisor from '../supervisor';
import { __resetSupervisorTuningForTests, __resetSupervisorForTests } from '../supervisor';

// The REAL, shipped scaffold — the skill's own contract this module adopts.
// Read once; every fixture directory below gets a byte-identical copy unless
// a test deliberately mutates its own copy afterwards.
const SCAFFOLD_DIR = path.join(__dirname, '..', '..', '..', 'skills', 'manage-mcp-server', 'assets', 'scaffold');
const SCAFFOLD_INDEX_MJS = fs.readFileSync(path.join(SCAFFOLD_DIR, 'index.mjs'), 'utf-8');

function workspaceServersRoot(): string {
  return path.join(tmpDir, 'workspace-data', '.mcp-servers');
}

/** Write a `.mcp-servers/<id>/` directory shaped exactly per the skill's own
 *  contract: `manifest.json` ({id, label, description}) + `index.mjs`. */
function writeAuthoredFixture(id: string, opts: {
  manifestId?: string;
  label?: string;
  description?: string;
  indexContent?: string;
} = {}): string {
  const dir = path.join(workspaceServersRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: opts.manifestId ?? id,
    label: opts.label ?? id,
    description: opts.description ?? `${id} — a test fixture.`,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.mjs'), opts.indexContent ?? SCAFFOLD_INDEX_MJS);
  return dir;
}

function waitForReady(id: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = supervisor.getStatus(id);
    if (existing?.state === 'ready') { resolve(); return; }
    const timer = setTimeout(() => { unsub(); reject(new Error(`Timed out waiting for "${id}" to become ready`)); }, timeoutMs);
    const unsub = supervisor.onStatusChange((status) => {
      if (status.id !== id) return;
      if (status.state === 'ready') { clearTimeout(timer); unsub(); resolve(); }
      else if (status.state === 'failed') { clearTimeout(timer); unsub(); reject(new Error(`"${id}" reached failed: ${status.error}`)); }
    });
  });
}

async function convert(id: string, args: Record<string, unknown>): Promise<string> {
  const result = await supervisor.invoke(id, 'convert_temperature', args) as { content: Array<{ type: string; text: string }> };
  return result.content[0].text;
}

beforeEach(() => {
  encryptionAvailable = true;
  __resetSupervisorTuningForTests();
});

afterEach(async () => {
  await supervisor.shutdownAll({ graceMs: 100 }).catch(() => {});
  __resetSupervisorForTests();
  authored.__resetAuthoredStateForTests();
  // Wipes the sealed store, every promoted copy, AND the known-ids ledger —
  // all three live under the same `<userData>/mcp-servers/` root, so one
  // recursive remove resets all of this subsystem's on-disk state at once.
  try { fs.rmSync(path.join(tmpDir, 'mcp-servers'), { recursive: true, force: true }); } catch { /* not there */ }
  // And the fake workspace's `.mcp-servers/` fixtures — without this, a
  // directory written by an earlier test is still sitting there for the next
  // test's scan to (re-)discover, since the known-ids ledger that would have
  // remembered it was just wiped above too.
  try { fs.rmSync(workspaceServersRoot(), { recursive: true, force: true }); } catch { /* not there */ }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('discovery → adoption', () => {
  it('adopts a valid directory as a hosted record, arriving enabled: false', async () => {
    writeAuthoredFixture('temp-a', { label: 'Temp A', description: 'Converts temperatures.' });

    const result = await authored.scanAndAdoptAuthoredServers();
    expect(result.adopted).toEqual(['temp-a']);
    expect(result.rejected).toEqual([]);

    const record = await store.getHostedServer('temp-a');
    expect(record).toBeDefined();
    expect(record?.enabled).toBe(false);
    expect(record?.autostart).toBe(false);
    expect(record?.install).toEqual({ kind: 'authored' });
    expect(record?.fileHashes).toBeUndefined(); // nothing promoted yet
    expect(record?.toolsAtApproval).toBeUndefined();
  });

  it('is idempotent across repeated runs — a second scan does not duplicate or re-adopt', async () => {
    writeAuthoredFixture('temp-b');

    const first = await authored.scanAndAdoptAuthoredServers();
    expect(first.adopted).toEqual(['temp-b']);

    const second = await authored.scanAndAdoptAuthoredServers();
    expect(second.adopted).toEqual([]); // already known — not re-adopted
    expect(second.rejected).toEqual([]);

    const all = await store.listHostedServers();
    expect(all.filter((r) => r.id === 'temp-b')).toHaveLength(1);
  });

  it('does not resurrect a server the user removed, even though its workspace directory is still there', async () => {
    writeAuthoredFixture('temp-c');
    await authored.scanAndAdoptAuthoredServers();
    expect(await store.getHostedServer('temp-c')).toBeDefined();

    // The user clicked Remove — the store row is gone, but (per this
    // increment's scope) the workspace source is untouched.
    await store.removeHostedServer('temp-c');
    expect(await store.getHostedServer('temp-c')).toBeUndefined();

    const rescan = await authored.scanAndAdoptAuthoredServers();
    expect(rescan.adopted).toEqual([]);
    expect(await store.getHostedServer('temp-c')).toBeUndefined(); // still gone
  });

  it('refuses an id that collides with an existing hosted server, with a usable reason', async () => {
    const reg = await store.registerHostedServer({
      id: 'clash', label: 'clash', install: { kind: 'custom' }, entry: { command: '/usr/bin/true', args: [] },
    });
    expect(reg.ok).toBe(true);

    writeAuthoredFixture('clash');
    const result = await authored.scanAndAdoptAuthoredServers();

    expect(result.adopted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].dir).toBe('clash');
    expect(result.rejected[0].reason).toMatch(/already exists/i);
  });

  it('refuses a directory name that disagrees with manifest.json\'s own id, with a usable reason', async () => {
    writeAuthoredFixture('dirname-x', { manifestId: 'a-totally-different-id' });

    const result = await authored.scanAndAdoptAuthoredServers();
    expect(result.adopted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].dir).toBe('dirname-x');
    expect(result.rejected[0].reason).toMatch(/does not match manifest\.json/i);
    expect(await store.getHostedServer('a-totally-different-id')).toBeUndefined();
    expect(await store.getHostedServer('dirname-x')).toBeUndefined();
  });

  it('refuses a reserved relay name', async () => {
    writeAuthoredFixture('knowledge'); // manifest id defaults to the dir name
    const result = await authored.scanAndAdoptAuthoredServers();
    expect(result.adopted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/reserved/i);
  });

  it('retries a previously-rejected candidate on the next scan, once it is fixed', async () => {
    writeAuthoredFixture('fixable', { manifestId: 'wrong-at-first' });
    const first = await authored.scanAndAdoptAuthoredServers();
    expect(first.rejected).toHaveLength(1);

    // The agent (or user) fixes the manifest to match the directory name.
    fs.writeFileSync(
      path.join(workspaceServersRoot(), 'fixable', 'manifest.json'),
      JSON.stringify({ id: 'fixable', label: 'Fixable', description: 'x' }),
    );
    const second = await authored.scanAndAdoptAuthoredServers();
    expect(second.adopted).toEqual(['fixable']);
    expect(await store.getHostedServer('fixable')).toBeDefined();
  });

  it('is a no-op, not an error, when the workspace has no .mcp-servers directory at all', async () => {
    const result = await authored.scanAndAdoptAuthoredServers();
    expect(result).toEqual({ adopted: [], rejected: [] });
  });
});

describe('promote-on-enable — the security property', () => {
  it('THE PROMOTED COPY IS WHAT RUNS: editing the workspace copy does nothing until re-promotion', async () => {
    writeAuthoredFixture('security-a');
    await authored.scanAndAdoptAuthoredServers();

    const approved = await authored.promoteAndEnableAuthoredServer('security-a');
    expect(approved.ok).toBe(true);
    await waitForReady('security-a');

    // Sanity: the record's `entry` now points at the PROMOTED copy, never
    // the workspace path — this is the assertion that fails first if
    // promotion is ever "simplified" into pointing at the workspace instead.
    const promotedRecord = await store.getHostedServer('security-a');
    expect(promotedRecord?.entry.args[0]).toBe(path.join(store.hostedServerDir('security-a'), 'index.mjs'));
    expect(promotedRecord?.entry.args[0]).not.toContain('workspace-data');

    const before = await convert('security-a', { value: 100, from: 'celsius', to: 'fahrenheit' });
    expect(before).toBe('100 celsius = 212 fahrenheit');

    // Mutate the WORKSPACE copy only — a real behavioural change, not a
    // cosmetic one, so a wrongly-running workspace copy is unmissable.
    const mutatedIndex = SCAFFOLD_INDEX_MJS.replace(
      "text: `${value} ${from} = ${rounded} ${to}`",
      "text: `MUTATED ${value} ${from} = ${rounded} ${to}`",
    );
    expect(mutatedIndex).not.toBe(SCAFFOLD_INDEX_MJS); // the replace actually matched something
    fs.writeFileSync(path.join(workspaceServersRoot(), 'security-a', 'index.mjs'), mutatedIndex);

    // THE ASSERTION: the already-running server is unaffected by the edit.
    // This is what fails if promotion is ever "simplified" into running the
    // workspace path directly (that version would already say MUTATED here).
    const stillOld = await convert('security-a', { value: 100, from: 'celsius', to: 'fahrenheit' });
    expect(stillOld).toBe('100 celsius = 212 fahrenheit');
    expect(stillOld).not.toContain('MUTATED');

    // Re-promote: NOW the new code should be what runs.
    const reApproved = await authored.promoteAndEnableAuthoredServer('security-a');
    expect(reApproved.ok).toBe(true);
    await waitForReady('security-a');

    const after = await convert('security-a', { value: 100, from: 'celsius', to: 'fahrenheit' });
    expect(after).toBe('MUTATED 100 celsius = 212 fahrenheit');
  }, 20000);

  it('records fileHashes and toolsAtApproval from the promoted copy, and starts it enabled+autostart', async () => {
    writeAuthoredFixture('security-b');
    await authored.scanAndAdoptAuthoredServers();

    const result = await authored.promoteAndEnableAuthoredServer('security-b');
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(1);
    await waitForReady('security-b');

    const record = await store.getHostedServer('security-b');
    expect(record?.enabled).toBe(true);
    expect(record?.autostart).toBe(true);
    expect(record?.fileHashes).toBeDefined();
    expect(Object.keys(record!.fileHashes!).sort()).toEqual(['index.mjs', 'manifest.json']);
    expect(record?.toolsAtApproval).toEqual([{ name: 'convert_temperature' }]);
  }, 20000);

  it('refuses to promote an id that was never adopted, or is not an authored server', async () => {
    const missing = await authored.promoteAndEnableAuthoredServer('never-heard-of-it');
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/no agent-authored server/i);

    await store.registerHostedServer({
      id: 'not-authored', label: 'x', install: { kind: 'custom' }, entry: { command: '/usr/bin/true', args: [] },
    });
    const wrongKind = await authored.promoteAndEnableAuthoredServer('not-authored');
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.error).toMatch(/not written by claude/i);
  });

  it('refuses to promote when the workspace source has been deleted', async () => {
    writeAuthoredFixture('vanishing');
    await authored.scanAndAdoptAuthoredServers();
    fs.rmSync(path.join(workspaceServersRoot(), 'vanishing'), { recursive: true, force: true });

    const result = await authored.promoteAndEnableAuthoredServer('vanishing');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer has/i);
    expect((await store.getHostedServer('vanishing'))?.enabled).toBe(false); // untouched
  });
});

describe('drift detection', () => {
  it('is undefined before the first promotion — no baseline to diff against', async () => {
    writeAuthoredFixture('drift-a');
    await authored.scanAndAdoptAuthoredServers();
    expect(await authored.computeAuthoredDrift('drift-a')).toBeUndefined();
  });

  it('reports the right count after editing the workspace copy, and 0 right after promotion', async () => {
    writeAuthoredFixture('drift-b');
    await authored.scanAndAdoptAuthoredServers();
    await authored.promoteAndEnableAuthoredServer('drift-b');
    await waitForReady('drift-b');

    expect(await authored.computeAuthoredDrift('drift-b')).toBe(0);

    fs.appendFileSync(path.join(workspaceServersRoot(), 'drift-b', 'index.mjs'), '\n// a harmless edit\n');
    expect(await authored.computeAuthoredDrift('drift-b')).toBe(1);

    const manifestPath = path.join(workspaceServersRoot(), 'drift-b', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.description = 'A new description.';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(await authored.computeAuthoredDrift('drift-b')).toBe(2);

    // Re-promoting takes a fresh baseline, so drift clears back to 0.
    await authored.promoteAndEnableAuthoredServer('drift-b');
    await waitForReady('drift-b');
    expect(await authored.computeAuthoredDrift('drift-b')).toBe(0);
  }, 20000);
});

describe('listAuthoredInfo', () => {
  it('reads the manifest description live and reports the current rejection list', async () => {
    writeAuthoredFixture('info-a', { description: 'Does a thing for the user.' });
    writeAuthoredFixture('info-bad', { manifestId: 'mismatched' });
    const scan = await authored.scanAndAdoptAuthoredServers();
    expect(scan.adopted).toEqual(['info-a']);
    expect(scan.rejected).toHaveLength(1);

    const info = await authored.listAuthoredInfo();
    const entry = info.servers.find((s) => s.id === 'info-a');
    expect(entry?.description).toBe('Does a thing for the user.');
    expect(entry?.driftCount).toBeUndefined(); // not promoted yet

    expect(info.rejected).toHaveLength(1);
    expect(info.rejected[0].dir).toBe('info-bad');
  });
});
