/**
 * @jest-environment node
 *
 * Exercises `handleApiRequest` (contract C4) against a real `MemoryBucket`
 * and real `Request` objects — no mocking of fetch/Request/Response, which
 * Node 22 (the runtime `npm test` actually uses via
 * `ELECTRON_RUN_AS_NODE=1 electron …`) provides globally, matching the
 * Workers runtime surface closely enough for this contract.
 */
import { handleApiRequest } from '../src/routes';
import { MemoryBucket } from '../../shared/memoryBucket';
import type { ApiEnv } from '../../shared/bucket';
import type { ArtifactMeta } from '../../../cobuilding/shared/share';

const TOKEN = 'test-publish-token-123';
const BASE = 'https://acabox-share-api.example.workers.dev';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const APP_ID = 'testapp001'; // 10 chars — the minimum valid length
const FILE_ID = 'testfile001';

function makeEnv(bucket: MemoryBucket = new MemoryBucket()): ApiEnv {
  return { BUCKET: bucket, PUBLISH_TOKEN: TOKEN };
}

function authedHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set('authorization', `Bearer ${TOKEN}`);
  return headers;
}

function req(path: string, init: RequestInit & { headers?: Record<string, string>; noAuth?: boolean } = {}): Request {
  const { noAuth, headers, ...rest } = init;
  return new Request(`${BASE}${path}`, {
    ...rest,
    headers: noAuth ? new Headers(headers) : authedHeaders(headers),
  });
}

