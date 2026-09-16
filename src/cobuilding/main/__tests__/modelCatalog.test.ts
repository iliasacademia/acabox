/**
 * @jest-environment node
 *
 * Node, not the repo's default jsdom: this drives a real loopback server, and
 * under jsdom `fetch` never reaches it (the request count stays 0 and every
 * assertion fails for a reason that has nothing to do with the code).
 */
import * as http from 'http';
import {
  __resetModelCatalogForTests,
  discoveredModels,
  discoveryError,
  refreshModels,
} from '../modelCatalog';

/**
 * Driven against a REAL local HTTP server rather than a mocked `fetch`, the
 * same way `apiProxy` is tested here: pagination, a non-200, and a malformed
 * body are all things the real endpoint does and a stubbed fetch would only
 * ever do the way I imagined them.
 */

jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let server: http.Server;
let baseURL: string;
/** Set per-test to control what the fake endpoint does. */
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let requests: { url: string; apiKey: string | undefined }[] = [];

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', apiKey: req.headers['x-api-key'] as string | undefined });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  __resetModelCatalogForTests();
  requests = [];
  handler = (_req, res) => json(res, 200, { data: [], has_more: false });
});

const creds = () => ({ apiKey: 'sk-ant-test-KEYMATERIAL', baseURL });

test('reads the roster and keeps only the fields we use', async () => {
  handler = (_req, res) => json(res, 200, {
    data: [
      { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-04-01T00:00:00Z', extra: 'ignored' },
    ],
    has_more: false,
  });

  const models = await refreshModels(creds());
  expect(models).toEqual([
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-04-01T00:00:00Z' },
  ]);
  expect(discoveryError()).toBeNull();
  expect(requests[0].apiKey).toBe('sk-ant-test-KEYMATERIAL');
});

test('follows pagination with after_id', async () => {
  handler = (req, res) => {
    const after = new URL(req.url ?? '', baseURL).searchParams.get('after_id');
    if (!after) {
      json(res, 200, { data: [{ id: 'a' }], has_more: true, last_id: 'a' });
    } else {
      json(res, 200, { data: [{ id: 'b' }], has_more: false });
    }
  };

  const models = await refreshModels(creds());
  expect(models.map((m) => m.id)).toEqual(['a', 'b']);
  expect(requests).toHaveLength(2);
  expect(requests[1].url).toContain('after_id=a');
});

test('a row with no id is dropped rather than becoming undefined', async () => {
  // This list feeds a Set of allowed model strings; an `undefined` in there
  // would be a hole in the mini-app gate, not a cosmetic glitch.
  handler = (_req, res) => json(res, 200, {
    data: [{ display_name: 'nameless' }, { id: '' }, { id: 'claude-opus-5' }],
    has_more: false,
  });
  const models = await refreshModels(creds());
  expect(models.map((m) => m.id)).toEqual(['claude-opus-5']);
});

test('a failure does not clobber a roster we already have', async () => {
  handler = (_req, res) => json(res, 200, { data: [{ id: 'claude-opus-5' }], has_more: false });
  await refreshModels(creds());
  expect(discoveredModels().map((m) => m.id)).toEqual(['claude-opus-5']);

  handler = (_req, res) => json(res, 500, { error: 'boom' });
  const after = await refreshModels(creds(), true);

  // The point: a transient 500 must not empty a picker that is working.
  expect(after.map((m) => m.id)).toEqual(['claude-opus-5']);
  expect(discoveryError()).toContain('500');
});

test('the API key never appears in the recorded error', async () => {
  // The endpoint can echo the request back on an error; this list is shown in
  // the UI and written to the log.
  handler = (_req, res) => json(res, 401, {
    error: { message: 'invalid x-api-key: sk-ant-test-KEYMATERIAL' },
  });
  await refreshModels(creds(), true);
  expect(discoveryError()).toBeTruthy();
  expect(discoveryError()).not.toContain('KEYMATERIAL');
  expect(discoveryError()).not.toContain('sk-ant');
});

test('a malformed body is an error, not a silently empty roster', async () => {
  handler = (_req, res) => json(res, 200, { notData: [] });
  await refreshModels(creds(), true);
  expect(discoveryError()).toContain('Malformed');
  expect(discoveredModels()).toEqual([]);
});

test('no key configured fails cleanly without a request', async () => {
  await refreshModels({ apiKey: null, baseURL });
  expect(requests).toHaveLength(0);
  expect(discoveryError()).toContain('No API key');
  expect(discoveredModels()).toEqual([]);
});

test('the cache short-circuits a second call, and force overrides it', async () => {
  handler = (_req, res) => json(res, 200, { data: [{ id: 'claude-opus-5' }], has_more: false });
  await refreshModels(creds());
  await refreshModels(creds());
  expect(requests).toHaveLength(1);        // served from cache

  await refreshModels(creds(), true);
  expect(requests).toHaveLength(2);        // force bypasses the TTL
});

test('concurrent callers share one in-flight request', async () => {
  // Boot kicks a refresh and the picker asks on mount; without single-flight
  // that is two roster fetches on every launch.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  handler = async (_req, res) => {
    await gate;
    json(res, 200, { data: [{ id: 'claude-opus-5' }], has_more: false });
  };

  const both = Promise.all([refreshModels(creds()), refreshModels(creds())]);
  release!();
  await both;
  expect(requests).toHaveLength(1);
});
