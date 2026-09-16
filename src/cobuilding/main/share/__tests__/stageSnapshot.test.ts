/**
 * @jest-environment node
 *
 * `main/share/stageSnapshot.ts` — materializing a snapshot on disk (ticket
 * M3, contracts C1-C3 in `docs/design/sharing-tickets.md`).
 *
 * Real temp-dir fixtures throughout (`fs.mkdtempSync`), following the same
 * approach as `snapshotSources.test.ts`: a fixture workspace with the real
 * code/data-split symlinks, run through the REAL `listSnapshotSources` (M1)
 * before being staged, so this test exercises the actual M1 -> M3 handoff
 * rather than a hand-built `SnapshotSource[]`.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { versionedBase } from '../../../shared/share';
import { listSnapshotSources } from '../snapshotSources';
import { StagedFile, stageSnapshot } from '../stageSnapshot';

const SHARE_ID = 'testshareid12345';
const HASH = crypto.createHash('sha256').update('fixture-hash-seed').digest('hex');

/**
 * Builds a fixture under `root`:
 *   .applications/x/src/index.html      (rewritable; no local-file:// literal)
 *   .applications/x/dist/bundle.js      (rewritable; contains the app's own
 *                                         `local-file://${workspacePath}` idiom,
 *                                         twice)
 *   .applications/x/manifest.json       (not rewritable; contains the literal
 *                                         anyway, to prove extension alone
 *                                         gates the rewrite even inside the
 *                                         app's own directory)
 *   .applications/_vendor/tailwind.js   (rewritable extension, but under
 *                                         `_vendor` — must be copied verbatim
 *                                         even though it contains the literal)
 *   .applications/x/input  -> ../../tool-data/x/input   (symlink; input/i.csv)
 *   .applications/x/output -> ../../tool-data/x/output  (symlink; output/o.json)
 */
