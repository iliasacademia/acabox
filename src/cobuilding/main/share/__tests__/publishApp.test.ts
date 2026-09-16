/**
 * @jest-environment node
 *
 * `main/share/publishApp.ts` — app publisher + status (ticket M5, contracts
 * C1-C4 in `docs/design/sharing-tickets.md`).
 *
 * Real temp-dir fixtures throughout (`fs.mkdtempSync`), following the same
 * approach as `snapshotSources.test.ts` / `stageSnapshot.test.ts`: a fixture
 * workspace with the real code/data-split symlinks, run through the REAL
 * `listSnapshotSources` -> `stageSnapshot` pipeline. Only the network side
 * (`ShareApi`) is faked, via an in-order call recorder.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ArtifactMeta, PublishedInfo, ShareIndex, ShareKind } from '../../../shared/share';
import { versionedBase } from '../../../shared/share';
import type { ShareApi } from '../shareApiClient';
import { listSnapshotSources } from '../snapshotSources';
import { stageSnapshot } from '../stageSnapshot';
import { computeAppStatus, publishApp, unpublishApp } from '../publishApp';

const SITE_URL = 'https://acabox-share.example.workers.dev';

/**
 * Builds a fixture under `root`, deliberately overlapping with
 * `stageSnapshot.test.ts`'s fixture (same rewrite-boundary cases) so this
 * test also exercises the M1 -> M3 -> upload handoff end to end:
 *   .applications/x/src/index.html
 *   .applications/x/dist/bundle.js       (contains `local-file://…`, twice)
 *   .applications/x/manifest.json
 *   .applications/_vendor/acabox.css
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
  fs.writeFileSync(path.join(appDir, 'manifest.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(vendorDir, 'acabox.css'), ':root { --cd-border: #dddde2; }');
  fs.writeFileSync(path.join(toolDataInput, 'i.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(toolDataOutput, 'o.json'), '{"result":1}');

  fs.symlinkSync(path.join('..', '..', 'tool-data', 'x', 'input'), path.join(appDir, 'input'), 'dir');
  fs.symlinkSync(path.join('..', '..', 'tool-data', 'x', 'output'), path.join(appDir, 'output'), 'dir');
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * Records every call, in order, and can be told to throw exactly once from
 * `putFile` (whichever call happens to land first — concurrency makes "which"
 * non-deterministic, and the tests that use this don't care which).
 */
class FakeShareApi implements ShareApi {
  calls: RecordedCall[] = [];
  committed: ArtifactMeta | null = null;
  /** relPath -> uploaded bytes, so tests can cross-check against the staged files. */
  putFileBodies = new Map<string, Uint8Array>();
  private putFileFailedOnce = false;

  constructor(private readonly opts: { failPutFileOnce?: boolean } = {}) {}

  async health(): Promise<void> {
    this.calls.push({ method: 'health', args: [] });
  }

  async listArtifacts(): Promise<ShareIndex> {
    this.calls.push({ method: 'listArtifacts', args: [] });
    return { updatedAt: new Date().toISOString(), artifacts: [] };
  }

  async getArtifact(kind: ShareKind, id: string): Promise<ArtifactMeta | null> {
    this.calls.push({ method: 'getArtifact', args: [kind, id] });
    return null;
  }

  async putFile(
    kind: ShareKind,
    id: string,
    hash: string,
    relPath: string,
    body: Uint8Array | ReadableStream,
    contentType: string,
  ): Promise<void> {
    this.calls.push({ method: 'putFile', args: [kind, id, hash, relPath, contentType] });
    if (this.opts.failPutFileOnce && !this.putFileFailedOnce) {
      this.putFileFailedOnce = true;
      throw new Error('simulated putFile failure');
    }
    this.putFileBodies.set(relPath, body as Uint8Array);
  }

  async commit(meta: ArtifactMeta): Promise<void> {
    this.calls.push({ method: 'commit', args: [meta] });
    this.committed = meta;
  }

  async remove(kind: ShareKind, id: string): Promise<void> {
    this.calls.push({ method: 'remove', args: [kind, id] });
  }
}

