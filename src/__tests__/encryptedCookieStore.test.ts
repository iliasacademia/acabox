/* eslint-disable */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cookie } from 'tough-cookie';

let mockGetPath: jest.Mock;
let mockIsPackaged: boolean;

jest.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
    getPath: (...args: any[]) => mockGetPath(...args),
  },
}));

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../utils/logger', () => ({
  defaultLogger: mockLogger,
}));

import { EncryptedCookieStore } from '../encryptedCookieStore';

// Helper to create test cookies
function makeCookie(overrides: { key: string; domain: string; value?: string; path?: string }): Cookie {
  return new Cookie({
    value: 'abc123',
    path: '/',
    ...overrides,
  });
}

describe('EncryptedCookieStore', () => {
  let tmpDir: string;
  let cookiePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-test-'));
    cookiePath = path.join(tmpDir, 'cookies.enc');
    mockIsPackaged = false;
    mockGetPath = jest.fn().mockReturnValue(tmpDir);
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Constructor & key derivation ──────────────────────────────

  describe('Constructor & key derivation', () => {
    it('creates .machine-id file on first instantiation', () => {
      new EncryptedCookieStore(cookiePath);
      const machineIdPath = path.join(tmpDir, '.machine-id');
      expect(fs.existsSync(machineIdPath)).toBe(true);
      const contents = fs.readFileSync(machineIdPath, 'utf8');
      expect(contents).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('reuses existing .machine-id on subsequent instantiation', () => {
      new EncryptedCookieStore(cookiePath);
      const id1 = fs.readFileSync(path.join(tmpDir, '.machine-id'), 'utf8');

      new EncryptedCookieStore(cookiePath);
      const id2 = fs.readFileSync(path.join(tmpDir, '.machine-id'), 'utf8');

      expect(id1).toBe(id2);
    });

    it('same machine ID produces same key (cookies persist across instances)', async () => {
      const store1 = new EncryptedCookieStore(cookiePath);
      await store1.putCookie(makeCookie({ key: 'token', domain: 'example.com', value: 'secret' }));

      const store2 = new EncryptedCookieStore(cookiePath);
      const cookie = await store2.findCookie('example.com', '/', 'token');
      expect(cookie).toBeDefined();
      expect(cookie!.value).toBe('secret');
    });

    it('dev vs production derive different keys (app.isPackaged toggle)', async () => {
      mockIsPackaged = false;
      const devStore = new EncryptedCookieStore(cookiePath);
      await devStore.putCookie(makeCookie({ key: 'k', domain: 'd.com', value: 'v' }));

      // Switch to production — same machine-id but different salt
      mockIsPackaged = true;
      const prodStore = new EncryptedCookieStore(cookiePath);
      const cookie = await prodStore.findCookie('d.com', '/', 'k');

      // Should fail to decrypt dev cookies with production key
      expect(cookie).toBeUndefined();
    });

    it('falls back to random UUID if machine-id file creation fails', () => {
      // Point getPath to an unwritable location
      mockGetPath.mockReturnValue('/nonexistent/readonly/path');

      // Should not throw
      const store = new EncryptedCookieStore(cookiePath);
      expect(store).toBeDefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('machine ID'),
        expect.anything()
      );
    });

    it('store still works in-memory when key derivation uses random fallback', async () => {
      mockGetPath.mockReturnValue('/nonexistent/readonly/path');
      const store = new EncryptedCookieStore(cookiePath);

      await store.putCookie(makeCookie({ key: 'mem', domain: 'a.com', value: 'val' }));
      const cookie = await store.findCookie('a.com', '/', 'mem');
      expect(cookie).toBeDefined();
      expect(cookie!.value).toBe('val');
    });
  });

  // ─── Encryption & decryption ───────────────────────────────────

  describe('Encryption & decryption', () => {
    it('cookie data survives encrypt/decrypt round-trip', async () => {
      const store1 = new EncryptedCookieStore(cookiePath);
      const original = makeCookie({
        key: 'session',
        domain: 'example.com',
        value: 'round-trip-value',
        path: '/app',
      });
      await store1.putCookie(original);

      // New instance loads from disk
      const store2 = new EncryptedCookieStore(cookiePath);
      const loaded = await store2.findCookie('example.com', '/app', 'session');

      expect(loaded).toBeDefined();
      expect(loaded!.key).toBe('session');
      expect(loaded!.value).toBe('round-trip-value');
      expect(loaded!.domain).toBe('example.com');
      expect(loaded!.path).toBe('/app');
    });

    it('encrypted file on disk is not plaintext-readable', async () => {
      const store = new EncryptedCookieStore(cookiePath);
      await store.putCookie(makeCookie({ key: 'secret', domain: 'x.com', value: 'supersecret' }));

      const raw = fs.readFileSync(cookiePath);
      const asString = raw.toString('utf8');
      expect(asString).not.toContain('supersecret');
      expect(asString).not.toContain('x.com');
    });

    it('decryption with wrong key (changed machine-id) gives empty store, no crash', async () => {
      const store1 = new EncryptedCookieStore(cookiePath);
      await store1.putCookie(makeCookie({ key: 'k', domain: 'd.com', value: 'v' }));

      // Overwrite the machine-id to force a different key
      fs.writeFileSync(path.join(tmpDir, '.machine-id'), 'different-machine-id');

      const store2 = new EncryptedCookieStore(cookiePath);
      const all = await store2.getAllCookies();
      expect(all).toEqual([]);
    });

    it('each write uses a different IV (ciphertext differs for same data)', async () => {
      const store1 = new EncryptedCookieStore(cookiePath);
      await store1.putCookie(makeCookie({ key: 'k', domain: 'd.com', value: 'same' }));
      const bytes1 = fs.readFileSync(cookiePath);

      // Re-save same data
      await store1.putCookie(makeCookie({ key: 'k', domain: 'd.com', value: 'same' }));
      const bytes2 = fs.readFileSync(cookiePath);

      // Ciphertexts should differ because of random IV
      expect(bytes1.equals(bytes2)).toBe(false);
    });
  });

  // ─── Cookie CRUD ───────────────────────────────────────────────

  describe('Cookie CRUD', () => {
    let store: EncryptedCookieStore;

    beforeEach(() => {
      store = new EncryptedCookieStore(cookiePath);
    });

    it('putCookie stores and persists to disk', async () => {
      await store.putCookie(makeCookie({ key: 'a', domain: 'x.com', value: '1' }));
      expect(fs.existsSync(cookiePath)).toBe(true);

      const store2 = new EncryptedCookieStore(cookiePath);
      const cookie = await store2.findCookie('x.com', '/', 'a');
      expect(cookie!.value).toBe('1');
    });

    it('findCookie retrieves stored cookie', async () => {
      await store.putCookie(makeCookie({ key: 'found', domain: 'f.com', value: 'yes' }));
      const cookie = await store.findCookie('f.com', '/', 'found');
      expect(cookie).toBeDefined();
      expect(cookie!.value).toBe('yes');
    });

    it('findCookie returns undefined for non-existent cookie', async () => {
      const cookie = await store.findCookie('no.com', '/', 'nope');
      expect(cookie).toBeUndefined();
    });

    it('findCookie returns undefined for null args', async () => {
      expect(await store.findCookie(null, '/', 'k')).toBeUndefined();
      expect(await store.findCookie('d', null, 'k')).toBeUndefined();
      expect(await store.findCookie('d', '/', null)).toBeUndefined();
    });

    it('findCookies domain matching (exact and subdomain)', (done) => {
      const setup = async () => {
        await store.putCookie(makeCookie({ key: 'a', domain: 'example.com', value: '1' }));
        await store.putCookie(makeCookie({ key: 'b', domain: 'sub.example.com', value: '2' }));
        await store.putCookie(makeCookie({ key: 'c', domain: 'other.com', value: '3' }));
      };
      setup().then(() => {
        store.findCookies('example.com', '/', false, (err, cookies) => {
          expect(err).toBeNull();
          const keys = cookies.map((c: Cookie) => c.key).sort();
          expect(keys).toEqual(['a', 'b']);
          done();
        });
      });
    });

    it('findCookies path prefix matching', (done) => {
      const setup = async () => {
        await store.putCookie(makeCookie({ key: 'root', domain: 'x.com', path: '/' }));
        await store.putCookie(makeCookie({ key: 'app', domain: 'x.com', path: '/app' }));
        await store.putCookie(makeCookie({ key: 'api', domain: 'x.com', path: '/api' }));
      };
      setup().then(() => {
        store.findCookies('x.com', '/app/page', false, (err, cookies) => {
          expect(err).toBeNull();
          const keys = cookies.map((c: Cookie) => c.key).sort();
          // /app/page starts with '/' and '/app'
          expect(keys).toEqual(['app', 'root']);
          done();
        });
      });
    });

    it('findCookies returns [] for null domain', (done) => {
      store.putCookie(makeCookie({ key: 'a', domain: 'x.com' }), () => {
        store.findCookies(null, '/', false, (err, cookies) => {
          expect(err).toBeNull();
          expect(cookies).toEqual([]);
          done();
        });
      });
    });

    it('removeCookie removes specific cookie and cleans up empty objects', async () => {
      await store.putCookie(makeCookie({ key: 'only', domain: 'rm.com', value: 'v' }));
      await store.removeCookie('rm.com', '/', 'only');

      const cookie = await store.findCookie('rm.com', '/', 'only');
      expect(cookie).toBeUndefined();

      const all = await store.getAllCookies();
      expect(all).toEqual([]);
    });

    it('removeCookie no-op for non-existent cookie', async () => {
      // Should not throw
      await store.removeCookie('no.com', '/', 'nope');
    });

    it('removeCookie no-op for null args', async () => {
      await store.putCookie(makeCookie({ key: 'a', domain: 'x.com' }));
      await store.removeCookie(null, '/', 'a');
      await store.removeCookie('x.com', null, 'a');
      await store.removeCookie('x.com', '/', null);

      // Cookie should still be there
      const cookie = await store.findCookie('x.com', '/', 'a');
      expect(cookie).toBeDefined();
    });

    it('removeCookies removes all cookies for domain/path', async () => {
      await store.putCookie(makeCookie({ key: 'a', domain: 'd.com', path: '/p' }));
      await store.putCookie(makeCookie({ key: 'b', domain: 'd.com', path: '/p' }));
      await store.putCookie(makeCookie({ key: 'c', domain: 'd.com', path: '/other' }));

      await store.removeCookies('d.com', '/p');

      expect(await store.findCookie('d.com', '/p', 'a')).toBeUndefined();
      expect(await store.findCookie('d.com', '/p', 'b')).toBeUndefined();
      // Other path unaffected
      expect(await store.findCookie('d.com', '/other', 'c')).toBeDefined();
    });

    it('removeCookies no-op when path is null', async () => {
      await store.putCookie(makeCookie({ key: 'a', domain: 'd.com' }));
      await store.removeCookies('d.com', null);

      const cookie = await store.findCookie('d.com', '/', 'a');
      expect(cookie).toBeDefined();
    });

    it('removeAllCookies clears everything', async () => {
      await store.putCookie(makeCookie({ key: 'a', domain: 'a.com' }));
      await store.putCookie(makeCookie({ key: 'b', domain: 'b.com' }));

      await store.removeAllCookies();
      const all = await store.getAllCookies();
      expect(all).toEqual([]);
    });

    it('getAllCookies returns all stored cookies', async () => {
      await store.putCookie(makeCookie({ key: 'x', domain: 'a.com', value: '1' }));
      await store.putCookie(makeCookie({ key: 'y', domain: 'b.com', value: '2' }));

      const all = await store.getAllCookies();
      expect(all).toHaveLength(2);
      const keys = all.map((c: Cookie) => c.key).sort();
      expect(keys).toEqual(['x', 'y']);
    });

    it('updateCookie replaces cookie', async () => {
      const old = makeCookie({ key: 'tok', domain: 'u.com', value: 'old' });
      await store.putCookie(old);

      const updated = makeCookie({ key: 'tok', domain: 'u.com', value: 'new' });
      await store.updateCookie(old, updated);

      const cookie = await store.findCookie('u.com', '/', 'tok');
      expect(cookie!.value).toBe('new');
    });
  });

  // ─── File persistence ──────────────────────────────────────────

  describe('File persistence', () => {
    it('cookies survive across store instances', async () => {
      const store1 = new EncryptedCookieStore(cookiePath);
      await store1.putCookie(makeCookie({ key: 'persist', domain: 'p.com', value: 'yes' }));

      const store2 = new EncryptedCookieStore(cookiePath);
      const cookie = await store2.findCookie('p.com', '/', 'persist');
      expect(cookie!.value).toBe('yes');
    });

    it('corrupted file leads to empty store', () => {
      fs.writeFileSync(cookiePath, 'this is not valid encrypted data and is long enough to pass size check!!!');
      const store = new EncryptedCookieStore(cookiePath);

      return store.getAllCookies().then((all: Cookie[]) => {
        expect(all).toEqual([]);
      });
    });

    it('missing file leads to empty store', async () => {
      // Don't create any file
      const store = new EncryptedCookieStore(cookiePath);
      const all = await store.getAllCookies();
      expect(all).toEqual([]);
    });

    it('file too small (< 28 bytes) leads to empty store', () => {
      fs.writeFileSync(cookiePath, Buffer.alloc(10));
      const store = new EncryptedCookieStore(cookiePath);

      return store.getAllCookies().then((all: Cookie[]) => {
        expect(all).toEqual([]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('too small')
        );
      });
    });
  });

  // ─── Error handling ────────────────────────────────────────────

  describe('Error handling', () => {
    it('machine-id creation failure logs error and still constructs', () => {
      mockGetPath.mockReturnValue('/nonexistent/readonly/path');

      const store = new EncryptedCookieStore(cookiePath);
      expect(store).toBeDefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('machine ID'),
        expect.anything()
      );
    });

    it('decryption failure warns and starts with empty store, no crash', async () => {
      // Write valid-length but garbage encrypted data
      fs.writeFileSync(cookiePath, Buffer.alloc(64, 0xff));

      const store = new EncryptedCookieStore(cookiePath);
      const all = await store.getAllCookies();
      expect(all).toEqual([]);
    });

    it('save failure (read-only path) logs error and does not crash', async () => {
      // Create a read-only directory for the cookie file
      const roDir = path.join(tmpDir, 'readonly');
      fs.mkdirSync(roDir);
      const roCookiePath = path.join(roDir, 'sub', 'cookies.enc');

      const store = new EncryptedCookieStore(cookiePath);
      await store.putCookie(makeCookie({ key: 'a', domain: 'a.com' }));

      // Make the directory read-only so saves fail
      fs.chmodSync(roDir, 0o444);

      // Use a new store pointing to the read-only location
      // Since the cookie file path is set in constructor, we need to
      // trigger a save that fails. We'll create a store with read-only path.
      const store2 = new EncryptedCookieStore(roCookiePath);
      // putCookie triggers saveToFile which should fail silently
      await store2.putCookie(makeCookie({ key: 'fail', domain: 'fail.com' }));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('saving cookies'),
        expect.anything()
      );

      // Restore permissions for cleanup
      fs.chmodSync(roDir, 0o755);
    });
  });

  // ─── Callback & promise API ────────────────────────────────────

  describe('Callback & promise API', () => {
    let store: EncryptedCookieStore;

    beforeEach(() => {
      store = new EncryptedCookieStore(cookiePath);
    });

    it('findCookie works with callback', (done) => {
      store.putCookie(makeCookie({ key: 'cb', domain: 'cb.com', value: 'val' }), (err) => {
        expect(err).toBeNull();
        store.findCookie('cb.com', '/', 'cb', (err2, cookie) => {
          expect(err2).toBeNull();
          expect(cookie).toBeDefined();
          expect(cookie!.value).toBe('val');
          done();
        });
      });
    });

    it('findCookie works with promise', async () => {
      await store.putCookie(makeCookie({ key: 'pr', domain: 'pr.com', value: 'val' }));
      const cookie = await store.findCookie('pr.com', '/', 'pr');
      expect(cookie).toBeDefined();
      expect(cookie!.value).toBe('val');
    });

    it('putCookie works with callback', (done) => {
      store.putCookie(makeCookie({ key: 'put', domain: 'put.com' }), (err) => {
        expect(err).toBeNull();
        done();
      });
    });

    it('putCookie works with promise', async () => {
      await expect(
        store.putCookie(makeCookie({ key: 'put', domain: 'put.com' }))
      ).resolves.toBeUndefined();
    });

    it('removeCookie works with callback', (done) => {
      store.putCookie(makeCookie({ key: 'rm', domain: 'rm.com' }), (err) => {
        expect(err).toBeNull();
        store.removeCookie('rm.com', '/', 'rm', (err2) => {
          expect(err2).toBeNull();
          done();
        });
      });
    });

    it('removeCookie works with promise', async () => {
      await store.putCookie(makeCookie({ key: 'rm', domain: 'rm.com' }));
      await expect(store.removeCookie('rm.com', '/', 'rm')).resolves.toBeUndefined();
    });
  });
});
