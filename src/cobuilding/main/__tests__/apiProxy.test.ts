/**
 * @jest-environment node
 *
 * The API proxy, exercised against REAL local HTTP servers.
 *
 * Nothing here mocks the network: every assertion about what a credential does
 * is made by looking at the headers a real server actually received. That
 * matters most for the redirect cases — the whole reason the manual loop exists
 * is a measured undici behaviour, and a mocked fetch would only prove the mock
 * agrees with the mock.
 *
 * Only the STORE is mocked, because it reads Electron's userData path.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { API_PROXY_TOKEN_HEADER, type ApiConfig } from '../../shared/apis';

const logInfo = jest.fn();
const logWarn = jest.fn();
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: logInfo, warn: logWarn, error: jest.fn() },
}));

/** The store the proxy reads. Tests write `registry` and it takes effect. */
const registry = new Map<string, ApiConfig>();
const recorded: Array<{ id: string; refused: boolean; status?: number }> = [];
jest.mock('../apiStore', () => ({
  getApiWithSecret: (id: string) => registry.get(id) ?? null,
  listApisWithSecrets: () => [...registry.values()],
  recordApiCall: (id: string, outcome: { refused: boolean; status?: number }) => {
    recorded.push({ id, ...outcome });
  },
}));

import { apiProxy, performApiRequest } from '../apiProxy';

// ---------------------------------------------------------------------------
// Test servers
// ---------------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  port: number;
  origin: string;
  seen: Seen[];
  close(): Promise<void>;
}

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void): Promise<TestServer> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      seen.push(record);
      handler(req, res, record);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Echoes 200 with a tiny body. */
function echoServer(): Promise<TestServer> {
  return startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
}

const servers: TestServer[] = [];
async function track(s: Promise<TestServer>): Promise<TestServer> {
  const server = await s;
  servers.push(server);
  return server;
}

function api(over: Partial<ApiConfig>): ApiConfig {
  const cfg: ApiConfig = {
    id: 'test',
    label: 'Test',
    baseUrl: 'http://127.0.0.1:1/',
    allowedHosts: [],
    auth: { style: 'none' },
    enabled: true,
    allowWrites: false,
    ...over,
  };
  registry.set(cfg.id, cfg);
  return cfg;
}

async function bodyText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return new Response(stream).text();
}

beforeEach(() => {
  registry.clear();
  recorded.length = 0;
  logInfo.mockClear();
  logWarn.mockClear();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

afterAll(async () => { await apiProxy.stop(); });

// ---------------------------------------------------------------------------

describe('write gate', () => {
  it('refuses a POST to a read-only API before any network call happens', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, allowWrites: false });

    const out = await performApiRequest({
      apiId: 'test', method: 'POST', path: 'thing', caller: { kind: 'chat' },
    });

    expect(out.status).toBe(405);
    expect(out.error).toMatch(/read-only/);
    expect(out.error).toMatch(/Settings → APIs/);
    // The point of a gate: the request never left the machine.
    expect(upstream.seen).toHaveLength(0);
    expect(recorded).toEqual([{ id: 'test', refused: true, status: 405 }]);
  });

  it('allows GET and HEAD on a read-only API', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, allowWrites: false });

    expect((await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } })).status).toBe(200);
    expect((await performApiRequest({ apiId: 'test', method: 'HEAD', path: 'x', caller: { kind: 'chat' } })).status).toBe(200);
    expect(upstream.seen.map((s) => s.method)).toEqual(['GET', 'HEAD']);
  });

  it('lets the same POST through once writes are enabled', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, allowWrites: true });

    const out = await performApiRequest({
      apiId: 'test',
      method: 'POST',
      path: 'thing',
      body: new TextEncoder().encode('{"a":1}'),
      caller: { kind: 'chat' },
    });

    expect(out.status).toBe(200);
    expect(upstream.seen[0].method).toBe('POST');
    expect(upstream.seen[0].body).toBe('{"a":1}');
    expect(recorded).toEqual([{ id: 'test', refused: false, status: 200 }]);
  });
});

