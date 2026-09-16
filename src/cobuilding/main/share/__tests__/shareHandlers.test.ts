/**
 * @jest-environment node
 *
 * `main/share/shareHandlers.ts` — the IPC surface (ticket M9). Every handler
 * is an exported function taking `deps` explicitly, so these tests call them
 * directly with no `ipcMain` and no Electron main process involved.
 *
 * `electron`/`electron-log` are mocked exactly as `apiStore.test.ts` and
 * `shareStore.test.ts` do it — this module pulls in `shareStore.ts`
 * (→ `secretStore.ts` → `safeStorage`) and `fileHandlers.ts`
 * (`assertWithinAllowedDirs`) transitively, both of which need `electron` to
 * resolve even though this file never touches `ipcMain` itself except inside
 * `registerShareHandlers`, which none of these tests call.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ArtifactMeta, PublishedInfo, ShareIndex, ShareKind, ShareSettings } from '../../../shared/share';
import type { ShareApi } from '../shareApiClient';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-share-handlers-'));
const settingsPath = path.join(tmpDir, 'cobuilding-settings.json');

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`fake-keychain:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^fake-keychain:/, ''),
  },
  ipcMain: { handle: jest.fn() },
  dialog: {},
  shell: {},
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { saveShareSettings } from '../shareStore';
import {
  getSettings,
  planApp,
  publishApp,
  publishFile,
  saveSettings,
  statusFile,
  test as shareTest,
  unpublishApp,
  unpublishFile,
  type ShareHandlerDeps,
} from '../shareHandlers';

const SITE_URL = 'https://acabox-share.example.workers.dev';
const API_URL = 'https://acabox-share-api.example.workers.dev';

/** Records every call; `commit`/`remove` also capture their argument. */
class FakeShareApi implements ShareApi {
  calls: string[] = [];
  committed: ArtifactMeta | null = null;
  removed: Array<{ kind: ShareKind; id: string }> = [];

  async health(): Promise<void> {
    this.calls.push('health');
  }
  async listArtifacts(): Promise<ShareIndex> {
    this.calls.push('listArtifacts');
    return { updatedAt: new Date().toISOString(), artifacts: [] };
  }
  async getArtifact(): Promise<ArtifactMeta | null> {
    this.calls.push('getArtifact');
    return null;
  }
  async putFile(): Promise<void> {
    this.calls.push('putFile');
  }
  async commit(meta: ArtifactMeta): Promise<void> {
    this.calls.push('commit');
    this.committed = meta;
  }
  async remove(kind: ShareKind, id: string): Promise<void> {
    this.calls.push('remove');
    this.removed.push({ kind, id });
  }
}

function readManifestSync(workspaceRoot: string, dirName: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(workspaceRoot, '.applications', dirName, 'manifest.json'), 'utf-8');
  return JSON.parse(raw);
}

function buildAppFixture(workspaceRoot: string, dirName: string): void {
  const appDir = path.join(workspaceRoot, '.applications', dirName);
  fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'src', 'index.html'), '<html><body>hi</body></html>');
  fs.writeFileSync(
    path.join(appDir, 'manifest.json'),
    JSON.stringify({ name: 'X Tool', description: 'A test tool' }),
  );
}

interface TestDeps extends ShareHandlerDeps {
  broadcastCalls: Array<{ channel: string; payload: unknown }>;
}

function makeDeps(workspaceRoot: string | null, over: Partial<ShareHandlerDeps> = {}): TestDeps {
  const broadcastCalls: Array<{ channel: string; payload: unknown }> = [];
  return {
    getWorkspaceRoot: () => workspaceRoot,
    getAllowedPaths: () => (workspaceRoot ? [workspaceRoot] : []),
    broadcast: (channel: string, payload: unknown) => broadcastCalls.push({ channel, payload }),
    broadcastCalls,
    ...over,
  };
}

/** Fresh, unconfigured settings — every test starts from here. */
beforeEach(() => {
  fs.writeFileSync(settingsPath, '{}', 'utf-8');
});

function configureSharing(): void {
  const result = saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'tok-123' });
  expect(result.ok).toBe(true);
}

describe('planApp', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-share-handlers-ws-'));
    buildAppFixture(workspaceRoot, 'x');
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('returns a summary and behind:false when the app has never been published', async () => {
    const deps = makeDeps(workspaceRoot);
    const result = await planApp(deps, 'x', true);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.published).toBeNull();
    expect(result.behind).toBe(false);
    expect(result.summary.total.count).toBeGreaterThan(0);
    expect(typeof result.hash).toBe('string');
  });
});

