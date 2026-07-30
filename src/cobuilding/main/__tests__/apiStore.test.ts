/**
 * @jest-environment node
 *
 * `main/apiStore.ts` — persistence, masking, and the "blank means keep" rule.
 *
 * The bug class this guards against is specific and has bitten this codebase
 * before in the connector store: a mutation that writes back a list it got from
 * the MASKED accessor silently destroys every credential. Toggling enabled must
 * not cost you your API key.
 *
 * `safeStorage` is faked — jest has no Electron main process, so the real
 * keychain path cannot run here. The fake is deliberately obscuring (base64 of
 * a prefixed string) so "no plaintext on disk" is a real assertion about the
 * envelope, but note what that does NOT prove: that the OS keychain works. That
 * is covered for the same `secretStore` module by the connector work's 11/11
 * run against the real macOS keychain in a real main process.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ApiConfig } from '../../shared/apis';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-apis-'));
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
  getApiCounters,
  listApis,
  listApisWithSecrets,
  migratePlaintextApiSecrets,
  recordApiCall,
  removeApi,
  resetApiCounters,
  setApiAllowWrites,
  setApiEnabled,
  upsertApi,
} from '../apiStore';

function api(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: 'hex',
    label: 'Hex',
    baseUrl: 'https://app.hex.tech/api/v1/',
    allowedHosts: [],
    auth: { style: 'bearer' },
    enabled: true,
    allowWrites: false,
    ...over,
  };
}

/** The raw settings file, as it sits on disk. */
function onDisk(): string {
  return fs.readFileSync(settingsPath, 'utf-8');
}

beforeEach(() => {
  fs.writeFileSync(settingsPath, '{}', 'utf-8');
  resetApiCounters();
});

