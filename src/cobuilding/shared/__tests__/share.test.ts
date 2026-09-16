/**
 * `shared/share.ts` — the pure half of the sharing feature (ids, URLs, R2 key
 * layout, content types, path normalization). Every function here is used by
 * main, the two Cloudflare Workers, and the viewer shim, so a mistake here
 * would show up in all of them at once — hence the wide coverage.
 */
import {
  artifactUrl,
  contentTypeFor,
  INDEX_KEY,
  isValidHash,
  isValidShareId,
  kindPrefix,
  metaKey,
  mintShareId,
  normalizeBaseUrl,
  normalizeSnapshotPath,
  SHARE_REFUSAL_MESSAGE,
  summarizeSnapshot,
  validateShareSettings,
  versionedBase,
  versionPrefix,
  type SnapshotFile,
} from '../share';

describe('mintShareId', () => {
  it('returns 16 characters, each [a-z0-9]', () => {
    const id = mintShareId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[a-z0-9]{16}$/);
  });

  it('100 mints are pairwise distinct', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(mintShareId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('isValidShareId', () => {
  it('accepts a 16-char lowercase-alphanumeric id (the mintShareId shape)', () => {
    expect(isValidShareId(mintShareId())).toBe(true);
  });

  it('accepts the boundary lengths 10 and 32', () => {
    expect(isValidShareId('a'.repeat(10))).toBe(true);
    expect(isValidShareId('a'.repeat(32))).toBe(true);
  });

  it('rejects an id shorter than 10 characters', () => {
    expect(isValidShareId('a'.repeat(9))).toBe(false);
  });

  it('rejects an id longer than 32 characters', () => {
    expect(isValidShareId('a'.repeat(33))).toBe(false);
  });

  it('rejects uppercase letters and other non [a-z0-9] characters', () => {
    expect(isValidShareId('ABCDEFGHIJ')).toBe(false);
    expect(isValidShareId('abc-def-gh')).toBe(false);
    expect(isValidShareId('')).toBe(false);
  });
});

describe('isValidHash', () => {
  const validHash = 'a'.repeat(64);

  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isValidHash(validHash)).toBe(true);
    expect(isValidHash('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects a hash of the wrong length', () => {
    expect(isValidHash('a'.repeat(63))).toBe(false);
    expect(isValidHash('a'.repeat(65))).toBe(false);
    expect(isValidHash('')).toBe(false);
  });

  it('rejects uppercase or non-hex characters', () => {
    expect(isValidHash('A'.repeat(64))).toBe(false);
    expect(isValidHash('g'.repeat(64))).toBe(false);
  });
});

describe('normalizeBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeBaseUrl('https://example.com/')).toBe('https://example.com');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeBaseUrl('https://example.com///')).toBe('https://example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('leaves a URL with no trailing slash unchanged', () => {
    expect(normalizeBaseUrl('https://example.com')).toBe('https://example.com');
  });
});