describe('publishApp', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-share-handlers-ws-'));
    buildAppFixture(workspaceRoot, 'x');
    configureSharing();
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('writes `published` into the manifest, broadcasts share:changed, and reports upload progress', async () => {
    const api = new FakeShareApi();
    const deps = makeDeps(workspaceRoot, { createApi: () => api });

    const result = await publishApp(deps, 'x', { includeInput: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.unchanged).toBe(false);
    expect(result.published.kind).toBe('app');
    expect(result.published.url).toBe(`${SITE_URL}/a/${result.published.id}/`);

    const manifest = readManifestSync(workspaceRoot, 'x');
    expect(manifest.published).toEqual(result.published);

    expect(deps.broadcastCalls).toContainEqual({ channel: 'share:changed', payload: { dirName: 'x' } });
    const progressCalls = deps.broadcastCalls.filter((c) => c.channel === 'share:progress');
    expect(progressCalls.length).toBeGreaterThan(0);
    for (const call of progressCalls) {
      expect(call.payload).toMatchObject({ dirName: 'x' });
    }

    expect(api.committed?.title).toBe('X Tool');
    expect(api.committed?.description).toBe('A test tool');
  });

  it('while unconfigured, returns the not-configured message and makes zero API calls', async () => {
    fs.writeFileSync(settingsPath, '{}', 'utf-8'); // undo configureSharing()
    const createApi = jest.fn(() => new FakeShareApi());
    const deps = makeDeps(workspaceRoot, { createApi });

    const result = await publishApp(deps, 'x', { includeInput: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe(
      'Sharing is not configured. Add the site URL, API URL and token in Settings → Sharing.',
    );
    expect(createApi).not.toHaveBeenCalled();
  });
});

describe('unpublishApp', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-share-handlers-ws-'));
    buildAppFixture(workspaceRoot, 'x');
    configureSharing();
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('clears manifest.published and broadcasts share:changed', async () => {
    const api = new FakeShareApi();
    const deps = makeDeps(workspaceRoot, { createApi: () => api });

    const published = await publishApp(deps, 'x', { includeInput: true });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error('unreachable');

    const result = await unpublishApp(deps, 'x');

    expect(result.ok).toBe(true);
    const manifest = readManifestSync(workspaceRoot, 'x');
    expect(manifest.published).toBeUndefined();
    expect(api.removed).toEqual([{ kind: 'app', id: published.published.id }]);
    expect(deps.broadcastCalls.filter((c) => c.channel === 'share:changed')).toHaveLength(2); // publish + unpublish
  });

  it('is a no-op (and makes zero API calls) when nothing has been published', async () => {
    const createApi = jest.fn(() => new FakeShareApi());
    const deps = makeDeps(workspaceRoot, { createApi });

    const result = await unpublishApp(deps, 'x');

    expect(result.ok).toBe(true);
    expect(createApi).not.toHaveBeenCalled();
  });
});

describe('publishFile', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-share-handlers-ws-'));
    configureSharing();
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('with a path outside the allowed dirs, returns {ok:false} and makes zero API calls', async () => {
    const createApi = jest.fn(() => new FakeShareApi());
    const deps = makeDeps(workspaceRoot, { createApi });
    const outsidePath = path.join(os.tmpdir(), 'definitely-not-allowed', 'secret.csv');

    const result = await publishFile(deps, outsidePath);

    expect(result.ok).toBe(false);
    expect(createApi).not.toHaveBeenCalled();
  });

  it('for a file inside the allowed dirs, publishes it and records it in the registry', async () => {
    const filePath = path.join(workspaceRoot, 'shared-file.csv');
    fs.writeFileSync(filePath, 'a,b\n1,2\n');
    const api = new FakeShareApi();
    const deps = makeDeps(workspaceRoot, { createApi: () => api });

    const result = await publishFile(deps, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.published.kind).toBe('file');
    expect(deps.broadcastCalls).toContainEqual({ channel: 'share:changed', payload: { filePath } });

    const status = await statusFile(deps, filePath);
    expect(status.published).toEqual(result.published);
    expect(status.behind).toBe(false);
  });
});

describe('unpublishFile', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-share-handlers-ws-'));
    configureSharing();
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('clears the registry entry after a publish', async () => {
    const filePath = path.join(workspaceRoot, 'shared-file.csv');
    fs.writeFileSync(filePath, 'a,b\n1,2\n');
    const api = new FakeShareApi();
    const deps = makeDeps(workspaceRoot, { createApi: () => api });

    await publishFile(deps, filePath);
    const result = await unpublishFile(deps, filePath);

    expect(result.ok).toBe(true);
    const status = await statusFile(deps, filePath);
    expect(status.published).toBeNull();
  });
});

describe('test()', () => {
  it('without configuration, returns the not-configured error with status 0 and makes zero API calls', async () => {
    const createApi = jest.fn((_settings: ShareSettings) => new FakeShareApi());
    const deps = makeDeps(null, { createApi });

    const result = await shareTest(deps);

    expect(result).toEqual({ ok: false, status: 0, error: 'Sharing is not configured' });
    expect(createApi).not.toHaveBeenCalled();
  });

  it('once configured, reports ok:true from a healthy API', async () => {
    configureSharing();
    const api = new FakeShareApi();
    const deps = makeDeps(null, { createApi: () => api });

    const result = await shareTest(deps);

    expect(result).toEqual({ ok: true, status: 200, error: null });
    expect(api.calls).toEqual(['health']);
  });
});

describe('getSettings / saveSettings', () => {
  it('round-trip the site/API URLs without ever exposing the token', async () => {
    const saveResult = await saveSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'tok-123' });
    expect(saveResult).toEqual({ ok: true });

    const settings = await getSettings();
    expect(settings).toEqual({ siteUrl: SITE_URL, apiUrl: API_URL, hasToken: true });
  });
});
