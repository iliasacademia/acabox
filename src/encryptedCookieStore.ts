import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { Cookie, Store } from 'tough-cookie';

/**
 * Encrypted cookie store that uses Electron's safeStorage API
 * to encrypt cookies at rest, preventing credential theft if the system is compromised.
 *
 * Implements the tough-cookie Store interface for seamless integration.
 */
export class EncryptedCookieStore extends Store {
  private filePath: string;
  private idx: { [domain: string]: { [path: string]: { [key: string]: Cookie } } } = {};

  constructor(filePath: string) {
    super();
    this.synchronous = true;
    this.filePath = filePath;
    this.loadFromFile();
  }

  /**
   * Load and decrypt cookies from disk
   */
  private loadFromFile(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const encryptedData = fs.readFileSync(this.filePath);

      // Check if safeStorage is available (may not be in some environments)
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[EncryptedCookieStore] Encryption not available, falling back to plaintext');
        const plaintextData = encryptedData.toString('utf8');
        const parsed = JSON.parse(plaintextData);
        // Convert plain objects back to Cookie instances
        this.idx = this.deserializeCookies(parsed);
        return;
      }

      const decryptedData = safeStorage.decryptString(encryptedData);
      const parsed = JSON.parse(decryptedData);
      this.idx = this.deserializeCookies(parsed);
    } catch (error) {
      console.error('[EncryptedCookieStore] Error loading cookies:', error);
      // Start with empty store if we can't load
      this.idx = {};
    }
  }

  /**
   * Convert plain objects to Cookie instances
   */
  private deserializeCookies(data: any): { [domain: string]: { [path: string]: { [key: string]: Cookie } } } {
    const result: { [domain: string]: { [path: string]: { [key: string]: Cookie } } } = {};

    for (const domain in data) {
      result[domain] = {};
      for (const path in data[domain]) {
        result[domain][path] = {};
        for (const key in data[domain][path]) {
          try {
            const cookie = Cookie.fromJSON(data[domain][path][key]);
            if (cookie) {
              result[domain][path][key] = cookie;
            }
          } catch (e) {
            console.error('[EncryptedCookieStore] Failed to deserialize cookie:', e);
          }
        }
      }
    }

    return result;
  }

  /**
   * Encrypt and save cookies to disk
   */
  private saveToFile(): void {
    try {
      const jsonData = JSON.stringify(this.idx, null, 2);

      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Encrypt if available
      if (safeStorage.isEncryptionAvailable()) {
        const encryptedData = safeStorage.encryptString(jsonData);
        fs.writeFileSync(this.filePath, encryptedData);
      } else {
        console.warn('[EncryptedCookieStore] Encryption not available, saving plaintext');
        fs.writeFileSync(this.filePath, jsonData, 'utf8');
      }
    } catch (error) {
      console.error('[EncryptedCookieStore] Error saving cookies:', error);
    }
  }

  findCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback: (err: Error | null, cookie: Cookie | undefined) => void
  ): void;
  findCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined
  ): Promise<Cookie | undefined>;
  findCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback?: (err: Error | null, cookie: Cookie | undefined) => void
  ): Promise<Cookie | undefined> | void {
    const doFind = () => {
      if (!domain || !path || !key) {
        return undefined;
      }
      return this.idx[domain]?.[path]?.[key];
    };

    if (callback) {
      try {
        const cookie = doFind();
        callback(null, cookie);
      } catch (error) {
        callback(error as Error, undefined);
      }
      return;
    }

    return Promise.resolve(doFind());
  }

  findCookies(
    domain: string | null | undefined,
    path: string | null | undefined,
    allowSpecialUseDomain?: boolean,
    callback?: (err: Error | null, cookies: Cookie[]) => void
  ): void;
  findCookies(
    domain: string | null | undefined,
    path: string | null | undefined,
    allowSpecialUseDomain?: boolean
  ): Promise<Cookie[]>;
  findCookies(
    domain: string | null | undefined,
    path: string | null | undefined,
    allowSpecialUseDomain?: boolean,
    callback?: (err: Error | null, cookies: Cookie[]) => void
  ): Promise<Cookie[]> | void {
    const doFind = (): Cookie[] => {
      const results: Cookie[] = [];

      if (!domain) {
        return [];
      }

      const domainKeys = Object.keys(this.idx);
      for (const domainKey of domainKeys) {
        if (domainKey === domain || domainKey.endsWith('.' + domain) || domain.endsWith('.' + domainKey)) {
          const paths = this.idx[domainKey];

          const pathKeys = Object.keys(paths);
          for (const pathKey of pathKeys) {
            if (!path || pathKey === path || path.startsWith(pathKey)) {
              const cookies = paths[pathKey];
              results.push(...Object.values(cookies));
            }
          }
        }
      }

      return results;
    };

    if (callback) {
      try {
        const cookies = doFind();
        callback(null, cookies);
      } catch (error) {
        callback(error as Error, []);
      }
      return;
    }

    return Promise.resolve(doFind());
  }

  putCookie(cookie: Cookie, callback: (err: Error | null) => void): void;
  putCookie(cookie: Cookie): Promise<void>;
  putCookie(cookie: Cookie, callback?: (err: Error | null) => void): Promise<void> | void {
    const doPut = () => {
      const domain = cookie.domain;
      const path = cookie.path;
      const key = cookie.key;

      if (!domain || !path || !key) {
        throw new Error('Cookie must have domain, path, and key');
      }

      if (!this.idx[domain]) {
        this.idx[domain] = {};
      }
      if (!this.idx[domain][path]) {
        this.idx[domain][path] = {};
      }

      this.idx[domain][path][key] = cookie;
      this.saveToFile();
    };

    if (callback) {
      try {
        doPut();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doPut);
  }

  updateCookie(oldCookie: Cookie, newCookie: Cookie, callback: (err: Error | null) => void): void;
  updateCookie(oldCookie: Cookie, newCookie: Cookie): Promise<void>;
  updateCookie(oldCookie: Cookie, newCookie: Cookie, callback?: (err: Error | null) => void): Promise<void> | void {
    if (callback) {
      this.putCookie(newCookie, callback);
      return;
    }
    return this.putCookie(newCookie);
  }

  removeCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback: (err: Error | null) => void
  ): void;
  removeCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined
  ): Promise<void>;
  removeCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback?: (err: Error | null) => void
  ): Promise<void> | void {
    const doRemove = () => {
      if (!domain || !path || !key) {
        return;
      }

      if (this.idx[domain]?.[path]?.[key]) {
        delete this.idx[domain][path][key];

        if (Object.keys(this.idx[domain][path]).length === 0) {
          delete this.idx[domain][path];
        }
        if (Object.keys(this.idx[domain]).length === 0) {
          delete this.idx[domain];
        }

        this.saveToFile();
      }
    };

    if (callback) {
      try {
        doRemove();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doRemove);
  }

  removeCookies(domain: string, path: string | null | undefined, callback: (err: Error | null) => void): void;
  removeCookies(domain: string, path: string | null | undefined): Promise<void>;
  removeCookies(domain: string, path: string | null | undefined, callback?: (err: Error | null) => void): Promise<void> | void {
    const doRemove = () => {
      if (!path) {
        return;
      }

      if (this.idx[domain]?.[path]) {
        delete this.idx[domain][path];

        if (Object.keys(this.idx[domain]).length === 0) {
          delete this.idx[domain];
        }

        this.saveToFile();
      }
    };

    if (callback) {
      try {
        doRemove();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doRemove);
  }

  removeAllCookies(callback: (err: Error | null) => void): void;
  removeAllCookies(): Promise<void>;
  removeAllCookies(callback?: (err: Error | null) => void): Promise<void> | void {
    const doRemove = () => {
      this.idx = {};
      this.saveToFile();
    };

    if (callback) {
      try {
        doRemove();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doRemove);
  }

  getAllCookies(callback: (err: Error | null, cookies: Cookie[]) => void): void;
  getAllCookies(): Promise<Cookie[]>;
  getAllCookies(callback?: (err: Error | null, cookies: Cookie[]) => void): Promise<Cookie[]> | void {
    const doGetAll = (): Cookie[] => {
      const results: Cookie[] = [];

      for (const domain of Object.keys(this.idx)) {
        for (const path of Object.keys(this.idx[domain])) {
          results.push(...Object.values(this.idx[domain][path]));
        }
      }

      return results;
    };

    if (callback) {
      try {
        const cookies = doGetAll();
        callback(null, cookies);
      } catch (error) {
        callback(error as Error, []);
      }
      return;
    }

    return Promise.resolve(doGetAll());
  }
}