describe('validateShareSettings', () => {
  function settings(over: Partial<{ siteUrl: string; apiUrl: string }> = {}) {
    return {
      siteUrl: 'https://acabox-share.acct.workers.dev',
      apiUrl: 'https://acabox-share-api.acct.workers.dev',
      ...over,
    };
  }

  it('accepts a valid pair of https URLs', () => {
    expect(validateShareSettings(settings())).toEqual({ ok: true });
  });

  it('accepts http:// on 127.0.0.1 (local wrangler dev)', () => {
    const result = validateShareSettings(settings({ apiUrl: 'http://127.0.0.1:8787' }));
    expect(result).toEqual({ ok: true });
  });

  it('accepts http:// on localhost', () => {
    const result = validateShareSettings(settings({ siteUrl: 'http://localhost:8788' }));
    expect(result).toEqual({ ok: true });
  });

  it('rejects an empty siteUrl', () => {
    const result = validateShareSettings(settings({ siteUrl: '' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Site URL/);
  });

  it('rejects an empty apiUrl', () => {
    const result = validateShareSettings(settings({ apiUrl: '   ' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/API URL/);
  });

  it('rejects a string that does not parse as a URL', () => {
    const result = validateShareSettings(settings({ siteUrl: 'not a url' }));
    expect(result.ok).toBe(false);
  });

  it('rejects http:// on a non-loopback host', () => {
    const result = validateShareSettings(settings({ apiUrl: 'http://example.com' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/https:\/\//);
  });

  it('rejects userinfo in the URL', () => {
    const result = validateShareSettings(settings({ siteUrl: 'https://user:pass@example.com' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a query string', () => {
    const result = validateShareSettings(settings({ apiUrl: 'https://example.com/?debug=1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a fragment', () => {
    const result = validateShareSettings(settings({ apiUrl: 'https://example.com/#top' }));
    expect(result.ok).toBe(false);
  });
});

describe('kindPrefix / artifactUrl / metaKey / versionPrefix / versionedBase', () => {
  const id = 'abc123xyz0';
  const hash = 'f'.repeat(64);

  it('kindPrefix maps app -> a, file -> f', () => {
    expect(kindPrefix('app')).toBe('a');
    expect(kindPrefix('file')).toBe('f');
  });

  it('artifactUrl builds the app URL and trims a trailing slash on siteUrl', () => {
    expect(artifactUrl('https://site.example.com/', 'app', id))
      .toBe(`https://site.example.com/a/${id}/`);
  });

  it('artifactUrl builds the file URL', () => {
    expect(artifactUrl('https://site.example.com', 'file', id))
      .toBe(`https://site.example.com/f/${id}/`);
  });

  it('metaKey for app and file', () => {
    expect(metaKey('app', id)).toBe(`a/${id}/meta.json`);
    expect(metaKey('file', id)).toBe(`f/${id}/meta.json`);
  });

  it('versionPrefix for app and file', () => {
    expect(versionPrefix('app', id, hash)).toBe(`a/${id}/v/${hash}/`);
    expect(versionPrefix('file', id, hash)).toBe(`f/${id}/v/${hash}/`);
  });

  it('versionedBase for an app ends in /w', () => {
    expect(versionedBase('app', id, hash)).toBe(`/a/${id}/v/${hash}/w`);
  });

  it('versionedBase for a file has no /w suffix', () => {
    expect(versionedBase('file', id, hash)).toBe(`/f/${id}/v/${hash}`);
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['bundle.js', 'application/javascript; charset=utf-8'],
    ['module.mjs', 'application/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['photo.png', 'image/png'],
    ['scan.pdf', 'application/pdf'],
    ['font.woff2', 'font/woff2'],
    ['module.wasm', 'application/wasm'],
    ['notes.md', 'text/markdown; charset=utf-8'],
    ['table.csv', 'text/csv; charset=utf-8'],
    ['bundle.js.map', 'application/json; charset=utf-8'],
  ])('%s -> %s', (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
  });

  it('falls back to application/octet-stream for an unknown extension', () => {
    expect(contentTypeFor('archive.xyz')).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream when there is no extension at all', () => {
    expect(contentTypeFor('README')).toBe('application/octet-stream');
  });

  it('is case-insensitive on the extension', () => {
    expect(contentTypeFor('IMAGE.PNG')).toBe('image/png');
    expect(contentTypeFor('INDEX.HTML')).toBe('text/html; charset=utf-8');
  });
});

describe('normalizeSnapshotPath', () => {
  it('strips a leading ./', () => {
    expect(normalizeSnapshotPath('./a/b.json')).toBe('a/b.json');
  });

  it('strips a leading /', () => {
    expect(normalizeSnapshotPath('/a/b.json')).toBe('a/b.json');
  });

  it('collapses an embedded //', () => {
    expect(normalizeSnapshotPath('a//b.json')).toBe('a/b.json');
  });

  it('resolves an embedded /./ segment', () => {
    expect(normalizeSnapshotPath('a/./b.json')).toBe('a/b.json');
  });

  it('refuses a path containing a .. segment rather than resolving it', () => {
    expect(normalizeSnapshotPath('a/../b.json')).toBeNull();
  });

  it('refuses the exact traversal example from the spec', () => {
    expect(normalizeSnapshotPath('./.applications/x/output/../a.json')).toBeNull();
  });

  it('returns null for an empty path', () => {
    expect(normalizeSnapshotPath('')).toBeNull();
  });

  it('returns null for a path that is only slashes and dots', () => {
    expect(normalizeSnapshotPath('///.//')).toBeNull();
  });
});

describe('summarizeSnapshot', () => {
  const dirName = 'x';
  const files: SnapshotFile[] = [
    { path: 'w/.applications/x/src/index.html', size: 100, sha256: 'a'.repeat(64) },
    { path: 'w/.applications/x/dist/bundle.js', size: 200, sha256: 'b'.repeat(64) },
    { path: 'w/.applications/x/output/result.json', size: 300, sha256: 'c'.repeat(64) },
    { path: 'w/.applications/x/output/nested/other.json', size: 400, sha256: 'd'.repeat(64) },
    { path: 'w/.applications/x/input/raw.csv', size: 500, sha256: 'e'.repeat(64) },
    { path: 'w/.applications/_vendor/acabox.css', size: 600, sha256: 'f'.repeat(64) },
  ];

  it('groups files by prefix and sums bytes/count per group', () => {
    const summary = summarizeSnapshot(files, dirName);
    expect(summary.code).toEqual({ count: 2, bytes: 300 });
    expect(summary.output).toEqual({ count: 2, bytes: 700 });
    expect(summary.input).toEqual({ count: 1, bytes: 500 });
    expect(summary.vendor).toEqual({ count: 1, bytes: 600 });
    expect(summary.total).toEqual({ count: 6, bytes: 2100 });
  });

  it('does not cross-attribute another app dir\'s output/ into this app\'s group', () => {
    const otherAppFiles: SnapshotFile[] = [
      { path: 'w/.applications/other/output/data.json', size: 999, sha256: 'a'.repeat(64) },
      { path: 'w/.applications/x/output/result.json', size: 300, sha256: 'c'.repeat(64) },
    ];
    const summary = summarizeSnapshot(otherAppFiles, dirName);
    expect(summary.output).toEqual({ count: 1, bytes: 300 });
    // The other app's file isn't output/input/vendor for *this* dirName, so it
    // falls through to code — still counted in total, never silently dropped.
    expect(summary.code).toEqual({ count: 1, bytes: 999 });
    expect(summary.total.count).toBe(2);
  });

  it('returns all-zero groups for an empty file list', () => {
    const summary = summarizeSnapshot([], dirName);
    expect(summary.total).toEqual({ count: 0, bytes: 0 });
    expect(summary.code).toEqual({ count: 0, bytes: 0 });
  });
});

describe('constants', () => {
  it('INDEX_KEY is index.json', () => {
    expect(INDEX_KEY).toBe('index.json');
  });

  it('SHARE_REFUSAL_MESSAGE is the fixed, user-facing refusal string', () => {
    expect(SHARE_REFUSAL_MESSAGE).toBe(
      'This is a shared, read-only snapshot. Open the tool in Acabox to run it.'
    );
  });
});
