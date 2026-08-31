/**
 * The `preserveUntouchedSecrets` fix (`docs/design/mcp-hosting.md`,
 * Increment 3 — "Connectors cleanup, same increment"). Two halves, and
 * either alone still loses data: `draftToConnector` (renderer,
 * `ConnectorsSettings.test.tsx`) must always emit `headers` as a real object,
 * and this module must treat `undefined` as "keep stored" and `{}` as
 * "clear" — the bug was that an empty RESULT collapsed to `undefined`
 * regardless of which of those the caller actually meant, so a fully-cleared
 * header list silently came back as the OLD stored headers on the next read.
 *
 * House doctrine (`jobRegistry.test.ts`, lines 1-21): real temp userData dir
 * before any mock; `electron`/`electron-log` are the only mocks, and
 * `safeStorage` is a real, reversible transform rather than a pass-through
 * stub, matching `mcpHostStore.test.ts`'s own setup.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-connectorsstore-'));

const FAKE_CIPHER_PREFIX = 'FAKE-SEALED:';
jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
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

import { upsertConnector, listConnectorsWithSecrets } from '../connectorsStore';
import type { ConnectorConfig } from '../../shared/connectors';

function base(over: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'hex', label: 'Hex', transport: 'http', url: 'https://app.hex.tech/mcp',
    enabled: true,
    ...over,
  };
}

const settingsPath = path.join(tmpDir, 'cobuilding-settings.json');

// Each test starts from a clean store — `upsertConnector` without an
// `originalId` is an ADD, and leftover state from an earlier test would
// silently turn a same-id "add" into a second row that `readStoredConnectors`'
// own dedup then drops, masking exactly the bug this file exists to catch.
beforeEach(() => {
  try { fs.rmSync(settingsPath); } catch { /* not there yet */ }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('preserveUntouchedSecrets — undefined keeps, {} clears', () => {
  it('an edit that omits headers entirely (undefined) keeps the stored ones', () => {
    upsertConnector(base({ headers: { Authorization: 'Bearer secret-1' } }));
    // Re-save with the SAME id, no `headers` field at all — simulating a
    // caller that never touches headers (the pre-fix bug this guards).
    upsertConnector(base({ label: 'Hex (renamed)', headers: undefined }), 'hex');

    const stored = listConnectorsWithSecrets().find((c) => c.id === 'hex');
    expect(stored?.label).toBe('Hex (renamed)');
    expect(stored?.headers).toEqual({ Authorization: 'Bearer secret-1' });
  });

  it('an edit that sends headers: {} really clears them, not "keep stored"', () => {
    upsertConnector(base({ headers: { Authorization: 'Bearer secret-2' } }));
    upsertConnector(base({ headers: {} }), 'hex');

    const stored = listConnectorsWithSecrets().find((c) => c.id === 'hex');
    expect(stored?.headers).toEqual({});
  });

  it('a blank value on an existing key keeps that key\'s stored secret (per-row "leave blank to keep")', () => {
    upsertConnector(base({ headers: { Authorization: 'Bearer secret-3', 'X-Other': 'kept-too' } }));
    // Renderer sends blank strings for untouched rows — masking, not deletion.
    upsertConnector(base({ headers: { Authorization: '', 'X-Other': '' } }), 'hex');

    const stored = listConnectorsWithSecrets().find((c) => c.id === 'hex');
    expect(stored?.headers).toEqual({ Authorization: 'Bearer secret-3', 'X-Other': 'kept-too' });
  });

  it('dropping one row while keeping another deletes only the dropped key', () => {
    upsertConnector(base({ headers: { Authorization: 'Bearer secret-4', 'X-Other': 'kept' } }));
    // Only `X-Other` resubmitted — `Authorization` row was deleted in the UI.
    upsertConnector(base({ headers: { 'X-Other': '' } }), 'hex');

    const stored = listConnectorsWithSecrets().find((c) => c.id === 'hex');
    expect(stored?.headers).toEqual({ 'X-Other': 'kept' });
  });
});

/**
 * Hosted MCP servers and connectors share ONE id namespace (design:
 * `docs/design/mcp-hosting.md`, Increment 4) — both become the middle
 * segment of `mcp__<id>__<tool>`, so a collision would silently shadow one
 * server's tools with the other's in the SDK's merged `mcpServers` record.
 * `upsertConnector`'s `hostedIds` param is how this half of the guard is
 * wired in (`main/index.ts`'s `connectors:save` handler is the real caller,
 * which awaits `mcpHost.list()` for the live id set); the OTHER half — a
 * hosted server rejecting a connector's id — is `mcpHost.save()`'s own job
 * and is covered in `main/mcpHost/__tests__/mcpHostAgentReach.test.ts`,
 * which can drive both a real hosted store AND this connector store side by
 * side. Kept here as a plain unit test since this direction needs nothing
 * beyond a literal array — no reason to drag in a real hosted-server process
 * just to prove `validateConnector` sees the id.
 */
describe('id namespace shared with hosted MCP servers', () => {
  it('rejects a new connector whose id collides with an existing hosted server', () => {
    const result = upsertConnector(base({ id: 'files' }), undefined, ['files', 'memory']);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already exists/);
    expect(listConnectorsWithSecrets().find((c) => c.id === 'files')).toBeUndefined();
  });

  it('a rename that lands on a hosted id is rejected the same way', () => {
    upsertConnector(base({ id: 'hex' }));
    const result = upsertConnector(base({ id: 'files' }), 'hex', ['files']);
    expect(result.success).toBe(false);
    // The original row survives unrenamed — a rejected save must not be a
    // partial write.
    expect(listConnectorsWithSecrets().find((c) => c.id === 'hex')).toBeDefined();
    expect(listConnectorsWithSecrets().find((c) => c.id === 'files')).toBeUndefined();
  });

  it('an empty (or omitted) hostedIds list changes nothing — the parameter is additive, not required', () => {
    const result = upsertConnector(base({ id: 'plain-add' }));
    expect(result.success).toBe(true);
    expect(listConnectorsWithSecrets().find((c) => c.id === 'plain-add')).toBeDefined();
  });
});