function baseInput(root: string, stagingRoot: string, over: Partial<Parameters<typeof publishApp>[1]> = {}) {
  return {
    workspaceRoot: root,
    dirName: 'x',
    includeInput: true,
    siteUrl: SITE_URL,
    title: 'X Tool',
    description: 'A test tool',
    existing: null,
    stagingRoot,
    ...over,
  };
}

describe('publishApp', () => {
  let root: string;
  let stagingRoot: string;

  beforeEach(() => {
    root = mkTmp('acabox-publishapp-src-');
    stagingRoot = mkTmp('acabox-publishapp-staging-');
    buildFixture(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  });

  it('uploads every staged file exactly once, then commits exactly once', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const total = sources.length;

    const api = new FakeShareApi();
    await publishApp(api, baseInput(root, stagingRoot));

    const methods = api.calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'putFile')).toHaveLength(total);
    expect(methods.filter((m) => m === 'commit')).toHaveLength(1);
    // Every putFile precedes the single commit.
    expect(methods.indexOf('commit')).toBe(methods.length - 1);
  });

  it('commits meta with the right entry, dirName, files.length and hash', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const api = new FakeShareApi();
    const result = await publishApp(api, baseInput(root, stagingRoot));

    expect(api.committed).not.toBeNull();
    const meta = api.committed!;
    expect(meta.id).toBe(result.published.id);
    expect(meta.kind).toBe('app');
    expect(meta.entry).toBe('.applications/x/src/index.html');
    expect(meta.dirName).toBe('x');
    expect(meta.files).toHaveLength(sources.length);
    expect(meta.hash).toBe(result.published.hash);
    expect(meta.title).toBe('X Tool');
    expect(meta.description).toBe('A test tool');
  });

  it('every putFile relPath equals a staged snapshotPath and the uploaded bytes equal the staged file', async () => {
    const api = new FakeShareApi();
    const result = await publishApp(api, baseInput(root, stagingRoot));

    // Independently re-stage with the same id/hash the publish produced, so
    // this cross-checks against the real M1 -> M3 pipeline rather than a
    // second implementation of it.
    const independentStagingDir = mkTmp('acabox-publishapp-crosscheck-');
    try {
      const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
      const staged = await stageSnapshot({
        sources,
        dirName: 'x',
        kind: 'app',
        id: result.published.id,
        hash: result.published.hash,
        stagingDir: independentStagingDir,
      });
      const stagedPaths = new Set(staged.map((f) => f.snapshotPath));

      const putFileCalls = api.calls.filter((c) => c.method === 'putFile');
      expect(putFileCalls).toHaveLength(staged.length);
      for (const call of putFileCalls) {
        const relPath = call.args[3] as string;
        expect(stagedPaths.has(relPath)).toBe(true);
      }

      for (const file of staged) {
        const uploaded = api.putFileBodies.get(file.snapshotPath);
        expect(uploaded).toBeDefined();
        expect(Buffer.from(uploaded!)).toEqual(fs.readFileSync(file.absPath));
      }
    } finally {
      fs.rmSync(independentStagingDir, { recursive: true, force: true });
    }
  });

  it('bundle.js uploaded bytes contain the versioned base and no local-file://', async () => {
    const api = new FakeShareApi();
    const result = await publishApp(api, baseInput(root, stagingRoot));

    const body = api.putFileBodies.get('w/.applications/x/dist/bundle.js');
    expect(body).toBeDefined();
    const text = Buffer.from(body!).toString('utf8');
    expect(text).not.toContain('local-file://');
    expect(text).toContain(versionedBase('app', result.published.id, result.published.hash));
  });

  it('onProgress ends at {uploaded: N, total: N}', async () => {
    const sources = await listSnapshotSources({ workspaceRoot: root, dirName: 'x', includeInput: true });
    const total = sources.length;

    const progressCalls: Array<{ uploaded: number; total: number }> = [];
    const api = new FakeShareApi();
    await publishApp(api, baseInput(root, stagingRoot, { onProgress: (p) => progressCalls.push(p) }));

    expect(progressCalls).toHaveLength(total);
    expect(progressCalls[progressCalls.length - 1]).toEqual({ uploaded: total, total });
    // Monotonically increasing uploaded count.
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i].uploaded).toBe(progressCalls[i - 1].uploaded + 1);
    }
  });

  it('removes the staging directory after a successful publish', async () => {
    const api = new FakeShareApi();
    await publishApp(api, baseInput(root, stagingRoot));
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
  });

  it('propagates a putFile rejection and still removes the staging directory', async () => {
    const api = new FakeShareApi({ failPutFileOnce: true });
    await expect(publishApp(api, baseInput(root, stagingRoot))).rejects.toThrow('simulated putFile failure');
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
  });

  it('returns unchanged: true and makes zero API calls when existing.hash already matches', async () => {
    const status = await computeAppStatus({ workspaceRoot: root, dirName: 'x', includeInput: true, existing: null });
    const existing: PublishedInfo = {
      id: 'preexistingid123',
      kind: 'app',
      url: `${SITE_URL}/a/preexistingid123/`,
      hash: status.hash,
      publishedAt: '2026-01-01T00:00:00.000Z',
      includeInput: true,
    };

    const api = new FakeShareApi();
    const result = await publishApp(api, baseInput(root, stagingRoot, { existing }));

    expect(result.unchanged).toBe(true);
    expect(result.published).toBe(existing);
    expect(api.calls).toHaveLength(0);
  });

  it('detects drift after editing output/o.json and republish reuses the existing id', async () => {
    const api = new FakeShareApi();
    const first = await publishApp(api, baseInput(root, stagingRoot));

    fs.writeFileSync(path.join(root, 'tool-data', 'x', 'output', 'o.json'), '{"result":2}');

    const status = await computeAppStatus({
      workspaceRoot: root,
      dirName: 'x',
      includeInput: true,
      existing: first.published,
    });
    expect(status.behind).toBe(true);
    expect(status.hash).not.toBe(first.published.hash);

    const second = await publishApp(api, baseInput(root, stagingRoot, { existing: first.published }));
    expect(second.unchanged).toBe(false);
    expect(second.published.id).toBe(first.published.id);
    expect(second.published.hash).not.toBe(first.published.hash);
    expect(second.published.hash).toBe(status.hash);
  });

  it('unpublishApp calls remove("app", id)', async () => {
    const api = new FakeShareApi();
    const existing: PublishedInfo = {
      id: 'toremoveid123456',
      kind: 'app',
      url: `${SITE_URL}/a/toremoveid123456/`,
      hash: 'a'.repeat(64),
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
    await unpublishApp(api, existing);
    expect(api.calls).toEqual([{ method: 'remove', args: ['app', 'toremoveid123456'] }]);
  });
});

