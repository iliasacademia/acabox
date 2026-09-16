/**
 * @jest-environment node
 *
 * `main/share/snapshotSources.ts` — enumeration + hash of a mini-app's
 * publish snapshot (ticket M1, contracts C1-C3 in `docs/design/sharing-tickets.md`).
 *
 * Real temp-dir fixtures throughout (`fs.mkdtempSync`) rather than mocking
 * `fs` — the whole point of this module is real symlink/exclusion behaviour,
 * which a mock cannot exercise honestly.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashSnapshotSources, listSnapshotSources, SnapshotSource } from '../snapshotSources';

/**
 * Builds the fixture the ticket describes under `root`:
 *   .applications/x/src/index.html
 *   .applications/x/dist/bundle.js
 *   .applications/x/manifest.json
 *   .applications/x/node_modules/junk.js       (excluded)
 *   .applications/x/.git/HEAD                  (excluded)
 *   .applications/x/.DS_Store                  (excluded)
 *   .applications/x/broken -> nonexistent-target       (broken symlink, excluded)
 *   .applications/x/escape -> /etc                     (outside workspace, excluded)
 *   .applications/x/input  -> ../../tool-data/x/input   (symlink; input/i.csv)
 *   .applications/x/output -> ../../tool-data/x/output  (symlink; output/o.json)
 *   .applications/_vendor/acabox.css
 * Returns the root for convenience.
 */
function buildFixture(root: string): string {
  const appDir = path.join(root, '.applications', 'x');
  const vendorDir = path.join(root, '.applications', '_vendor');
  const toolDataInput = path.join(root, 'tool-data', 'x', 'input');
  const toolDataOutput = path.join(root, 'tool-data', 'x', 'output');

  fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(toolDataInput, { recursive: true });
  fs.mkdirSync(toolDataOutput, { recursive: true });

  fs.writeFileSync(path.join(appDir, 'src', 'index.html'), '<html>hi</html>');
  fs.writeFileSync(path.join(appDir, 'dist', 'bundle.js'), 'console.log("bundle")');
  fs.writeFileSync(path.join(appDir, 'manifest.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(appDir, 'node_modules', 'junk.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(appDir, '.git', 'HEAD'), 'ref: refs/heads/main');
  fs.writeFileSync(path.join(appDir, '.DS_Store'), 'not-a-real-ds-store');
  fs.writeFileSync(path.join(vendorDir, 'acabox.css'), ':root { --cd-border: #dddde2; }');
  fs.writeFileSync(path.join(toolDataInput, 'i.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(toolDataOutput, 'o.json'), '{"result":1}');

  // Broken symlink: target never created.
  fs.symlinkSync(path.join(appDir, 'nonexistent-target'), path.join(appDir, 'broken'));
  // Symlink escaping the workspace entirely.
  fs.symlinkSync('/etc', path.join(appDir, 'escape'));
  // The real code/data-split symlinks, relative like toolDataMigration.ts makes them.
  fs.symlinkSync(path.join('..', '..', 'tool-data', 'x', 'input'), path.join(appDir, 'input'), 'dir');
  fs.symlinkSync(path.join('..', '..', 'tool-data', 'x', 'output'), path.join(appDir, 'output'), 'dir');

  return root;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-snapshot-sources-'));
}

function paths(sources: SnapshotSource[]): string[] {
  return sources.map((s) => s.snapshotPath);
}

describe('listSnapshotSources', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmp();
    buildFixture(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('enumerates exactly the expected files, sorted by snapshotPath, when includeInput is true', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    expect(paths(sources)).toEqual(
      [
        'w/.applications/_vendor/acabox.css',
        'w/.applications/x/dist/bundle.js',
        'w/.applications/x/input/i.csv',
        'w/.applications/x/manifest.json',
        'w/.applications/x/output/o.json',
        'w/.applications/x/src/index.html',
      ].sort(),
    );
  });

  it('is already sorted (matches Array.prototype.sort on snapshotPath)', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const got = paths(sources);
    expect(got).toEqual([...got].sort());
  });

  it('excludes input/** when includeInput is false, keeps output', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: false });
    const got = paths(sources);
    expect(got).not.toContain('w/.applications/x/input/i.csv');
    expect(got).toContain('w/.applications/x/output/o.json');
  });

  it('never includes node_modules', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    expect(paths(sources).some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('never includes .git or .DS_Store', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    expect(paths(sources).some((p) => p.includes('/.git/') || p.endsWith('.DS_Store'))).toBe(false);
  });

  it('skips a broken symlink silently', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    expect(paths(sources).some((p) => p.endsWith('/broken'))).toBe(false);
  });

  it('skips a symlink whose realpath is outside the workspace', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    expect(paths(sources).some((p) => p.endsWith('/escape'))).toBe(false);
    // And no /etc contents leaked in as a side effect of following it.
    expect(paths(sources).some((p) => p.includes('passwd'))).toBe(false);
  });

  it('resolves symlinked input/output to their tool-data targets (correct size + readable bytes)', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const output = sources.find((s) => s.snapshotPath === 'w/.applications/x/output/o.json');
    expect(output).toBeDefined();
    const realBytes = fs.readFileSync(path.join(root, 'tool-data', 'x', 'output', 'o.json'));
    expect(output!.size).toBe(realBytes.length);
    // `sourcePath` need not equal the tool-data realpath (it may still be the
    // path reached through the `.applications/x/output` symlink) — what
    // matters is that reading it yields the real target's bytes.
    expect(fs.readFileSync(output!.sourcePath)).toEqual(realBytes);
  });

  it('is empty for _vendor rather than erroring when _vendor does not exist', async () => {
    fs.rmSync(path.join(root, '.applications', '_vendor'), { recursive: true, force: true });
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    expect(paths(sources).some((p) => p.startsWith('w/.applications/_vendor/'))).toBe(false);
    // The rest of the app is unaffected.
    expect(paths(sources)).toContain('w/.applications/x/manifest.json');
  });

  it('throws "App not found: <dirName>" for a missing app directory', async () => {
    await expect(
      listSnapshotSources({ workspaceRoot: root, dirName: 'does-not-exist', includeInput: true }),
    ).rejects.toThrow('App not found: does-not-exist');
  });

  it.each(['a/b', 'a\\b', '.hidden', '..'])('rejects an unsafe dirName %p', async (dirName) => {
    await expect(listSnapshotSources({ workspaceRoot: root, dirName, includeInput: true })).rejects.toThrow();
  });

  it('rejects an empty dirName', async () => {
    await expect(listSnapshotSources({ workspaceRoot: root, dirName: '', includeInput: true })).rejects.toThrow();
  });
});