function buildFixture(root: string): void {
  const appDir = path.join(root, '.applications', 'x');
  const vendorDir = path.join(root, '.applications', '_vendor');
  const toolDataInput = path.join(root, 'tool-data', 'x', 'input');
  const toolDataOutput = path.join(root, 'tool-data', 'x', 'output');

  fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(toolDataInput, { recursive: true });
  fs.mkdirSync(toolDataOutput, { recursive: true });

  fs.writeFileSync(path.join(appDir, 'src', 'index.html'), '<html><body>hi</body></html>');
  fs.writeFileSync(
    path.join(appDir, 'dist', 'bundle.js'),
    'const workspacePath = window.getWorkspacePath();\n' +
      'const a = `local-file://${workspacePath}/.applications/x/output/plot.png`;\n' +
      'const b = `local-file://${workspacePath}/.applications/x/output/other.png`;\n',
  );
  fs.writeFileSync(
    path.join(appDir, 'manifest.json'),
    '{"name":"x","note":"local-file://not-actually-rewritten"}',
  );
  fs.writeFileSync(
    path.join(vendorDir, 'tailwind.js'),
    '// vendor asset, deliberately also contains the literal:\n' +
      'const legacy = "local-file:///some/path";\n',
  );
  fs.writeFileSync(path.join(toolDataInput, 'i.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(toolDataOutput, 'o.json'), '{"result":1}');

  fs.symlinkSync(path.join('..', '..', 'tool-data', 'x', 'input'), path.join(appDir, 'input'), 'dir');
  fs.symlinkSync(path.join('..', '..', 'tool-data', 'x', 'output'), path.join(appDir, 'output'), 'dir');
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function find(staged: StagedFile[], snapshotPath: string): StagedFile {
  const f = staged.find((s) => s.snapshotPath === snapshotPath);
  if (!f) throw new Error(`not staged: ${snapshotPath}`);
  return f;
}

describe('stageSnapshot', () => {
  let root: string;
  let stagingDir: string;
  let staged: StagedFile[];
  const expectedBase = versionedBase('app', SHARE_ID, HASH);

  beforeEach(async () => {
    root = mkTmp('acabox-stage-src-');
    stagingDir = mkTmp('acabox-stage-out-');
    buildFixture(root);

    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    staged = await stageSnapshot({
      sources,
      dirName: 'x',
      kind: 'app',
      id: SHARE_ID,
      hash: HASH,
      stagingDir,
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  it('stages exactly one file per source', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    expect(staged).toHaveLength(sources.length);
  });

  it('every staged file exists on disk at its absPath', () => {
    for (const f of staged) {
      expect(fs.existsSync(f.absPath)).toBe(true);
      expect(f.absPath).toBe(path.join(stagingDir, f.snapshotPath));
    }
  });

  it('returns results sorted by snapshotPath', () => {
    const paths = staged.map((f) => f.snapshotPath);
    expect(paths).toEqual([...paths].sort());
  });

  it('rewrites bundle.js: no local-file:// left, versioned base present, both occurrences replaced', () => {
    const f = find(staged, 'w/.applications/x/dist/bundle.js');
    const content = fs.readFileSync(f.absPath, 'utf8');
    expect(content).not.toContain('local-file://');
    expect(content).toContain(expectedBase);
    // Both occurrences from the fixture were rewritten, not just the first.
    expect(content.split(expectedBase).length - 1).toBe(2);
  });

  it('bundle.js staged size reflects the rewritten (longer) content, not the source size', () => {
    const f = find(staged, 'w/.applications/x/dist/bundle.js');
    const sourceSize = fs.statSync(path.join(root, '.applications', 'x', 'dist', 'bundle.js')).size;
    const stagedBytes = fs.readFileSync(f.absPath, 'utf8');
    expect(f.size).toBe(Buffer.byteLength(stagedBytes, 'utf8'));
    // The versioned base is longer than the 13-byte `local-file://` literal it
    // replaces, twice over, so the staged file must be strictly larger.
    expect(f.size).toBeGreaterThan(sourceSize);
  });

  it('index.html is passed through unrewritten content-wise when it has no literal, but still copied via the rewrite path (rewritable extension)', () => {
    const f = find(staged, 'w/.applications/x/src/index.html');
    const sourceBytes = fs.readFileSync(path.join(root, '.applications', 'x', 'src', 'index.html'));
    const stagedBytes = fs.readFileSync(f.absPath);
    expect(stagedBytes).toEqual(sourceBytes);
    expect(f.contentType).toBe('text/html; charset=utf-8');
  });

  it('manifest.json keeps its local-file:// literal verbatim — json is not a rewritable extension, even inside the app dir', () => {
    const f = find(staged, 'w/.applications/x/manifest.json');
    const content = fs.readFileSync(f.absPath, 'utf8');
    expect(content).toContain('local-file://not-actually-rewritten');
    const sourceBytes = fs.readFileSync(path.join(root, '.applications', 'x', 'manifest.json'));
    expect(fs.readFileSync(f.absPath)).toEqual(sourceBytes);
  });

  it('_vendor/tailwind.js is byte-identical to its source even though it contains local-file:// and has a rewritable extension', () => {
    const f = find(staged, 'w/.applications/_vendor/tailwind.js');
    const sourceBytes = fs.readFileSync(path.join(root, '.applications', '_vendor', 'tailwind.js'));
    const stagedBytes = fs.readFileSync(f.absPath);
    expect(stagedBytes).toEqual(sourceBytes);
    expect(stagedBytes.toString('utf8')).toContain('local-file://');
    expect(f.size).toBe(sourceBytes.length);
  });

  it('output/o.json is byte-identical to the real tool-data target reached through the symlink', () => {
    const f = find(staged, 'w/.applications/x/output/o.json');
    const realBytes = fs.readFileSync(path.join(root, 'tool-data', 'x', 'output', 'o.json'));
    const stagedBytes = fs.readFileSync(f.absPath);
    expect(stagedBytes).toEqual(realBytes);
    expect(f.size).toBe(realBytes.length);
    expect(f.contentType).toBe('application/json; charset=utf-8');
  });

  it('does not delete or otherwise disturb stagingDir itself', () => {
    // The directory the caller handed in must still exist and still be a dir.
    expect(fs.statSync(stagingDir).isDirectory()).toBe(true);
  });

  it('is idempotent: staging the same sources twice into the same dir yields the same content', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const again = await stageSnapshot({
      sources,
      dirName: 'x',
      kind: 'app',
      id: SHARE_ID,
      hash: HASH,
      stagingDir,
    });
    expect(again).toHaveLength(staged.length);
    for (const f of again) {
      const other = find(staged, f.snapshotPath);
      expect(f.size).toBe(other.size);
      expect(fs.readFileSync(f.absPath)).toEqual(fs.readFileSync(other.absPath));
    }
  });
});
