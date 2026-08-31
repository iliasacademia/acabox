/**
 * Increment 4 — Agent reach (`docs/design/mcp-hosting.md`). Two things live
 * here:
 *
 *  1. `readyServersForAgent()` — the `POST /hosted` payload builder — driven
 *     against a REAL ready server (the echo fixture) and a REAL failed one
 *     (`/bin/false`, forced to `failed` in one attempt via
 *     `__setSupervisorTuningForTests`), proving the failed one is genuinely
 *     ABSENT rather than present with some "down" flag, and that a second
 *     call after a live-state change reflects the change rather than a
 *     cached answer.
 *  2. The connector-id half of the shared id-namespace guard: `mcpHost
 *     .save()` must refuse an id an existing CONNECTOR already owns. The
 *     other half (a connector refusing a hosted id) is a plain synchronous
 *     unit test in `main/__tests__/connectorsStore.test.ts` — this file is
 *     where it needs to be instead, because proving THIS direction needs a
 *     real connector row sitting in the SAME userData dir as the real
 *     hosted-server store, which only this file's setup provides.
 *
 * House doctrine (`jobRegistry.test.ts`, lines 1-21) via `mcpHostIndex
 * .test.ts`'s own precedent: a real temp userData dir before any mock;
 * `electron`/`electron-log` are the only mocks; `safeStorage` is a real,
 * reversible transform so both stores' sealing is actually exercised.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-mcphostagentreach-'));

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

import * as mcpHost from '../index';
import { registerHostedServer, updateHostedServer, type HostedServerRegistration } from '../store';
import { __setSupervisorTuningForTests, __resetSupervisorTuningForTests, __resetSupervisorForTests } from '../supervisor';
import { upsertConnector, listConnectorsWithSecrets } from '../../connectorsStore';

const fixture = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'echoMcpServer.mjs');
const settingsPath = path.join(tmpDir, 'cobuilding-settings.json');

function echoRegistration(id: string): HostedServerRegistration {
  return {
    id,
    label: id,
    autostart: true,
    install: { kind: 'custom' },
    entry: { command: process.execPath, args: [fixture] },
    env: { ELECTRON_RUN_AS_NODE: '1' },
    concurrency: 1,
  };
}

async function registerAndEnable(id: string): Promise<void> {
  const reg = await registerHostedServer(echoRegistration(id));
  if (!reg.ok) throw new Error(`registration failed: ${reg.error}`);
  await updateHostedServer(id, { enabled: true });
}

function waitForNextInventoryChange(id: string, predicate: (state: string) => boolean, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error(`Timed out waiting for "${id}"`)); }, timeoutMs);
    const unsub = mcpHost.onInventoryChanged(async (changedId) => {
      if (changedId !== id) return;
      const entry = (await mcpHost.list()).find((e) => e.id === id);
      if (entry && predicate(entry.state)) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

beforeEach(() => {
  __resetSupervisorTuningForTests();
  try { fs.rmSync(settingsPath); } catch { /* not there yet */ }
});