describe('credential injection', () => {
  it('sends a bearer token', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'bearer', secret: 'SEKRIT' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } });
    expect(upstream.seen[0].headers.authorization).toBe('Bearer SEKRIT');
  });

  it('sends a custom header', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'header', headerName: 'X-API-Key', secret: 'SEKRIT' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } });
    expect(upstream.seen[0].headers['x-api-key']).toBe('SEKRIT');
  });

  it('appends a query parameter without disturbing the caller\'s own query', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'query', queryParam: 'api_key', secret: 'SEKRIT' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x?db=pubmed', caller: { kind: 'chat' } });
    expect(upstream.seen[0].url).toContain('db=pubmed');
    expect(upstream.seen[0].url).toContain('api_key=SEKRIT');
  });

  it('sends nothing when the API has no credential configured', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'bearer' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } });
    expect(upstream.seen[0].headers.authorization).toBeUndefined();
  });

  it('a caller-supplied Authorization CANNOT displace the injected one', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'bearer', secret: 'REAL' } });

    await performApiRequest({
      apiId: 'test',
      method: 'GET',
      path: 'x',
      headers: { Authorization: 'Bearer ATTACKER' },
      caller: { kind: 'chat' },
    });

    expect(upstream.seen[0].headers.authorization).toBe('Bearer REAL');
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('dropped a caller-supplied Authorization'));
  });

  it('strips x-acabox-* so a caller cannot forge proxy identity', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/` });

    await performApiRequest({
      apiId: 'test',
      method: 'GET',
      path: 'x',
      headers: { 'x-acabox-caller': 'chat', [API_PROXY_TOKEN_HEADER]: 'leak', 'x-keep': 'yes' },
      caller: { kind: 'chat' },
    });

    expect(upstream.seen[0].headers['x-acabox-caller']).toBeUndefined();
    expect(upstream.seen[0].headers[API_PROXY_TOKEN_HEADER]).toBeUndefined();
    expect(upstream.seen[0].headers['x-keep']).toBe('yes');
  });
});

describe('redirects', () => {
  it('follows a SAME-origin redirect and keeps the credential', async () => {
    const upstream = await track(startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/landed' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('landed');
    }));
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'bearer', secret: 'SEKRIT' } });

    const out = await performApiRequest({ apiId: 'test', method: 'GET', path: 'start', caller: { kind: 'chat' } });

    expect(out.status).toBe(200);
    expect(await bodyText(out.body)).toBe('landed');
    expect(upstream.seen.map((s) => s.headers.authorization)).toEqual(['Bearer SEKRIT', 'Bearer SEKRIT']);
  });

  it('DROPS the credential on a cross-origin hop, even to an allowed host', async () => {
    // This is the property undici gives you for `Authorization` and does NOT
    // give you for a custom header (measured: x-api-key survives a cross-origin
    // 302 with its value intact). Following by hand is what makes the rule
    // uniform. It is also the compatible choice — presigned object hosts reject
    // a request carrying two auth mechanisms.
    const dest = await track(echoServer());
    const origin = await track(startServer((_req, res) => {
      res.writeHead(302, { location: `${dest.origin}/landed` });
      res.end();
    }));
    api({
      baseUrl: `${origin.origin}/`,
      allowedHosts: ['127.0.0.1'],
      auth: { style: 'header', headerName: 'X-API-Key', secret: 'SEKRIT' },
    });

    const out = await performApiRequest({ apiId: 'test', method: 'GET', path: 'start', caller: { kind: 'chat' } });

    expect(out.status).toBe(200);
    expect(origin.seen[0].headers['x-api-key']).toBe('SEKRIT');
    expect(dest.seen[0].headers['x-api-key']).toBeUndefined();
  });

  it('REFUSES a redirect to a host that is not allowed', async () => {
    const evil = await track(echoServer());
    const origin = await track(startServer((_req, res) => {
      // A different host string for the same loopback interface, so the hop is
      // genuinely off the allow list rather than merely a different port.
      res.writeHead(302, { location: `http://localhost:${evil.port}/steal` });
      res.end();
    }));
    api({ baseUrl: `${origin.origin}/`, allowedHosts: [] });

    const out = await performApiRequest({ apiId: 'test', method: 'GET', path: 'start', caller: { kind: 'chat' } });

    expect(out.status).toBe(403);
    expect(out.error).toContain('localhost');
    expect(evil.seen).toHaveLength(0);
    expect(recorded[recorded.length - 1]).toEqual({ id: 'test', refused: true, status: 403 });
  });

  it('gives up after 5 hops rather than looping forever', async () => {
    let n = 0;
    const looper = await track(startServer((_req, res) => {
      res.writeHead(302, { location: `/hop${++n}` });
      res.end();
    }));
    api({ baseUrl: `${looper.origin}/` });

    const out = await performApiRequest({ apiId: 'test', method: 'GET', path: 'start', caller: { kind: 'chat' } });

    expect(out.status).toBe(508);
    expect(out.error).toMatch(/redirected more than 5 times/);
  });

  it('turns a 303 into a GET and drops the body', async () => {
    const upstream = await track(startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(303, { location: '/landed' });
        res.end();
        return;
      }
      res.writeHead(200); res.end('ok');
    }));
    api({ baseUrl: `${upstream.origin}/`, allowWrites: true });

    await performApiRequest({
      apiId: 'test',
      method: 'POST',
      path: 'start',
      body: new TextEncoder().encode('payload'),
      caller: { kind: 'chat' },
    });

    expect(upstream.seen[0].method).toBe('POST');
    expect(upstream.seen[1].method).toBe('GET');
    expect(upstream.seen[1].body).toBe('');
  });
});

