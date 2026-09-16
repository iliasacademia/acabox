/**
 * @jest-environment node
 *
 * `ShareApiClient` against a REAL local `http.createServer`, following the
 * same pattern as `main/__tests__/apiProxy.test.ts`: nothing here mocks
 * `fetch` or the network, so a passing assertion means bytes actually
 * travelled to a real server on `127.0.0.1:0` and back.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { ArtifactMeta, ShareIndex } from '../../../shared/share';
import { ShareApiClient, ShareApiError } from '../shareApiClient';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface TestServer {
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
        body: Buffer.concat(chunks),
      };
      seen.push(record);
      handler(req, res, record);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Always answers 200 `{ok:true}` — the "nothing interesting happens" server. */
function okServer(): Promise<TestServer> {
  return startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

const servers: TestServer[] = [];
async function track(s: Promise<TestServer>): Promise<TestServer> {
  const server = await s;
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A client with a tiny backoff so retry tests stay fast (per the ticket's instruction). */
function client(origin: string, over: Partial<ConstructorParameters<typeof ShareApiClient>[0]> = {}): ShareApiClient {
  return new ShareApiClient({ apiUrl: origin, token: 'TOKEN', baseDelayMs: 1, ...over });
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// ---------------------------------------------------------------------------

describe('authorization', () => {
  it('sends the bearer token on every request', async () => {
    const server = await track(okServer());
    await client(server.origin, { token: 'SEKRIT' }).health();
    expect(server.seen[0].headers.authorization).toBe('Bearer SEKRIT');
  });
});

describe('health', () => {
  it('resolves without error when the server reports ok', async () => {
    const server = await track(okServer());
    await expect(client(server.origin).health()).resolves.toBeUndefined();
    expect(server.seen[0].method).toBe('GET');
    expect(server.seen[0].url).toBe('/v1/health');
  });
});

describe('listArtifacts', () => {
  it('GETs /v1/artifacts and returns the parsed index', async () => {
    const index: ShareIndex = {
      updatedAt: '2026-09-15T00:00:00.000Z',
      artifacts: [{ id: 'abc', kind: 'app', title: 'T', description: null, publishedAt: '2026-09-15T00:00:00.000Z', hash: HASH_A }],
    };
    const server = await track(startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(index));
    }));

    const result = await client(server.origin).listArtifacts();

    expect(result).toEqual(index);
    expect(server.seen[0].method).toBe('GET');
    expect(server.seen[0].url).toBe('/v1/artifacts');
  });
});

describe('getArtifact', () => {
  it('returns the parsed meta on 200', async () => {
    const meta: ArtifactMeta = {
      id: 'abc123', kind: 'file', title: 'A file', description: null,
      hash: HASH_A, publishedAt: '2026-09-15T00:00:00.000Z', entry: 'x.csv', files: [],
    };
    const server = await track(startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(meta));
    }));

    const result = await client(server.origin).getArtifact('file', 'abc123');

    expect(result).toEqual(meta);
    expect(server.seen[0].url).toBe('/v1/artifacts/file/abc123');
  });

  it('returns null on 404 without retrying', async () => {
    const server = await track(startServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-found' }));
    }));

    const result = await client(server.origin).getArtifact('app', 'missing');

    expect(result).toBeNull();
    expect(server.seen).toHaveLength(1);
  });
});

describe('putFile', () => {
  it('PUTs raw bytes with the given content-type at the versioned path, encoding each relPath segment', async () => {
    const server = await track(startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, key: 'x' }));
    }));
    const bytes = new TextEncoder().encode('hello world');

    await client(server.origin).putFile(
      'app', 'abc123', HASH_A, '.applications/my app/src/index.html', bytes, 'text/html; charset=utf-8',
    );

    expect(server.seen).toHaveLength(1);
    const req = server.seen[0];
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`/v1/artifacts/app/abc123/v/${HASH_A}/.applications/my%20app/src/index.html`);
    expect(req.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(req.body.toString('utf-8')).toBe('hello world');
  });
});

describe('commit', () => {
  it('PUTs the meta JSON to /v1/artifacts/:kind/:id', async () => {
    const server = await track(okServer());
    const meta: ArtifactMeta = {
      id: 'abc123', kind: 'app', title: 'My App', description: 'desc',
      hash: HASH_B, publishedAt: '2026-09-15T00:00:00.000Z',
      entry: '.applications/x/src/index.html', dirName: 'x',
      files: [{ path: 'w/.applications/x/src/index.html', size: 10, sha256: HASH_B }],
    };

    await client(server.origin).commit(meta);

    expect(server.seen).toHaveLength(1);
    const req = server.seen[0];
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('/v1/artifacts/app/abc123');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body.toString('utf-8'))).toEqual(meta);
  });
});

describe('remove', () => {
  it('DELETEs /v1/artifacts/:kind/:id', async () => {
    const server = await track(okServer());

    await client(server.origin).remove('file', 'xyz789');

    expect(server.seen).toHaveLength(1);
    expect(server.seen[0].method).toBe('DELETE');
    expect(server.seen[0].url).toBe('/v1/artifacts/file/xyz789');
  });
});

describe('retries', () => {
  it('never retries a ReadableStream body — it can only be consumed once (exactly 1 hit)', async () => {
    const server = await track(startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    }));
    const bytes = new TextEncoder().encode('payload');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    });

    await expect(client(server.origin).putFile('app', 'abcdefghij', HASH_A, 'w/x.txt', stream, 'text/plain'))
      .rejects.toMatchObject({ status: 500 });

    expect(server.seen).toHaveLength(1);
    expect(server.seen[0].body.toString()).toBe('payload');
  });

  it('retries a 500 and succeeds on the second attempt (exactly 2 hits)', async () => {
    let calls = 0;
    const server = await track(startServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    await client(server.origin).health();

    expect(server.seen).toHaveLength(2);
  });

  it('retries 429 the same way as 5xx', async () => {
    let calls = 0;
    const server = await track(startServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'slow-down' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    await client(server.origin).health();

    expect(server.seen).toHaveLength(2);
  });

  it('does NOT retry a 400 and throws a ShareApiError with the server-provided message', async () => {
    const server = await track(startServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad-id' }));
    }));

    let caught: unknown;
    try {
      await client(server.origin).health();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ShareApiError);
    expect((caught as ShareApiError).status).toBe(400);
    expect((caught as Error).message).toBe('bad-id');
    expect(server.seen).toHaveLength(1);
  });

  it('gives up after exactly maxAttempts on repeated 503s and throws with that status', async () => {
    const server = await track(startServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable' }));
    }));

    let caught: unknown;
    try {
      await client(server.origin).health();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ShareApiError);
    expect((caught as ShareApiError).status).toBe(503);
    expect((caught as Error).message).toBe('unavailable');
    expect(server.seen).toHaveLength(3); // default maxAttempts
  });

  it('honours a custom maxAttempts', async () => {
    const server = await track(startServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable' }));
    }));

    await expect(client(server.origin, { maxAttempts: 1 }).health()).rejects.toBeInstanceOf(ShareApiError);

    expect(server.seen).toHaveLength(1);
  });

  it('retries a network error (nobody listening) and eventually throws ShareApiError', async () => {
    // Port 1 is a reserved, unlisted port on loopback — the same sentinel the
    // apiProxy tests use for "guaranteed nobody is answering here".
    const c = new ShareApiClient({ apiUrl: 'http://127.0.0.1:1', token: 'T', maxAttempts: 2, baseDelayMs: 1 });

    await expect(c.health()).rejects.toBeInstanceOf(ShareApiError);
  });
});