describe('storing a credential', () => {
  it('encrypts at rest — the raw secret never appears in the file', () => {
    upsertApi(api({ auth: { style: 'bearer', secret: 'SUPERSECRET' } }));

    expect(onDisk()).not.toContain('SUPERSECRET');
    expect(onDisk()).toContain('enc:v1:');
    expect(listApisWithSecrets()[0].auth.secret).toBe('SUPERSECRET');
  });

  it('removes the secret entirely on the IPC-facing accessor', () => {
    upsertApi(api({ auth: { style: 'bearer', secret: 'SUPERSECRET' } }));

    const forUi = listApis()[0];
    expect(JSON.stringify(forUi)).not.toContain('SUPERSECRET');
    expect((forUi.auth as Record<string, unknown>).secret).toBeUndefined();
    expect(forUi.hasSecret).toBe(true);
  });

  it('reports hasSecret false when none is stored', () => {
    upsertApi(api());
    expect(listApis()[0].hasSecret).toBe(false);
  });

  it('lowercases the id on save', () => {
    upsertApi(api({ id: 'HeX' }));
    expect(listApis()[0].id).toBe('hex');
  });

  it('refuses an invalid API and leaves the store untouched', () => {
    upsertApi(api());
    const result = upsertApi(api({ id: 'second', baseUrl: 'http://remote.example.com/' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/https/);
    expect(listApis()).toHaveLength(1);
  });
});

describe('editing without retyping the key', () => {
  it('keeps the stored secret when the field comes back blank', () => {
    upsertApi(api({ auth: { style: 'bearer', secret: 'SUPERSECRET' } }));

    // Exactly what the UI posts: the masked row, edited, with no secret.
    const edited = listApis()[0];
    upsertApi(
      { ...edited, auth: { ...edited.auth }, baseUrl: 'https://eu.hex.tech/api/v1/' } as ApiConfig,
      'hex',
    );

    expect(listApisWithSecrets()[0].auth.secret).toBe('SUPERSECRET');
    expect(listApisWithSecrets()[0].baseUrl).toBe('https://eu.hex.tech/api/v1/');
  });

  it('replaces the secret when a new one is typed', () => {
    upsertApi(api({ auth: { style: 'bearer', secret: 'OLD' } }));
    upsertApi(api({ auth: { style: 'bearer', secret: 'NEW' } }), 'hex');
    expect(listApisWithSecrets()[0].auth.secret).toBe('NEW');
    expect(onDisk()).not.toContain('OLD');
  });

  it('removes the secret only when clearSecret is explicit', () => {
    upsertApi(api({ auth: { style: 'bearer', secret: 'SUPERSECRET' } }));
    upsertApi(api(), 'hex', true);
    expect(listApis()[0].hasSecret).toBe(false);
    expect(onDisk()).not.toContain('SUPERSECRET');
  });

  it('keeps the row in place rather than reordering on edit', () => {
    upsertApi(api({ id: 'one' }));
    upsertApi(api({ id: 'two' }));
    upsertApi(api({ id: 'one', label: 'One renamed' }), 'one');
    expect(listApis().map((a) => a.id)).toEqual(['one', 'two']);
  });
});

describe('toggles must not destroy credentials', () => {
  // The connector store had exactly this bug shape: persisting a list obtained
  // from the masked accessor blanks every secret on the next toggle.
  it('setEnabled preserves the stored secret', () => {
    upsertApi(api({ auth: { style: 'bearer', secret: 'SUPERSECRET' } }));
    setApiEnabled('hex', false);
    setApiEnabled('hex', true);
    expect(listApisWithSecrets()[0].auth.secret).toBe('SUPERSECRET');
  });

  it('setAllowWrites preserves the stored secret', () => {
    upsertApi(api({ auth: { style: 'bearer', secret: 'SUPERSECRET' } }));
    setApiAllowWrites('hex', true);
    expect(listApis()[0].allowWrites).toBe(true);
    expect(listApisWithSecrets()[0].auth.secret).toBe('SUPERSECRET');
  });

  it('reports a mutation against an unknown id rather than silently adding one', () => {
    expect(setApiEnabled('nope', true).success).toBe(false);
    expect(setApiAllowWrites('nope', true).success).toBe(false);
    expect(listApis()).toHaveLength(0);
  });
});

describe('reading rows written by another build', () => {
  function writeRaw(apis: unknown[]): void {
    fs.writeFileSync(settingsPath, JSON.stringify({ apis }), 'utf-8');
  }

  it('defaults allowWrites to FALSE when the field is absent', () => {
    // A row predating the write gate must not arrive with writes open.
    writeRaw([{ id: 'x', baseUrl: 'https://a.example.com/' }]);
    expect(listApis()[0].allowWrites).toBe(false);
  });

  it('defaults enabled to true when absent', () => {
    writeRaw([{ id: 'x', baseUrl: 'https://a.example.com/' }]);
    expect(listApis()[0].enabled).toBe(true);
  });

  it('drops unusable rows instead of throwing', () => {
    writeRaw([null, 'nonsense', { label: 'no id' }, { id: 'ok', baseUrl: 'https://a.example.com/' }]);
    expect(listApis().map((a) => a.id)).toEqual(['ok']);
  });

  it('drops a duplicate id, which would make proxy routing ambiguous', () => {
    writeRaw([
      { id: 'x', baseUrl: 'https://first.example.com/' },
      { id: 'x', baseUrl: 'https://second.example.com/' },
    ]);
    expect(listApis()).toHaveLength(1);
    expect(listApis()[0].baseUrl).toBe('https://first.example.com/');
  });

  it('encrypts a legacy plaintext secret once, at boot', () => {
    writeRaw([{
      id: 'x',
      baseUrl: 'https://a.example.com/',
      auth: { style: 'bearer', secret: 'PLAINTEXT' },
    }]);
    expect(onDisk()).toContain('PLAINTEXT');

    migratePlaintextApiSecrets();

    expect(onDisk()).not.toContain('"PLAINTEXT"');
    expect(onDisk()).toContain('enc:v1:');
    expect(listApisWithSecrets()[0].auth.secret).toBe('PLAINTEXT');

    // Idempotent: a second run must not double-wrap.
    const after = onDisk();
    migratePlaintextApiSecrets();
    expect(onDisk()).toBe(after);
  });
});

describe('counters', () => {
  it('has no entry at all for an API that was never called', () => {
    upsertApi(api());
    expect(getApiCounters().hex).toBeUndefined();
  });

  it('counts calls and refusals separately', () => {
    recordApiCall('hex', { refused: false, status: 200 });
    recordApiCall('hex', { refused: true, status: 405 });
    expect(getApiCounters().hex).toMatchObject({ calls: 2, refused: 1, lastStatus: 405 });
  });

  it('forgets an API\'s counters when it is removed', () => {
    upsertApi(api());
    recordApiCall('hex', { refused: false, status: 200 });
    removeApi('hex');
    expect(getApiCounters().hex).toBeUndefined();
    expect(listApis()).toHaveLength(0);
  });
});
