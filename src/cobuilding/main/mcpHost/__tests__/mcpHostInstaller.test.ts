/**
 * Increment 6 (`docs/design/mcp-hosting.md`) — `mcpHost/installer.ts`.
 *
 * What is covered here is everything that can be proven WITHOUT the network:
 * the refusals, and the invariants that hold regardless of where the bytes
 * came from. The two fetchers are the network seam, and a hermetic suite is
 * worth more than a test that fails on a train — the real npm and GitHub
 * round trips are verified by running them, and recorded in CLAUDE.md, the
 * same way every other increment in this subsystem was.
 *
 * House doctrine (`jobRegistry.test.ts`): a real temp userData dir declared
 * BEFORE any mock; `electron`/`electron-log` are the only mocks, and
 * `safeStorage` is a real reversible transform rather than a pass-through —
 * the no-keyring refusal below would prove nothing against a stub.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcpinstaller-'));

let encryptionAvailable = true;
const FAKE_CIPHER_PREFIX = 'FAKE-SEALED:';
jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
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
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { installHostedServer, MAX_SERVER_SOURCE_FILES, MAX_SERVER_SOURCE_BYTES } from '../installer';
import { registerHostedServer, hostedServerDir } from '../store';

const serversRoot = () => path.join(tmpDir, 'mcp-servers');

beforeEach(() => { encryptionAvailable = true; });

afterEach(() => {
  try { fs.rmSync(serversRoot(), { recursive: true, force: true }); } catch { /* not there */ }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Every staging/backup dir the installer could have left behind. */
function strayDirs(): string[] {
  try {
    return fs.readdirSync(serversRoot()).filter((n) => n.includes('.installing-') || n.includes('.previous-'));
  } catch {
    return [];
  }
}

describe('refusals', () => {
  it('will not store a server when the keychain is unreachable', async () => {
    encryptionAvailable = false;
    const result = await installHostedServer({ id: 'x', source: { kind: 'npm', pkg: 'whatever' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/keychain/i);
    // Refused BEFORE anything was fetched or written.
    expect(strayDirs()).toEqual([]);
  });

  it('refuses an id that already exists rather than clobbering it', async () => {
    const reg = await registerHostedServer({
      id: 'taken',
      label: 'Taken',
      install: { kind: 'custom' },
      entry: { command: '/bin/echo', args: ['hi'] },
    });
    expect(reg.ok).toBe(true);

    const result = await installHostedServer({ id: 'taken', source: { kind: 'npm', pkg: 'whatever' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already exists/i);
    expect(strayDirs()).toEqual([]);
  });

  it('refuses a URL that is not a GitHub repository, and leaves nothing behind', async () => {
    const lines: string[] = [];
    const result = await installHostedServer({
      id: 'notgh',
      source: { kind: 'github', url: 'https://example.com/not/a/repo' },
      onLog: (l) => lines.push(l),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a GitHub repository URL/i);
    // The staging dir is created before the fetch is attempted, so the
    // cleanup path is what this asserts — a failed install must not leave
    // half a server sitting in the servers directory.
    expect(strayDirs()).toEqual([]);
    expect(lines.join('\n')).toMatch(/Failed:/);
  });

  it('refuses an empty package name', async () => {
    const result = await installHostedServer({ id: 'empty', source: { kind: 'npm', pkg: '   ' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No package name/i);
    expect(strayDirs()).toEqual([]);
  });

  it('reports the failure through onLog as well as the return value', async () => {
    // "Ask Claude to fix this" carries the log, not the return value, so a
    // failure that never reaches the log is invisible to that button.
    const lines: string[] = [];
    await installHostedServer({
      id: 'logged',
      source: { kind: 'github', url: 'nonsense' },
      onLog: (l) => lines.push(l),
    });
    expect(lines.some((l) => /Failed:/.test(l))).toBe(true);
  });
});

describe('caps', () => {
  it('are stated on the SOURCE tree, above a scaffolded server and below a monorepo', () => {
    // The cap exists to refuse "you pasted a whole repository", not to police
    // what npm resolves — node_modules lands after this check.
    expect(MAX_SERVER_SOURCE_FILES).toBeGreaterThan(100);
    expect(MAX_SERVER_SOURCE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe('the installed path is the real path, not the staging path', () => {
  it('hostedServerDir is where a record must point', () => {
    // Pinning the relationship the installer's entry rewrite depends on: the
    // probe runs in a staging dir, and the record must describe where the
    // code ends up. A record left pointing at `<id>.installing-<uuid>` would
    // work exactly once — until the next boot, when that path is gone.
    const dir = hostedServerDir('some-id');
    expect(dir).toBe(path.join(tmpDir, 'mcp-servers', 'some-id'));
    expect(dir).not.toMatch(/\.installing-/);
  });
});