describe('computeAppStatus', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmp('acabox-appstatus-src-');
    buildFixture(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports behind: false and a 64-hex hash when there is no existing publish', async () => {
    const status = await computeAppStatus({ workspaceRoot: root, dirName: 'x', includeInput: true, existing: null });
    expect(status.behind).toBe(false);
    expect(status.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports behind: false when existing.hash matches the current snapshot', async () => {
    const first = await computeAppStatus({ workspaceRoot: root, dirName: 'x', includeInput: true, existing: null });
    const existing: PublishedInfo = {
      id: 'someid1234567890',
      kind: 'app',
      url: 'https://x/a/someid1234567890/',
      hash: first.hash,
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
    const status = await computeAppStatus({ workspaceRoot: root, dirName: 'x', includeInput: true, existing });
    expect(status.behind).toBe(false);
  });

  it('summarizes files into code/output/input/vendor/total groups', async () => {
    const status = await computeAppStatus({ workspaceRoot: root, dirName: 'x', includeInput: true, existing: null });
    expect(status.summary.output.count).toBe(1);
    expect(status.summary.input.count).toBe(1);
    expect(status.summary.vendor.count).toBe(1);
    expect(status.summary.total.count).toBe(status.files.length);
  });

  it('makes no network calls (pure function of the filesystem)', async () => {
    // Nothing to assert against a fake here beyond the type signature itself
    // taking no ShareApi — this test documents the guarantee: calling it
    // twice in a row with no mutation in between is stable.
    const a = await computeAppStatus({ workspaceRoot: root, dirName: 'x', includeInput: true, existing: null });
    const b = await computeAppStatus({ workspaceRoot: root, dirName: 'x', includeInput: true, existing: null });
    expect(a.hash).toBe(b.hash);
  });
});
