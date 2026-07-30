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

import { apiProxy, performApiRequest, setToolGrantResolver } from '../apiProxy';

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

  it('sends Basic with the key as username and an empty password', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'basic', secret: 'sk_live_abc' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } });
    const header = upstream.seen[0].headers.authorization!;
    expect(header.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(header.slice(6), 'base64').toString('utf-8')).toBe('sk_live_abc:');
  });

  it('sends Basic as a user:password pair when a username is configured', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'basic', basicUser: 'alice', secret: 'hunter2' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } });
    const header = upstream.seen[0].headers.authorization!;
    expect(Buffer.from(header.slice(6), 'base64').toString('utf-8')).toBe('alice:hunter2');
  });

  it('base64s Basic from UTF-8 bytes, so a non-ASCII password survives', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, auth: { style: 'basic', basicUser: 'u', secret: 'pä§§wörd' } });
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'x', caller: { kind: 'chat' } });
    const header = upstream.seen[0].headers.authorization!;
    expect(Buffer.from(header.slice(6), 'base64').toString('utf-8')).toBe('u:pä§§wörd');
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

  it('logs every refusal, since a blocked call is the most auditable event there is', async () => {
    // The counters are in-memory and die with the app, so without this line a
    // refused write leaves no lasting trace anywhere.
    api({ baseUrl: 'https://api.example.com/', allowWrites: false });
    await performApiRequest({ apiId: 'test', method: 'DELETE', path: 'x', caller: { kind: 'chat' } });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('REFUSED test → 405'));
  });

  it('does not put a query-auth secret into a REFUSAL line either', async () => {
    api({
      baseUrl: 'https://api.example.com/v1/',
      auth: { style: 'query', queryParam: 'api_key', secret: 'SUPERSECRET' },
    });
    // Refused at the host check, i.e. after the URL is resolved but before any
    // credential is attached — the path that would tempt someone to log the URL.
    await performApiRequest({ apiId: 'test', method: 'GET', path: 'https://evil.com/x', caller: { kind: 'chat' } });
    expect([...logWarn.mock.calls].flat().join('\n')).not.toContain('SUPERSECRET');
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

// ---------------------------------------------------------------------------
// Regressions from the 2026-07-29 self-review (B14, B15, B17, B18).
// ---------------------------------------------------------------------------

describe('B18 — method-override headers cannot walk through the read-only gate', () => {
  it.each(['x-http-method-override', 'x-method-override', 'x-http-method'])(
    'strips %s from a GET to a read-only API',
    async (header) => {
      const upstream = await track(echoServer());
      api({ baseUrl: `${upstream.origin}/`, allowWrites: false });

      const out = await performApiRequest({
        apiId: 'test', method: 'GET', path: 'thing',
        headers: { [header]: 'DELETE' },
        caller: { kind: 'chat' },
      });

      expect(out.status).toBe(200);
      // The gate lets GET through; what must not survive is the instruction to
      // reinterpret it as a DELETE on the far end.
      expect(upstream.seen[0].headers[header]).toBeUndefined();
      expect(upstream.seen[0].method).toBe('GET');
    },
  );
});

describe('B17 — a hung upstream cannot hold a turn open forever', () => {
  it('504s when response headers never arrive, without killing body streaming', async () => {
    // Never responds. Without a deadline this await would hang for the life of
    // the process, which is exactly the bug.
    const black = await track(startServer(() => { /* deliberately silent */ }));
    api({ baseUrl: `${black.origin}/`, id: 'slow' });

    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const pending = performApiRequest({
        apiId: 'slow', method: 'GET', path: 'x', caller: { kind: 'chat' },
      });
      await jest.advanceTimersByTimeAsync(31_000);
      const out = await pending;
      expect(out.status).toBe(504);
      expect(out.error).toMatch(/did not send response headers within 30s/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT abort a slow BODY once headers have arrived', async () => {
    // Headers immediately, body dribbled out afterwards. The deadline is on
    // time-to-headers only, because a multi-gigabyte download to disk is the
    // case this whole feature exists for.
    const dribble = await track(startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('start');
      setTimeout(() => res.end('-end'), 150);
    }));
    api({ baseUrl: `${dribble.origin}/`, id: 'dribble' });

    const out = await performApiRequest({
      apiId: 'dribble', method: 'GET', path: 'x', caller: { kind: 'chat' },
    });
    expect(out.status).toBe(200);
    expect(await bodyText(out.body)).toBe('start-end');
  });
});

describe('B15 — path forms that mean the same request are treated the same', () => {
  it('resolves a LEADING-SLASH path against the base path, not the host root', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/v2/`, id: 'lead' });

    const withSlash = await performApiRequest({
      apiId: 'lead', method: 'GET', path: '/entries', caller: { kind: 'chat' },
    });
    const without = await performApiRequest({
      apiId: 'lead', method: 'GET', path: 'entries', caller: { kind: 'chat' },
    });

    // Before the fix the first of these was a 403 "outside this API's base
    // path" — the idiomatic REST form failing while the other worked.
    expect(withSlash.status).toBe(200);
    expect(without.status).toBe(200);
    expect(upstream.seen.map((s) => s.url)).toEqual(['/v2/entries', '/v2/entries']);
  });

  it('resolves against a base URL saved WITHOUT a trailing slash', async () => {
    const upstream = await track(echoServer());
    // RFC 3986 would drop the last segment here, silently producing /esearch.
    api({ baseUrl: `${upstream.origin}/entrez/eutils`, id: 'noslash' });

    const out = await performApiRequest({
      apiId: 'noslash', method: 'GET', path: 'esearch.fcgi', caller: { kind: 'chat' },
    });
    expect(out.status).toBe(200);
    expect(upstream.seen[0].url).toBe('/entrez/eutils/esearch.fcgi');
  });

  it('still refuses a PROTOCOL-RELATIVE path, which is a host swap not a path', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/v2/`, id: 'rel' });

    // Only ONE leading slash is stripped, so `//host/x` stays a host swap and
    // is judged as one. Against this http (loopback) base the https-only rule
    // catches it first; the case below is the same swap with the host check
    // doing the catching. Either way it never leaves the machine.
    const out = await performApiRequest({
      apiId: 'rel', method: 'GET', path: '//evil.example.com/x', caller: { kind: 'chat' },
    });
    expect(out.status).toBe(403);
    expect(upstream.seen).toHaveLength(0);
  });

  it('refuses a protocol-relative host swap on the HOST rule when the base is https', async () => {
    api({ baseUrl: 'https://api.example.com/v2/', id: 'rel2', allowedHosts: [] });

    const out = await performApiRequest({
      apiId: 'rel2', method: 'GET', path: '//evil.example.com/x', caller: { kind: 'chat' },
    });
    expect(out.status).toBe(403);
    expect(out.error).toMatch(/evil\.example\.com/);
  });

  it('still refuses a traversal out of the base path', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/v2/`, id: 'trav' });

    const out = await performApiRequest({
      apiId: 'trav', method: 'GET', path: '../../login', caller: { kind: 'chat' },
    });
    expect(out.status).toBe(403);
    expect(upstream.seen).toHaveLength(0);
  });
});

describe('B14 — the proxy token IS the caller identity', () => {
  beforeAll(async () => { await apiProxy.start(); });

  it('issues a DIFFERENT token per caller, stable across asks', () => {
    const chat = apiProxy.tokenFor({ kind: 'chat' });
    const toolA = apiProxy.tokenFor({ kind: 'miniapp', dirName: 'toolA' });
    const toolB = apiProxy.tokenFor({ kind: 'miniapp', dirName: 'toolB' });

    expect(new Set([chat, toolA, toolB]).size).toBe(3);
    // Stability matters: a long-running child must not be left holding a token
    // that a later spawn invalidated.
    expect(apiProxy.tokenFor({ kind: 'miniapp', dirName: 'toolA' })).toBe(toolA);
    expect(apiProxy.token()).toBe(chat);
  });

  it('holds a TOOL token to that tool\'s grants over HTTP, not the agent\'s', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, id: 'secret-api' });
    setToolGrantResolver((dirName) => (dirName === 'granted' ? ['secret-api'] : []));

    const base = apiProxy.baseUrl();
    const asUngranted = await fetch(`${base}/secret-api/x`, {
      headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.tokenFor({ kind: 'miniapp', dirName: 'ungranted' })! },
    });
    const asGranted = await fetch(`${base}/secret-api/x`, {
      headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.tokenFor({ kind: 'miniapp', dirName: 'granted' })! },
    });
    const asChat = await fetch(`${base}/secret-api/x`, {
      headers: { [API_PROXY_TOKEN_HEADER]: apiProxy.token()! },
    });

    // THE REGRESSION: before this, every subprocess — including the one behind
    // a mini-app's hostAPI.exec() — carried one app-wide token and was served
    // as the chat agent, so an ungranted tool reached every enabled API.
    expect(asUngranted.status).toBe(403);
    expect((await asUngranted.json()).error).toMatch(/has not been granted/);
    expect(asGranted.status).toBe(200);
    expect(asChat.status).toBe(200);

    setToolGrantResolver(() => []);
  });

  it('reads grants fresh per request, so a revoke takes effect immediately', async () => {
    const upstream = await track(echoServer());
    api({ baseUrl: `${upstream.origin}/`, id: 'revokable' });
    const token = apiProxy.tokenFor({ kind: 'miniapp', dirName: 'tool' })!;
    const hit = () => fetch(`${apiProxy.baseUrl()}/revokable/x`, {
      headers: { [API_PROXY_TOKEN_HEADER]: token },
    });

    setToolGrantResolver(() => ['revokable']);
    expect((await hit()).status).toBe(200);

    // Same token, grant withdrawn — the token carries identity, never grants.
    setToolGrantResolver(() => []);
    expect((await hit()).status).toBe(403);

    setToolGrantResolver(() => []);
  });
});
