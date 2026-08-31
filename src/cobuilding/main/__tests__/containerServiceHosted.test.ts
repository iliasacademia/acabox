/**
 * `containerService`'s Increment 4 additions (`docs/design/mcp-hosting.md`):
 * `updateAgentHosted` / `rememberAgentHosted` / `onAgentServerRestarted`.
 *
 * `updateAgentHosted` is driven against a REAL local HTTP server standing in
 * for the agent server's `/hosted` route — mirroring `apiProxy.test.ts`'s own
 * doctrine ("nothing here mocks the network... only the STORE is mocked").
 * There is no real store to mock here (this module reads no disk), so the
 * only mocks are `electron`/`electron-log`, exactly per house doctrine
 * (`jobRegistry.test.ts`, lines 1-21).
 *
 * `HostProcessService` (the class, not the app-wide `containerService`
 * singleton) is constructed fresh per test so `agentServerRestartListeners`
 * from one test can never leak into the next. `agentPort` and
 * `lastAgentServerConfig` are private — poked via `as any`, the standard way
 * to drive a class's internal state directly in a unit test without adding
 * test-only setters to production code.
 *
 * `onAgentServerRestarted`'s real trigger (a crash + a real
 * `dist/agent-server.js` respawn) is deliberately NOT exercised here — that
 * would spawn a whole webpack bundle another agent is concurrently editing,
 * which is slow and would make this file's pass/fail depend on unrelated,
 * in-flight work. `notifyAgentServerRestarted` (the private method the exit
 * handler calls once the new process is confirmed healthy) is invoked
 * directly instead; the subscribe/fire/unsubscribe contract is exactly the
 * same regardless of what triggers it.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/acabox-containerservice-hosted-unused' },
}));
const logWarn = jest.fn();
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: logWarn, error: jest.fn() },
}));

import { HostProcessService } from '../containerService';
import type { HostedServerPush } from '../../shared/hostedMcp';

interface FakeAgentServer {
  port: number;
  requests: Array<{ path: string; body: string }>;
  respondWith: { status: number } | { hang: true };
  close(): Promise<void>;
}

function startFakeAgentServer(): Promise<FakeAgentServer> {
  return new Promise((resolve) => {
    const state: FakeAgentServer = {
      port: 0,
      requests: [],
      respondWith: { status: 200 },
      close: () => new Promise((res) => server.close(() => res())),
    };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        state.requests.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf-8') });
        if ('hang' in state.respondWith) return; // never respond — exercises the client-side timeout
        res.writeHead(state.respondWith.status, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

function samplePush(id = 'files'): Record<string, HostedServerPush> {
  return { [id]: { label: `Label for ${id}`, tools: [{ name: 'read_file', description: 'Reads a file.' }] } };
}

let fake: FakeAgentServer;
let service: HostProcessService;

beforeEach(async () => {
  fake = await startFakeAgentServer();
  service = new HostProcessService();
  (service as unknown as { agentPort: number | null }).agentPort = fake.port;
});

afterEach(async () => {
  await fake.close();
});

describe('updateAgentHosted', () => {
  it('POSTs the full payload to /hosted and resolves true on 2xx', async () => {
    const ok = await service.updateAgentHosted(samplePush());
    expect(ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe('/hosted');
    expect(JSON.parse(fake.requests[0].body)).toEqual({ hosted: samplePush() });
  });

  it('resolves false, never throws, when there is no agent port at all', async () => {
    (service as unknown as { agentPort: number | null }).agentPort = null;
    await expect(service.updateAgentHosted(samplePush())).resolves.toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it('resolves false, never throws, on a non-2xx response', async () => {
    fake.respondWith = { status: 500 };
    await expect(service.updateAgentHosted(samplePush())).resolves.toBe(false);
  });

  it('resolves false, never throws, when the agent server never responds (timeout)', async () => {
    // `updateAgentHosted`'s own request timeout is 5000ms — this test's jest
    // timeout must exceed that with real margin, or it races jest's 5000ms
    // default rather than proving anything about the client's timeout.
    fake.respondWith = { hang: true };
    await expect(service.updateAgentHosted(samplePush())).resolves.toBe(false);
  }, 15000);

  it('resolves false, never throws, when nothing is listening on the port at all', async () => {
    await fake.close();
    await expect(service.updateAgentHosted(samplePush())).resolves.toBe(false);
  });
});

describe('rememberAgentHosted — the crash-restart replay config', () => {
  function seedReplayConfig(over: Record<string, unknown> = {}): void {
    (service as unknown as { lastAgentServerConfig: string | null }).lastAgentServerConfig = JSON.stringify({
      allowedTools: ['Bash', 'Read', 'mcp__hex'],
      mcpServers: { hex: { type: 'http', url: 'https://app.hex.tech/mcp' } },
      hostedServers: {},
      ...over,
    });
  }

  function readReplayConfig(): any {
    return JSON.parse((service as unknown as { lastAgentServerConfig: string | null }).lastAgentServerConfig!);
  }

  it('is a no-op when no restart config has ever been written (nothing to refresh)', async () => {
    // lastAgentServerConfig starts null — startAgentServer was never called.
    const ok = await service.updateAgentHosted(samplePush());
    expect(ok).toBe(true); // the HTTP push itself still succeeds
    expect((service as unknown as { lastAgentServerConfig: string | null }).lastAgentServerConfig).toBeNull();
  });

  it('folds the pushed set into hostedServers, and unions its mcp__<id> into allowedTools alongside existing connector entries', async () => {
    seedReplayConfig();
    const ok = await service.updateAgentHosted(samplePush('files'));
    expect(ok).toBe(true);

    const cfg = readReplayConfig();
    expect(cfg.hostedServers).toEqual(samplePush('files'));
    // The connector's own mcp__hex entry survives untouched...
    expect(cfg.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'mcp__hex']));
    // ...and the new hosted id is added.
    expect(cfg.allowedTools).toContain('mcp__files');
  });

  it('a server that disappears from the live set on the NEXT push loses its mcp__<id>, without touching the connector entry', async () => {
    seedReplayConfig();
    await service.updateAgentHosted(samplePush('files'));
    expect(readReplayConfig().allowedTools).toContain('mcp__files');

    // Simulated restart moment: `files` is gone (failed/stopped), `db` is the
    // new live set — this is exactly the shape `mcpHost.readyServersForAgent()`
    // would hand `pushHostedInventory()` if `files` failed between two pushes.
    await service.updateAgentHosted(samplePush('db'));

    const cfg = readReplayConfig();
    expect(cfg.hostedServers).toEqual(samplePush('db'));
    expect(cfg.allowedTools).not.toContain('mcp__files');
    expect(cfg.allowedTools).toContain('mcp__db');
    expect(cfg.allowedTools).toContain('mcp__hex'); // still untouched
  });

  it('does NOT update the replay config when the push itself failed (a rejected push must not be remembered as live)', async () => {
    seedReplayConfig();
    fake.respondWith = { status: 500 };
    const ok = await service.updateAgentHosted(samplePush('files'));
    expect(ok).toBe(false);

    const cfg = readReplayConfig();
    expect(cfg.hostedServers).toEqual({}); // unchanged from the seed
    expect(cfg.allowedTools).not.toContain('mcp__files');
  });

  it('a config that fails to JSON.parse is left alone and logged, not thrown', async () => {
    (service as unknown as { lastAgentServerConfig: string | null }).lastAgentServerConfig = 'not json {{{';
    const ok = await service.updateAgentHosted(samplePush());
    expect(ok).toBe(true); // the live push still succeeded
    expect((service as unknown as { lastAgentServerConfig: string | null }).lastAgentServerConfig).toBe('not json {{{');
    expect(logWarn).toHaveBeenCalled();
  });
});

describe('onAgentServerRestarted', () => {
  function trigger(): void {
    (service as unknown as { notifyAgentServerRestarted(): void }).notifyAgentServerRestarted();
  }

  it('fires every subscriber', () => {
    const a = jest.fn();
    const b = jest.fn();
    service.onAgentServerRestarted(a);
    service.onAgentServerRestarted(b);
    trigger();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('an unsubscribed listener is not called again, while the remaining one still is', () => {
    const a = jest.fn();
    const b = jest.fn();
    const unsubA = service.onAgentServerRestarted(a);
    service.onAgentServerRestarted(b);
    trigger();
    unsubA();
    trigger();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('one listener throwing does not stop the others from firing', () => {
    const thrower = jest.fn(() => { throw new Error('boom'); });
    const survivor = jest.fn();
    service.onAgentServerRestarted(thrower);
    service.onAgentServerRestarted(survivor);
    expect(() => trigger()).not.toThrow();
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalled();
  });

  it('a fresh instance has no listeners left over from another instance', () => {
    const a = jest.fn();
    service.onAgentServerRestarted(a);
    const other = new HostProcessService();
    (other as unknown as { notifyAgentServerRestarted(): void }).notifyAgentServerRestarted();
    expect(a).not.toHaveBeenCalled();
  });
});