function metaFor(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: APP_ID,
    kind: 'app',
    title: 'My App',
    description: null,
    hash: HASH_A,
    publishedAt: '2024-01-01T00:00:00.000Z',
    entry: '.applications/x/src/index.html',
    dirName: 'x',
    files: [{ path: 'w/.applications/x/src/index.html', size: 10, sha256: 'x'.repeat(64) }],
    ...overrides,
  };
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe('handleApiRequest', () => {
  describe('authorization', () => {
    it('fails closed when the Worker has no PUBLISH_TOKEN secret at all (401, not a 500)', async () => {
      const env = { ...makeEnv(), PUBLISH_TOKEN: undefined as unknown as string };
      const res = await handleApiRequest(req('/v1/health'), env);
      expect(res.status).toBe(401);
      const empty = { ...makeEnv(), PUBLISH_TOKEN: '' };
      const res2 = await handleApiRequest(
        new Request(`${BASE}/v1/health`, { headers: { authorization: 'Bearer ' } }),
        empty,
      );
      expect(res2.status).toBe(401);
    });

    it('rejects a request with no Authorization header', async () => {
      const res = await handleApiRequest(req('/v1/health', { noAuth: true }), makeEnv());
      expect(res.status).toBe(401);
      expect(await readJson(res)).toEqual({ error: 'unauthorized' });
    });

    it('rejects a request with the wrong bearer token', async () => {
      const res = await handleApiRequest(
        new Request(`${BASE}/v1/health`, { headers: { authorization: 'Bearer nope' } }),
        makeEnv()
      );
      expect(res.status).toBe(401);
      expect(await readJson(res)).toEqual({ error: 'unauthorized' });
    });

    it('rejects a token that is a prefix or suffix of the real one (length-sensitive)', async () => {
      const res = await handleApiRequest(
        new Request(`${BASE}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}x` } }),
        makeEnv()
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/health', () => {
    it('returns 200 {ok:true} with JSON content-type', async () => {
      const res = await handleApiRequest(req('/v1/health'), makeEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await readJson(res)).toEqual({ ok: true });
    });
  });

  describe('GET /v1/artifacts', () => {
    it('returns an empty index when none has been committed', async () => {
      const res = await handleApiRequest(req('/v1/artifacts'), makeEnv());
      expect(res.status).toBe(200);
      const body = (await readJson(res)) as { artifacts: unknown[] };
      expect(body.artifacts).toEqual([]);
    });

    it('is sorted newest publishedAt first after two commits', async () => {
      const env = makeEnv();
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, {
          method: 'PUT',
          body: JSON.stringify(metaFor({ publishedAt: '2024-01-01T00:00:00.000Z' })),
        }),
        env
      );
      await handleApiRequest(
        req(`/v1/artifacts/file/${FILE_ID}`, {
          method: 'PUT',
          body: JSON.stringify(
            metaFor({ id: FILE_ID, kind: 'file', dirName: undefined, publishedAt: '2024-06-01T00:00:00.000Z' })
          ),
        }),
        env
      );

      const res = await handleApiRequest(req('/v1/artifacts'), env);
      const body = (await readJson(res)) as { artifacts: Array<{ id: string }> };
      expect(body.artifacts.map((a) => a.id)).toEqual([FILE_ID, APP_ID]);
    });
  });

  describe('GET /v1/artifacts/:kind/:id', () => {
    it('404s when no meta exists', async () => {
      const res = await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`), makeEnv());
      expect(res.status).toBe(404);
      expect(await readJson(res)).toEqual({ error: 'not-found' });
    });

    it('returns the committed meta verbatim', async () => {
      const env = makeEnv();
      const meta = metaFor();
      await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(meta) }), env);

      const res = await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`), env);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await readJson(res)).toEqual(meta);
    });

    it('404s for an unknown kind rather than 400', async () => {
      const res = await handleApiRequest(req(`/v1/artifacts/bogus/${APP_ID}`), makeEnv());
      expect(res.status).toBe(404);
      expect(await readJson(res)).toEqual({ error: 'not-found' });
    });

    it('400s for a malformed id', async () => {
      const res = await handleApiRequest(req('/v1/artifacts/app/short'), makeEnv());
      expect(res.status).toBe(400);
      expect(await readJson(res)).toEqual({ error: 'invalid-id' });
    });
  });

  describe('PUT /v1/artifacts/:kind/:id/v/:hash/*  (file upload)', () => {
    it('stores the bytes at the exact versioned key with the request content-type', async () => {
      const env = makeEnv();
      const bytes = new TextEncoder().encode('console.log(1)');
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/${HASH_A}/dist/bundle.js`, {
          method: 'PUT',
          body: bytes,
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        }),
        env
      );
      expect(res.status).toBe(200);
      const body = (await readJson(res)) as { ok: boolean; key: string };
      expect(body.ok).toBe(true);
      expect(body.key).toBe(`a/${APP_ID}/v/${HASH_A}/dist/bundle.js`);

      const stored = await env.BUCKET.get(`a/${APP_ID}/v/${HASH_A}/dist/bundle.js`);
      expect(stored).not.toBeNull();
      expect(stored!.httpMetadata?.contentType).toBe('application/javascript; charset=utf-8');
      expect(await stored!.text()).toBe('console.log(1)');
    });

    it('falls back to contentTypeFor when no content-type header is sent', async () => {
      // A raw byte body (unlike a plain string) gets no Content-Type inferred
      // by the Request constructor itself, so this genuinely exercises the
      // "header absent" branch rather than a default the platform supplied.
      const env = makeEnv();
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/${HASH_A}/output/data.json`, {
          method: 'PUT',
          body: new TextEncoder().encode('{}'),
        }),
        env
      );
      const stored = await env.BUCKET.get(`a/${APP_ID}/v/${HASH_A}/output/data.json`);
      expect(stored!.httpMetadata?.contentType).toBe('application/json; charset=utf-8');
    });

    it('decodes a URL-encoded path segment before storing', async () => {
      const env = makeEnv();
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/${HASH_A}/a%20b.json`, {
          method: 'PUT',
          body: '{}',
        }),
        env
      );
      expect(await env.BUCKET.get(`a/${APP_ID}/v/${HASH_A}/a b.json`)).not.toBeNull();
      expect(await env.BUCKET.get(`a/${APP_ID}/v/${HASH_A}/a%20b.json`)).toBeNull();
    });

    it('rejects a bad id with 400', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/short/v/${HASH_A}/a.js`, { method: 'PUT', body: 'x' }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(await readJson(res)).toEqual({ error: 'invalid-id' });
    });

    it('rejects a bad hash with 400', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/not-a-hash/a.js`, { method: 'PUT', body: 'x' }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(await readJson(res)).toEqual({ error: 'invalid-hash' });
    });

    it('rejects a `..` smuggled inside one URL segment via an encoded slash', async () => {
      // A literal `../` (or its direct percent-encoding `%2e%2e/`) never
      // reaches our code at all — the WHATWG URL parser's own dot-segment
      // collapsing (per spec, "..", ".%2e", "%2e.", and "%2e%2e" are all
      // recognized) resolves it away before `handleApiRequest` ever sees the
      // pathname. The real attack this guards against is an encoded slash
      // *inside* what the URL parser sees as a single, unremarkable segment:
      // `..%2Fescape.js` is one segment to the router (no literal '/'), so it
      // isn't touched by URL normalization, but decoding it ourselves reveals
      // `../escape.js` — exactly why `normalizeSnapshotPath` re-splits and
      // re-checks the DECODED string rather than trusting URL segmentation.
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/${HASH_A}/..%2Fescape.js`, { method: 'PUT', body: 'x' }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(await readJson(res)).toEqual({ error: 'invalid-path' });
    });
  });

  describe('PUT /v1/artifacts/:kind/:id  (commit)', () => {
    it('writes meta.json and upserts the index', async () => {
      const env = makeEnv();
      const meta = metaFor();
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(meta) }),
        env
      );
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ ok: true });

      const storedMeta = await env.BUCKET.get(`a/${APP_ID}/meta.json`);
      expect(JSON.parse(await storedMeta!.text())).toEqual(meta);

      const index = JSON.parse(await (await env.BUCKET.get('index.json'))!.text()) as {
        artifacts: Array<{ id: string; hash: string }>;
      };
      expect(index.artifacts).toEqual([
        { id: APP_ID, kind: 'app', title: 'My App', description: null, publishedAt: meta.publishedAt, hash: HASH_A },
      ]);
    });

    it('deletes the previous version objects but keeps the new ones on a second commit with a new hash', async () => {
      const env = makeEnv();
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/${HASH_A}/src/index.html`, { method: 'PUT', body: '<html>v1</html>' }),
        env
      );
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(metaFor({ hash: HASH_A })) }),
        env
      );
      expect(await env.BUCKET.get(`a/${APP_ID}/v/${HASH_A}/src/index.html`)).not.toBeNull();

      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/${HASH_B}/src/index.html`, { method: 'PUT', body: '<html>v2</html>' }),
        env
      );
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, {
          method: 'PUT',
          body: JSON.stringify(metaFor({ hash: HASH_B, publishedAt: '2024-02-01T00:00:00.000Z' })),
        }),
        env
      );

      expect(await env.BUCKET.get(`a/${APP_ID}/v/${HASH_A}/src/index.html`)).toBeNull();
      const v2 = await env.BUCKET.get(`a/${APP_ID}/v/${HASH_B}/src/index.html`);
      expect(v2).not.toBeNull();
      expect(await v2!.text()).toBe('<html>v2</html>');

      const storedMeta = JSON.parse(await (await env.BUCKET.get(`a/${APP_ID}/meta.json`))!.text()) as ArtifactMeta;
      expect(storedMeta.hash).toBe(HASH_B);
    });

    it('400s when the body id does not match the URL', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(metaFor({ id: FILE_ID })) }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(await readJson(res)).toEqual({ error: 'invalid-meta' });
    });

    it('400s when the body kind does not match the URL', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(metaFor({ kind: 'file' })) }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(await readJson(res)).toEqual({ error: 'invalid-meta' });
    });

    it('400s on an invalid hash in the body', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(metaFor({ hash: 'nope' })) }),
        makeEnv()
      );
      expect(res.status).toBe(400);
    });

    it('400s on an empty entry', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(metaFor({ entry: '' })) }),
        makeEnv()
      );
      expect(res.status).toBe(400);
    });

    it('400s when files is not an array', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, {
          method: 'PUT',
          body: JSON.stringify({ ...metaFor(), files: 'nope' }),
        }),
        makeEnv()
      );
      expect(res.status).toBe(400);
    });

    it('400s on malformed JSON', async () => {
      const res = await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: '{not json' }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(await readJson(res)).toEqual({ error: 'invalid-json' });
    });
  });

  describe('DELETE /v1/artifacts/:kind/:id', () => {
    it('deletes every object for the id and removes it from the index', async () => {
      const env = makeEnv();
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}/v/${HASH_A}/src/index.html`, { method: 'PUT', body: '<html></html>' }),
        env
      );
      await handleApiRequest(
        req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(metaFor()) }),
        env
      );

      const res = await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`, { method: 'DELETE' }), env);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ ok: true });

      expect(await env.BUCKET.get(`a/${APP_ID}/meta.json`)).toBeNull();
      expect(await env.BUCKET.get(`a/${APP_ID}/v/${HASH_A}/src/index.html`)).toBeNull();

      const index = JSON.parse(await (await env.BUCKET.get('index.json'))!.text()) as { artifacts: unknown[] };
      expect(index.artifacts).toEqual([]);
    });

    it('returns 200 {ok:true} even when nothing existed for the id, and is idempotent', async () => {
      const env = makeEnv();
      const res1 = await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`, { method: 'DELETE' }), env);
      expect(res1.status).toBe(200);
      expect(await readJson(res1)).toEqual({ ok: true });

      // Same call again — nothing left to remove, still succeeds the same way.
      const res2 = await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`, { method: 'DELETE' }), env);
      expect(res2.status).toBe(200);
      expect(await readJson(res2)).toEqual({ ok: true });
    });

    it('does not disturb a different id sharing the same kind', async () => {
      const env = makeEnv();
      const otherId = 'otherapp01';
      await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`, { method: 'PUT', body: JSON.stringify(metaFor()) }), env);
      await handleApiRequest(
        req(`/v1/artifacts/app/${otherId}`, { method: 'PUT', body: JSON.stringify(metaFor({ id: otherId })) }),
        env
      );

      await handleApiRequest(req(`/v1/artifacts/app/${APP_ID}`, { method: 'DELETE' }), env);

      expect(await env.BUCKET.get(`a/${otherId}/meta.json`)).not.toBeNull();
      const index = JSON.parse(await (await env.BUCKET.get('index.json'))!.text()) as {
        artifacts: Array<{ id: string }>;
      };
      expect(index.artifacts.map((a) => a.id)).toEqual([otherId]);
    });
  });
});
