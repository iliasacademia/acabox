/**
 * @jest-environment node
 *
 * `main/share/shareStore.ts` — persistence, masking, and the "blank means
 * keep" rule for the publish token, plus the published-files registry.
 *
 * Same bug class this guards against as `apiStore.test.ts`: a mutation that
 * writes back a value it read from a masked/derived accessor, or that resaves
 * settings and clobbers an unrelated part of the record, silently destroys
 * state. A settings save must not cost you the token, and it must not cost
 * you the published-files registry either.
 *
 * `safeStorage` is faked — jest has no Electron main process, so the real
 * keychain path cannot run here. The fake is deliberately obscuring (a
 * prefixed string) so "no plaintext on disk" is a real assertion about the
 * envelope, not a tautology.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PublishedInfo } from '../../../shared/share';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-share-'));
const settingsPath = path.join(tmpDir, 'cobuilding-settings.json');

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`fake-keychain:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^fake-keychain:/, ''),
  },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  getPublishedFile,
  getShareSettings,
  getShareSettingsForUi,
  isShareConfigured,
  listPublishedFiles,
  migratePlaintextShareToken,
  removePublishedFile,
  saveShareSettings,
  setPublishedFile,
} from '../shareStore';

const SITE_URL = 'https://acabox-share.acct.workers.dev';
const API_URL = 'https://acabox-share-api.acct.workers.dev';

/** The raw settings file, as it sits on disk. */
function onDisk(): string {
  return fs.readFileSync(settingsPath, 'utf-8');
}

function writeRawSharing(sharing: Record<string, unknown>): void {
  fs.writeFileSync(settingsPath, JSON.stringify({ sharing }), 'utf-8');
}

function publishedInfo(over: Partial<PublishedInfo> = {}): PublishedInfo {
  return {
    id: 'abc1234567',
    kind: 'file',
    url: `${SITE_URL}/f/abc1234567/`,
    hash: 'a'.repeat(64),
    publishedAt: '2026-09-15T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  fs.writeFileSync(settingsPath, '{}', 'utf-8');
});

describe('storing a publish token', () => {
  it('encrypts at rest — the raw token never appears in the file', () => {
    const result = saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'SUPERSECRETTOKEN' });

    expect(result.ok).toBe(true);
    expect(onDisk()).not.toContain('SUPERSECRETTOKEN');
    expect(onDisk()).toContain('enc:v1:');
    expect(getShareSettings().publishToken).toBe('SUPERSECRETTOKEN');
  });

  it('getShareSettingsForUi reports hasToken and carries no token field at all', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'SUPERSECRETTOKEN' });

    const forUi = getShareSettingsForUi();
    expect(forUi.hasToken).toBe(true);
    expect(JSON.stringify(forUi)).not.toContain('SUPERSECRETTOKEN');
    expect((forUi as unknown as Record<string, unknown>).publishToken).toBeUndefined();
    expect((forUi as unknown as Record<string, unknown>).token).toBeUndefined();
    expect(Object.keys(forUi).sort()).toEqual(['apiUrl', 'hasToken', 'siteUrl']);
  });

  it('reports hasToken false when no token is stored', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL });
    expect(getShareSettingsForUi().hasToken).toBe(false);
    expect(getShareSettings().publishToken).toBe('');
  });

  it('never writes the literal token string anywhere outside its enc:v1: envelope', () => {
    const secret = 'a-very-specific-token-value-0123456789';
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: secret });
    expect(onDisk()).not.toContain(secret);
  });
});

describe('editing without retyping the token', () => {
  it('keeps the stored token when the field comes back blank', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'ORIGINAL' });

    // Exactly what the UI posts: an edited URL, no token (masked form).
    const result = saveShareSettings({ siteUrl: `${SITE_URL}/`, apiUrl: API_URL, publishToken: '' });

    expect(result.ok).toBe(true);
    expect(getShareSettings().publishToken).toBe('ORIGINAL');
    expect(getShareSettings().siteUrl).toBe(SITE_URL); // trailing slash stripped
  });

  it('keeps the stored token when publishToken is omitted entirely', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'ORIGINAL' });
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL });
    expect(getShareSettings().publishToken).toBe('ORIGINAL');
  });

  it('replaces the token when a new one is provided', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'OLD' });
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'NEW' });
    expect(getShareSettings().publishToken).toBe('NEW');
    expect(onDisk()).not.toContain('OLD');
  });

  it('removes the token only when clearToken is explicit', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'SUPERSECRETTOKEN' });
    const result = saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, clearToken: true });

    expect(result.ok).toBe(true);
    expect(getShareSettingsForUi().hasToken).toBe(false);
    expect(getShareSettings().publishToken).toBe('');
    expect(onDisk()).not.toContain('SUPERSECRETTOKEN');
  });

  it('does not clobber the published-files registry when settings are resaved', () => {
    setPublishedFile('a.csv', publishedInfo());
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'TOK' });
    expect(getPublishedFile('a.csv')).toEqual(publishedInfo());
  });
});