afterEach(async () => {
  await mcpHost.shutdown({ graceMs: 100 }).catch(() => {});
  __resetSupervisorForTests();
  try { fs.rmSync(path.join(tmpDir, 'mcp-servers'), { recursive: true, force: true }); } catch { /* not there */ }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('readyServersForAgent() — the POST /hosted payload', () => {
  it('includes a ready server with its live label + tools, and omits a failed one entirely', async () => {
    // Force the failure path to resolve in ONE attempt instead of the
    // default 6-attempt backoff (mcpHostSupervisor.test.ts's own precedent
    // for this exact knob) — this test only cares that `failed` is absent,
    // not how the backoff itself behaves.
    __setSupervisorTuningForTests({ BACKOFF_MAX_ATTEMPTS: 1, BACKOFF_INITIAL_MS: 10, BACKOFF_MAX_MS: 20 });

    await registerAndEnable('agent-reach-ready');
    await registerHostedServer({
      id: 'agent-reach-failed',
      label: 'Agent Reach Failed',
      autostart: true,
      install: { kind: 'custom' },
      entry: { command: '/bin/false', args: [] },
      env: {},
      concurrency: 1,
    }).then((r) => { if (!r.ok) throw new Error(r.error); });
    await updateHostedServer('agent-reach-failed', { enabled: true });

    // Both waiters must be armed BEFORE `startAll()` issues any spawn:
    // `/bin/false` with `BACKOFF_MAX_ATTEMPTS: 1` can reach `failed` fast
    // enough that a wait registered AFTER `startAll()` returns can miss the
    // transition entirely (`waitForNextInventoryChange` deliberately only
    // observes a FUTURE event, per `mcpHostSupervisor.test.ts`'s own
    // precedent) — a sequential `await` here raced exactly that and timed
    // out on this machine.
    const readyWait = waitForNextInventoryChange('agent-reach-ready', (s) => s === 'ready');
    const failedWait = waitForNextInventoryChange('agent-reach-failed', (s) => s === 'failed');
    await mcpHost.startAll();
    await Promise.all([readyWait, failedWait]);

    const push = await mcpHost.readyServersForAgent();

    expect(Object.keys(push)).toEqual(['agent-reach-ready']);
    expect(push['agent-reach-ready'].label).toBe('agent-reach-ready');
    expect(push['agent-reach-ready'].tools.map((t) => t.name).sort()).toEqual(['crash', 'echo', 'slow']);
    // The failed server is ABSENT — not present with an error/state field.
    // `shared/hostedMcp.ts`'s `HostedMcpPushPayload` doc comment is explicit
    // that there is no state field on this wire for a reason: the agent
    // server has no use for a server it cannot call.
    expect(push['agent-reach-failed']).toBeUndefined();
    expect('agent-reach-failed' in push).toBe(false);
  }, 20000);

  it('reads LIVE state on every call — a server that stops between two calls disappears from the second', async () => {
    await registerAndEnable('agent-reach-live');
    await mcpHost.startAll();
    await waitForNextInventoryChange('agent-reach-live', (s) => s === 'ready');

    const first = await mcpHost.readyServersForAgent();
    expect(first['agent-reach-live']).toBeDefined();

    await mcpHost.stop('agent-reach-live', { graceMs: 200 });

    const second = await mcpHost.readyServersForAgent();
    expect(second['agent-reach-live']).toBeUndefined();
  }, 15000);

  it('an empty store (nothing registered) produces an empty map, not an error', async () => {
    const push = await mcpHost.readyServersForAgent();
    expect(push).toEqual({});
  });
});

/**
 * Increment 7's write gate, Layer 1 (design: `docs/design/mcp-hosting.md`,
 * the DECISION (2026-08-13) block) — `enabledTools` filtering the PUSH.
 * "Absent means all tools; empty means none, and the two must be
 * distinguishable" is the decision block's own emphasis, so these two states
 * get their own tests rather than one that only checks a narrowed selection.
 */
describe('readyServersForAgent() — Increment 7 tool-selection filter', () => {
  it('absent enabledTools pushes every tool the server actually has', async () => {
    await registerAndEnable('gate-absent');
    await mcpHost.startAll();
    await waitForNextInventoryChange('gate-absent', (s) => s === 'ready');

    const push = await mcpHost.readyServersForAgent();
    expect(push['gate-absent'].tools.map((t) => t.name).sort()).toEqual(['crash', 'echo', 'slow']);
  }, 15000);

  it('an empty enabledTools array pushes the server with ZERO tools — not absent from the map, and not the same as never setting it', async () => {
    await registerAndEnable('gate-empty');
    await mcpHost.startAll();
    await waitForNextInventoryChange('gate-empty', (s) => s === 'ready');

    const before = await mcpHost.readyServersForAgent();
    expect(before['gate-empty'].tools.length).toBe(3); // sanity: starts as "absent" behaves like "all"

    const result = await mcpHost.setEnabledTools('gate-empty', []);
    expect(result.ok).toBe(true);

    const after = await mcpHost.readyServersForAgent();
    // Still READY and still a key in the map (liveness, not tool count, is
    // what membership tracks here) — just with nothing in `tools`.
    expect(after['gate-empty']).toBeDefined();
    expect(after['gate-empty'].tools).toEqual([]);
  }, 15000);

  it('a narrowed selection pushes only the named tools, and setEnabledTools takes effect with no restart', async () => {
    await registerAndEnable('gate-narrow');
    await mcpHost.startAll();
    await waitForNextInventoryChange('gate-narrow', (s) => s === 'ready');
    const pidBefore = (await mcpHost.list()).find((e) => e.id === 'gate-narrow')?.pid;

    await mcpHost.setEnabledTools('gate-narrow', ['echo']);

    const push = await mcpHost.readyServersForAgent();
    expect(push['gate-narrow'].tools.map((t) => t.name)).toEqual(['echo']);

    // Config-only change — the same child process, not a fresh spawn.
    const pidAfter = (await mcpHost.list()).find((e) => e.id === 'gate-narrow')?.pid;
    expect(pidAfter).toBe(pidBefore);
  }, 15000);

  it('setEnabledTools persists through list() and distinguishes absent from empty', async () => {
    await registerAndEnable('gate-persist');

    let entry = (await mcpHost.list()).find((e) => e.id === 'gate-persist');
    expect(entry?.enabledTools).toBeUndefined();

    await mcpHost.setEnabledTools('gate-persist', ['echo', 'slow']);
    entry = (await mcpHost.list()).find((e) => e.id === 'gate-persist');
    expect(entry?.enabledTools).toEqual(['echo', 'slow']);

    await mcpHost.setEnabledTools('gate-persist', []);
    entry = (await mcpHost.list()).find((e) => e.id === 'gate-persist');
    expect(entry?.enabledTools).toEqual([]); // NOT the same as undefined

    await mcpHost.setEnabledTools('gate-persist', undefined);
    entry = (await mcpHost.list()).find((e) => e.id === 'gate-persist');
    expect(entry?.enabledTools).toBeUndefined(); // clears back to "all", not stuck at []
  });

  it('setEnabledTools on a running server fires onInventoryChanged — the same mechanism AgentInfrastructureController already re-pushes on', async () => {
    await registerAndEnable('gate-notify');
    await mcpHost.startAll();
    await waitForNextInventoryChange('gate-notify', (s) => s === 'ready');

    const notified = new Promise<void>((resolve) => {
      const unsub = mcpHost.onInventoryChanged((id) => {
        if (id !== 'gate-notify') return;
        unsub();
        resolve();
      });
    });

    await mcpHost.setEnabledTools('gate-notify', ['echo']);
    await notified; // would hang (and time out the test) if setEnabledTools did not notify
  }, 10000);

  it('setEnabledTools reports an error for an unknown id, and does not throw', async () => {
    const result = await mcpHost.setEnabledTools('does-not-exist-xyz', ['echo']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No hosted server/);
  });
});

describe('id namespace shared with connectors — mcpHost.save() side', () => {
  it('refuses to save a hosted server whose id collides with an existing connector', async () => {
    upsertConnector({ id: 'hex', label: 'Hex', transport: 'http', url: 'https://app.hex.tech/mcp', enabled: true });

    const result = await mcpHost.save({
      id: 'hex',
      label: 'Not actually Hex',
      command: process.execPath,
      args: [fixture],
      envUpdates: {},
      envDeletes: [],
      autostart: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/);
    expect((await mcpHost.list()).find((e) => e.id === 'hex')).toBeUndefined();
    // The connector itself is untouched by the rejected hosted-server save.
    expect(listConnectorsWithSecrets().find((c) => c.id === 'hex')).toBeDefined();
  });

  it('a hosted id that does not collide with anything still saves normally', async () => {
    upsertConnector({ id: 'hex', label: 'Hex', transport: 'http', url: 'https://app.hex.tech/mcp', enabled: true });

    const result = await mcpHost.save({
      id: 'agent-reach-no-collision',
      label: 'No collision',
      command: process.execPath,
      args: [fixture],
      envUpdates: {},
      envDeletes: [],
      autostart: false,
    });

    expect(result.ok).toBe(true);
    expect((await mcpHost.list()).find((e) => e.id === 'agent-reach-no-collision')).toBeDefined();
  });
});