describe('audit logging', () => {
  it('writes the query-auth secret to the WIRE and to neither the log nor the counters', async () => {
    // This app has already leaked an API key into cobuilding.log once, from a
    // failure path nobody thought about. For a query-auth API the credential IS
    // the URL, so the log line is the exact place it would happen again.
    const upstream = await track(echoServer());
    api({
      baseUrl: `${upstream.origin}/`,
      auth: { style: 'query', queryParam: 'api_key', secret: 'SUPERSECRET' },
    });

    await performApiRequest({ apiId: 'test', method: 'GET', path: 'e.fcgi?db=pubmed', caller: { kind: 'chat' } });

    expect(upstream.seen[0].url).toContain('api_key=SUPERSECRET');   // reached the service

    const allLogs = [...logInfo.mock.calls, ...logWarn.mock.calls].flat().join('\n');
    expect(allLogs).not.toContain('SUPERSECRET');
    expect(allLogs).toContain('api_key=REDACTED');
    expect(allLogs).toContain('db=pubmed');                          // still useful
    expect(JSON.stringify(recorded)).not.toContain('SUPERSECRET');
  });

  it('does not log a bearer token', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'bearer', secret: 'SUPERSECRET' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } });
    expect([...logInfo.mock.calls].flat().join('\n')).not.toContain('SUPERSECRET');
  });
});

describe('lookup and grants', () => {
  it('404s an unknown id and names what IS enabled, so a typo self-corrects', async () => {
    api({ id: 'ncbi', baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/' });
    api({ id: 'zenodo', baseUrl: 'https://zenodo.org/api/' });

    const out = await performApiRequest({ apiId: 'ncbo', method: 'GET', path: '', caller: { kind: 'chat' } });

    expect(out.status).toBe(404);
    expect(out.error).toContain('ncbi');
    expect(out.error).toContain('zenodo');
  });

  it('refuses a disabled API', async () => {
    api({ baseUrl: 'https://api.example.com/', enabled: false });
    expect((await performApiRequest({ apiId: 'test', method: 'GET', path: '', caller: { kind: 'chat' } })).status).toBe(404);
  });

  it('refuses a mini-app that has not been granted the API, but not the chat agent', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/` });

    const denied = await performApiRequest({
      apiId: 'test', method: 'GET', path: 'x',
      caller: { kind: 'miniapp', dirName: 'myTool', grantedApis: ['other'] },
    });
    expect(denied.status).toBe(403);
    expect(denied.error).toContain('myTool');

    const granted = await performApiRequest({
      apiId: 'test', method: 'GET', path: 'x',
      caller: { kind: 'miniapp', dirName: 'myTool', grantedApis: ['test'] },
    });
    expect(granted.status).toBe(200);
  });
});

describe('the loopback server', () => {
  beforeAll(async () => { await apiProxy.start(); });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${apiProxy.baseUrl()}${path}`, init);

  it('starts and reports a loopback base URL', () => {
    expect(apiProxy.isRunning()).toBe(true);
    expect(apiProxy.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:235\d\d$/);
    expect(apiProxy.token()).toBeTruthy();
  });

  it('serves /_health without a token', async () => {
    const res = await call('/_health');
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('401s with no token, and with a wrong one', async () => {
    expect((await call('/test/x')).status).toBe(401);
    expect((await call('/test/x', { headers: { [API_PROXY_TOKEN_HEADER]: 'nope' } })).status).toBe(401);
  });

  it('401s a request that looks like it came from a browser', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/` });
    const res = await call('/test/x', {
      headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.token()!, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it('proxies a real call with the right token, attaching the credential', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'bearer', secret: 'SEKRIT' } });

    const res = await call('/test/thing?q=1', {
      headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.token()! },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(upstream.seen[0].url).toBe('/thing?q=1');
    expect(upstream.seen[0].headers.authorization).toBe('Bearer SEKRIT');
  });

  it('streams a large body through byte-for-byte', async () => {
    // The property that justified a proxy over an MCP tool: bytes go to the
    // caller, not through the model's context.
    const payload = 'x'.repeat(5 * 1024 * 1024);
    const upstream = await track(startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(payload);
    }));
    api({ baseUrl: `${upstream.origin}/` });

    const res = await call('/test/big', { headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.token()! } });
    const received = await res.text();

    expect(received).toHaveLength(payload.length);
    expect(received).toBe(payload);
  });

  it('surfaces a policy refusal as its real status and message', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, allowWrites: false });

    const res = await call('/test/thing', {
      method: 'POST',
      headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.token()! },
      body: '{}',
    });

    expect(res.status).toBe(405);
    expect((await res.json()).error).toMatch(/read-only/);
  });

  it('404s a request with no API id at all', async () => {
    const res = await call('/', { headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.token()! } });
    expect(res.status).toBe(404);
  });
});