describe('validation', () => {
  it('rejects an invalid site URL and writes nothing', () => {
    const result = saveShareSettings({ siteUrl: 'not-a-url', apiUrl: API_URL, publishToken: 'TOK' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/url/i);
    expect(getShareSettingsForUi()).toEqual({ siteUrl: '', apiUrl: '', hasToken: false });
    expect(onDisk()).not.toContain('TOK');
  });

  it('rejects a non-https API URL and writes nothing', () => {
    const result = saveShareSettings({ siteUrl: SITE_URL, apiUrl: 'http://remote.example.com', publishToken: 'TOK' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/https/);
    expect(getShareSettingsForUi().apiUrl).toBe('');
  });

  it('leaves a previously-saved config untouched after a later rejected save', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'ORIGINAL' });
    saveShareSettings({ siteUrl: 'nope', apiUrl: API_URL, publishToken: 'SHOULD-NOT-STICK' });

    expect(getShareSettings()).toEqual({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'ORIGINAL' });
    expect(onDisk()).not.toContain('SHOULD-NOT-STICK');
  });
});

describe('isShareConfigured', () => {
  it('is false until the site URL, API URL and token are all set, true once they are', () => {
    expect(isShareConfigured()).toBe(false);

    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL });
    expect(isShareConfigured()).toBe(false); // no token yet

    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'TOK' });
    expect(isShareConfigured()).toBe(true);

    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, clearToken: true });
    expect(isShareConfigured()).toBe(false);
  });
});

describe('published-files registry', () => {
  it('round-trips a published file', () => {
    setPublishedFile('MyResearch/Data.csv', publishedInfo());
    expect(getPublishedFile('MyResearch/Data.csv')).toEqual(publishedInfo());
    expect(listPublishedFiles()).toEqual([{ relPath: 'MyResearch/Data.csv', info: publishedInfo() }]);
  });

  it('returns null for an unpublished path', () => {
    expect(getPublishedFile('nope.csv')).toBeNull();
  });

  it('overwrites the entry for the same path on a republish', () => {
    setPublishedFile('a.csv', publishedInfo({ hash: 'a'.repeat(64) }));
    setPublishedFile('a.csv', publishedInfo({ hash: 'b'.repeat(64) }));
    expect(getPublishedFile('a.csv')?.hash).toBe('b'.repeat(64));
    expect(listPublishedFiles()).toHaveLength(1);
  });

  it('removes a published file', () => {
    setPublishedFile('a.csv', publishedInfo());
    removePublishedFile('a.csv');
    expect(getPublishedFile('a.csv')).toBeNull();
    expect(listPublishedFiles()).toHaveLength(0);
  });

  it('removing a path that was never published is a no-op', () => {
    expect(() => removePublishedFile('never-published.csv')).not.toThrow();
    expect(listPublishedFiles()).toHaveLength(0);
  });

  it('lists multiple published files independently', () => {
    setPublishedFile('a.csv', publishedInfo({ id: 'aaaaaaaaaa' }));
    setPublishedFile('b.csv', publishedInfo({ id: 'bbbbbbbbbb' }));
    expect(listPublishedFiles().map((f) => f.relPath).sort()).toEqual(['a.csv', 'b.csv']);
  });

  it('drops a malformed entry written by another build rather than throwing', () => {
    writeRawSharing({
      siteUrl: SITE_URL,
      apiUrl: API_URL,
      publishToken: '',
      files: { 'ok.csv': publishedInfo(), 'bad.csv': { id: 'onlyId' } },
    });
    expect(listPublishedFiles().map((f) => f.relPath)).toEqual(['ok.csv']);
  });
});

describe('migrating a legacy plaintext token', () => {
  it('encrypts a hand-written plaintext token once, at boot', () => {
    writeRawSharing({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'PLAINTEXT', files: {} });
    expect(onDisk()).toContain('PLAINTEXT');

    migratePlaintextShareToken();

    expect(onDisk()).not.toContain('"PLAINTEXT"');
    expect(onDisk()).toContain('enc:v1:');
    expect(getShareSettings().publishToken).toBe('PLAINTEXT');

    // Idempotent: a second run must not double-wrap.
    const after = onDisk();
    migratePlaintextShareToken();
    expect(onDisk()).toBe(after);
  });

  it('is a no-op when there is no token to migrate', () => {
    expect(() => migratePlaintextShareToken()).not.toThrow();
    expect(getShareSettings().publishToken).toBe('');
  });

  it('is a no-op when the stored token is already encrypted', () => {
    saveShareSettings({ siteUrl: SITE_URL, apiUrl: API_URL, publishToken: 'ALREADY-ENCRYPTED' });
    const before = onDisk();
    migratePlaintextShareToken();
    expect(onDisk()).toBe(before);
  });
});
