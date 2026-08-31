/**
 * `handleMcpRelay`'s hosted-MCP fallthrough (`docs/design/mcp-hosting.md`,
 * Increment 4). `agentSession.ts` dispatches an agent's `mcp-call` SSE event
 * through three tiers in order — `__hostMcpServers` (Acabox's own relays),
 * `miniAppMcpRegistry` (a mini-app's published server), then hosted MCP
 * servers — falling through to "Unknown MCP server" only if none of the
 * three claims the name.
 *
 * The hosted tier is driven against a REAL hosted server (the echo fixture)
 * through the REAL `mcpHost` module — not a mock — so this proves the actual
 * wiring: `mcpHost.list()`'s membership check, `mcpHost.invoke()`'s
 * `CallToolResult` shape, and the conversion into this module's
 * `{content,isError}` `ToolResult`. House doctrine (`jobRegistry.test.ts`,
 * lines 1-21): `electron`/`electron-log` are the only mocks.
 *
 * `agentSession.ts` pulls in a lot transitively (chatRepository/better-
 * sqlite3, containerService, apiProxy, the knowledge modules, …) but none of
 * it is touched at import time or by anything this file calls — `getDatabase`
 * et al are all lazy, called only from functions this test never reaches.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-agentsession-mcprelay-'));

// `mcpHost.start()`/`startAll()` both refuse to run anything at all when
// `isEncryptionAvailable()` is false (`secretStore.ts`'s posture — the
// hosted-server store is sealed) — so `safeStorage` has to be a real,
// reversible fake here too, or every hosted server in this file would
// silently sit at `stopped` forever and every "wait for ready" would time
// out with no error naming the real cause. Matches `mcpHostIndex.test.ts`'s
// own mock exactly.
const FAKE_CIPHER_PREFIX = 'FAKE-SEALED:';
// Counted, not just faked: unsealing the store is the expensive thing
// `handleMcpRelay`'s two-tier membership check exists to keep off the hot
// path, and a decrypt counter is the only way to assert that from outside.
// Must be `mock`-prefixed to be legal inside a `jest.mock` factory.
const mockDecryptCalls = { count: 0 };
jest.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`${FAKE_CIPHER_PREFIX}${plain}`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      mockDecryptCalls.count += 1;
      const str = buf.toString('utf-8');
      if (!str.startsWith(FAKE_CIPHER_PREFIX)) throw new Error('bad ciphertext');
      return str.slice(FAKE_CIPHER_PREFIX.length);
    },
  },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { handleMcpRelay } from '../agentSession';
import * as mcpHost from '../mcpHost';
import { registerHostedServer, updateHostedServer, type HostedServerRegistration } from '../mcpHost/store';
import { __resetSupervisorForTests } from '../mcpHost/supervisor';

// Increment 7's write gate planted this as a canary: if the refusal message
// ever grew a path built from the record's OWN env instead of just the
// caller-supplied server/tool names, this value would show up in it.
const PLANTED_SECRET = 'canary-mcphost-env-df8b21';

const fixture = path.join(__dirname, 'fixtures', 'echoMcpServer.mjs');

function echoRegistration(id: string, env: Record<string, string> = {}): HostedServerRegistration {
  return {
    id,
    label: id,
    autostart: true,
    install: { kind: 'custom' },
    entry: { command: process.execPath, args: [fixture] },
    env: { ELECTRON_RUN_AS_NODE: '1', ...env },
    concurrency: 1,
  };
}

function waitForReady(id: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error(`Timed out waiting for "${id}" to become ready`)); }, timeoutMs);
    const unsub = mcpHost.onInventoryChanged(async (changedId) => {
      if (changedId !== id) return;
      const entry = (await mcpHost.list()).find((e) => e.id === id);
      if (entry?.state === 'ready') { clearTimeout(timer); unsub(); resolve(); }
    });
  });
}

async function registerEnableAndStart(id: string, env: Record<string, string> = {}): Promise<void> {
  const wait = waitForReady(id);
  const reg = await registerHostedServer(echoRegistration(id, env));
  if (!reg.ok) throw new Error(`registration failed: ${reg.error}`);
  await updateHostedServer(id, { enabled: true });
  const started = await mcpHost.start(id);
  if (!started.ok) throw new Error(`start() failed: ${started.error}`);
  await wait;
}

afterEach(async () => {
  await mcpHost.shutdown({ graceMs: 100 }).catch(() => {});
  __resetSupervisorForTests();
  try { fs.rmSync(path.join(tmpDir, 'mcp-servers'), { recursive: true, force: true }); } catch { /* not there */ }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('handleMcpRelay — hosted MCP fallthrough', () => {
  it('calls a real hosted server tool and returns its text content', async () => {
    await registerEnableAndStart('relay-echo');

    const result = await handleMcpRelay('relay-echo', 'echo', { text: 'from the relay' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'from the relay' }]);
  }, 15000);

  it('reports a hosted server tool call failure as isError, not as Unknown MCP server', async () => {
    await registerEnableAndStart('relay-crash-target');

    // `crash` exits the process without responding — the SDK client surfaces
    // that as a rejected callTool(), which handleMcpRelay must convert to an
    // error ToolResult naming the real failure, not fall through to the
    // generic "Unknown MCP server" message (the server IS known; the CALL
    // failed).
    const result = await handleMcpRelay('relay-crash-target', 'crash', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MCP call failed/);
    expect(result.content[0].text).not.toMatch(/Unknown MCP server/);
  }, 15000);

  it('a server name mcpHost has never heard of still reaches "Unknown MCP server"', async () => {
    const result = await handleMcpRelay('totally-unregistered-server-xyz', 'whatever', {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Unknown MCP server: totally-unregistered-server-xyz' }]);
  });

  it('a hosted server that is registered but never started reports why, not "Unknown MCP server"', async () => {
    // Deliberately registered WITHOUT enabling/starting it — mcpHost.list()
    // still reports it (it exists in the store), so this exercises the
    // membership check on a real, non-running record rather than an id
    // mcpHost has literally never seen.
    const reg = await registerHostedServer(echoRegistration('relay-never-started'));
    if (!reg.ok) throw new Error(reg.error);

    const result = await handleMcpRelay('relay-never-started', 'echo', { text: 'x' });

    // It IS a known hosted id, so this must NOT read "Unknown MCP server" —
    // it should report the real "server is stopped" failure instead.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toBe('Unknown MCP server: relay-never-started');
    expect(result.content[0].text).toMatch(/MCP call failed/);
  });

  it('does not unseal the store on the hot path of an already-started server', async () => {
    // The membership check is deliberately two-tier: the supervisor's
    // in-memory handle map first (free), the sealed store only on a miss.
    // Collapsing that back to a single `mcpHost.list()` would read the store
    // off disk and `safeStorage`-decrypt it on EVERY hosted tool call — a
    // blocking main-thread decrypt inside a loop the model controls. It would
    // also still pass every other test in this file, which is exactly why
    // this one counts decrypts instead of checking behaviour.
    await registerEnableAndStart('relay-hotpath');

    const before = mockDecryptCalls.count;
    const result = await handleMcpRelay('relay-hotpath', 'echo', { text: 'hot' });

    expect(result.isError).toBeFalsy();
    expect(mockDecryptCalls.count).toBe(before);
  }, 15000);

  it('converts a non-text content block instead of assuming content[0].text exists', async () => {
    // mcpHost.invoke() is the seam here — this is the one case a real MCP
    // server fixture can't easily produce (the SDK's own tool() helper always
    // wraps a return value as {type:'text',...} for a plain string), so the
    // SDK-shaped CallToolResult itself is the fixture instead. Everything
    // upstream of the conversion (list()'s membership check, invoke()'s
    // dispatch) is still real; only the one hard-to-reach return value is
    // stood in for.
    await registerEnableAndStart('relay-nontext');
    const invokeSpy = jest.spyOn(mcpHost, 'invoke').mockResolvedValueOnce({
      content: [{ type: 'image', data: 'YmFzZTY0', mimeType: 'image/png' }],
      isError: false,
    });

    try {
      const result = await handleMcpRelay('relay-nontext', 'echo', { text: 'ignored' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toMatch(/image/);
      expect(result.content[0].text).not.toContain('YmFzZTY0'); // not silently leaking raw base64 as if it were readable text
    } finally {
      invokeSpy.mockRestore();
    }
  }, 15000);
});

/**
 * Increment 7's write gate, Layer 2 (design: `docs/design/mcp-hosting.md`,
 * the DECISION (2026-08-13) block superseding R15) — the actual boundary.
 *
 * Every test in this block calls `handleMcpRelay` DIRECTLY, never through
 * `mcpHost.readyServersForAgent()`'s push filter (Layer 1). That is
 * deliberate: Layer 1 only keeps an unselected tool's schema out of the
 * `POST /hosted` payload, and this suite must prove the call is refused even
 * when nothing about that filter is exercised at all — i.e. it is written so
 * it would FAIL if someone deleted the host-side check in `agentSession.ts`
 * and relied on the push filter alone to keep an unselected tool uncallable.
 */
describe('handleMcpRelay — Increment 7 write gate (Layer 2, the actual boundary)', () => {
  it('absent enabledTools (the default): every tool on the real fixture is callable', async () => {
    await registerEnableAndStart('gate2-absent');

    const echo = await handleMcpRelay('gate2-absent', 'echo', { text: 'ok' });
    expect(echo.isError).toBeFalsy();
    const slow = await handleMcpRelay('gate2-absent', 'slow', { ms: 1 });
    expect(slow.isError).toBeFalsy();
  }, 15000);

  it('a tool Layer 1 would have filtered out of the push is STILL refused when called directly — the host-side check, not the filter, is what stops it', async () => {
    await registerEnableAndStart('gate2-narrow');
    const narrowed = await mcpHost.setEnabledTools('gate2-narrow', ['echo']);
    expect(narrowed.ok).toBe(true);

    // Sanity: Layer 1 would indeed have dropped "slow" from the push — this
    // is what makes the refusal below a Layer-2 property, not incidental.
    const push = await mcpHost.readyServersForAgent();
    expect(push['gate2-narrow'].tools.map((t) => t.name)).toEqual(['echo']);

    const selected = await handleMcpRelay('gate2-narrow', 'echo', { text: 'allowed' });
    expect(selected.isError).toBeFalsy();
    expect(selected.content).toEqual([{ type: 'text', text: 'allowed' }]);

    const refused = await handleMcpRelay('gate2-narrow', 'slow', { ms: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).not.toMatch(/Unknown MCP server/);
    expect(refused.content[0].text).not.toMatch(/MCP call failed/); // refused BEFORE ever reaching invoke()
  }, 15000);

  it('an empty enabledTools array refuses every tool, including ones that were callable a moment ago', async () => {
    await registerEnableAndStart('gate2-empty');
    expect((await handleMcpRelay('gate2-empty', 'echo', { text: 'still fine' })).isError).toBeFalsy();

    const result = await mcpHost.setEnabledTools('gate2-empty', []);
    expect(result.ok).toBe(true);

    const echo = await handleMcpRelay('gate2-empty', 'echo', { text: 'no longer fine' });
    expect(echo.isError).toBe(true);
    const slow = await handleMcpRelay('gate2-empty', 'slow', { ms: 1 });
    expect(slow.isError).toBe(true);
  }, 15000);

  it('narrowing mid-session refuses immediately, with no restart of the child and no wait for a push', async () => {
    await registerEnableAndStart('gate2-midsession');
    const pidBefore = (await mcpHost.list()).find((e) => e.id === 'gate2-midsession')?.pid;

    expect((await handleMcpRelay('gate2-midsession', 'slow', { ms: 1 })).isError).toBeFalsy();

    await mcpHost.setEnabledTools('gate2-midsession', ['echo']); // narrows AFTER a successful call to "slow"

    const refused = await handleMcpRelay('gate2-midsession', 'slow', { ms: 1 });
    expect(refused.isError).toBe(true);

    const pidAfter = (await mcpHost.list()).find((e) => e.id === 'gate2-midsession')?.pid;
    expect(pidAfter).toBe(pidBefore); // same child throughout — this was a config check, not a respawn
  }, 15000);

  it('the refusal names the server and the tool, states the fix, and carries NEITHER the record\'s env NOR the resolved command', async () => {
    await registerEnableAndStart('gate2-refusal-text', { MY_SECRET_TOKEN: PLANTED_SECRET });
    await mcpHost.setEnabledTools('gate2-refusal-text', []); // refuse everything

    const result = await handleMcpRelay('gate2-refusal-text', 'echo', { text: 'x' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;

    // Actionable, matching the shipped API-proxy 405's own shape (CLAUDE.md:
    // the agent "quot[ed] the actionable message verbatim") — names the
    // server, names the tool, states the fix.
    expect(text).toContain('gate2-refusal-text');
    expect(text).toContain('echo');
    expect(text.toLowerCase()).toMatch(/enable/);
    expect(text.toLowerCase()).toMatch(/servers page/);

    // No secret. Neither the env KEY nor its VALUE ever appears.
    expect(text).not.toContain('MY_SECRET_TOKEN');
    expect(text).not.toContain(PLANTED_SECRET);
    // No resolved command — this refusal is decided before the record's
    // `entry` is ever consulted, so there is nothing here that COULD name it,
    // but assert it anyway as the outward-facing guarantee.
    expect(text).not.toContain(process.execPath);
    expect(text).not.toContain(fixture);
  }, 15000);

  it('does not unseal the store to decide a refusal — the write-gate check is as cheap as the membership check it sits beside', async () => {
    // Mirrors the pre-existing "does not unseal the store on the hot path"
    // test above, extended to the refusal path itself: `isToolEnabled()`
    // reads the supervisor's in-memory record only (`getEnabledTools`), so
    // deciding to REFUSE a call must cost exactly as little as deciding to
    // allow one — neither should touch `store.ts`'s sealed file.
    await registerEnableAndStart('gate2-hotpath-refusal');
    await mcpHost.setEnabledTools('gate2-hotpath-refusal', []);

    const before = mockDecryptCalls.count;
    const result = await handleMcpRelay('gate2-hotpath-refusal', 'echo', { text: 'x' });

    expect(result.isError).toBe(true);
    expect(mockDecryptCalls.count).toBe(before);
  }, 15000);
});