describe('hashSnapshotSources', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmp();
    buildFixture(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('produces a 64-hex-char hash and one SnapshotFile per source', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const { hash, files } = await hashSnapshotSources(sources);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(files).toHaveLength(sources.length);
    for (const f of files) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('matches the hash spelled out by C3 (manual recomputation)', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const { hash, files } = await hashSnapshotSources(sources);

    const manualFiles = sources
      .map((s) => ({
        path: s.snapshotPath,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(s.sourcePath)).digest('hex'),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    for (const f of files) {
      const expected = manualFiles.find((m) => m.path === f.path);
      expect(f.sha256).toBe(expected?.sha256);
    }

    const manualHash = crypto.createHash('sha256');
    for (const f of manualFiles) manualHash.update(`${f.path} ${f.sha256}\n`);
    expect(hash).toBe(manualHash.digest('hex'));
  });

  it('is stable across two calls on the same sources', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const first = await hashSnapshotSources(sources);
    const second = await hashSnapshotSources(sources);
    expect(second.hash).toBe(first.hash);
  });

  it('changes when one byte of output/o.json changes', async () => {
    const sourcesBefore = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const before = await hashSnapshotSources(sourcesBefore);

    fs.writeFileSync(path.join(root, 'tool-data', 'x', 'output', 'o.json'), '{"result":2}');

    const sourcesAfter = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const after = await hashSnapshotSources(sourcesAfter);

    expect(after.hash).not.toBe(before.hash);
  });

  it('is identical for a byte-for-byte copy of the fixture at a different absolute path', async () => {
    const root2 = mkTmp();
    try {
      buildFixture(root2);

      const sourcesA = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
      const sourcesB = await listSnapshotSources({ workspaceRoot: root2, dirName: 'x', includeInput: true });

      const hashA = await hashSnapshotSources(sourcesA);
      const hashB = await hashSnapshotSources(sourcesB);

      expect(hashB.hash).toBe(hashA.hash);
      // And the same holds with includeInput: false.
      const sourcesA2 = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: false });
      const sourcesB2 = await listSnapshotSources({ workspaceRoot: root2, dirName: 'x', includeInput: false });
      expect((await hashSnapshotSources(sourcesB2)).hash).toBe((await hashSnapshotSources(sourcesA2)).hash);
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  it('hashes a file that needs multiple stream chunks (streamed, not read whole into a string)', async () => {
    // Not a 15 MB fixture (too slow for a unit test) — this exercises the
    // multi-chunk path (default highWaterMark is 64 KiB) and cross-checks
    // against a plain readFileSync digest, which is the only thing a test can
    // observe about "streamed vs buffered": the RESULT must be identical.
    const bigPath = path.join(root, 'tool-data', 'x', 'output', 'big.bin');
    const big = crypto.randomBytes(500 * 1024); // 500 KiB, several chunks
    fs.writeFileSync(bigPath, big);

    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const { files } = await hashSnapshotSources(sources);
    const bigFile = files.find((f) => f.path === 'w/.applications/x/output/big.bin');
    expect(bigFile).toBeDefined();
    expect(bigFile!.sha256).toBe(crypto.createHash('sha256').update(big).digest('hex'));
  });
});
