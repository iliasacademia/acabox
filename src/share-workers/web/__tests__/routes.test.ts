/**
 * @jest-environment node
 *
 * `handleWebRequest` exercised against a real `MemoryBucket` (standing in for
 * R2) and a fake `AssetsLike` that returns canned bodies per path. Routing
 * cases run with `ACCESS_DISABLED: 'true'` so they don't have to carry a
 * token; the auth gate itself is exercised separately with real RS256 tokens
 * signed against a real key pair via `globalThis.crypto.subtle` — the same
 * technique `accessJwt.test.ts` uses (its helpers aren't exported, so they're
 * reproduced here rather than editing that file).
 */

import { handleWebRequest } from '../src/routes';
import { MemoryBucket } from '../../shared/memoryBucket';
import type { AssetsLike, WebEnv } from '../../shared/bucket';
import type { Jwks } from '../src/accessJwt';
import {
  INDEX_KEY,
  metaKey,
  versionPrefix,
  type ArtifactMeta,
  type ShareIndex,
} from '../../../cobuilding/shared/share';

const TEAM_DOMAIN = 'acabox-share.cloudflareaccess.com';
const AUD = 'test-application-audience';
const ISSUER = `https://${TEAM_DOMAIN}`;

const APP_ID = 'appid1234567890a';
const APP_HASH = 'a'.repeat(64);
const FILE_ID = 'fileid1234567890';
const FILE_HASH = 'b'.repeat(64);

class FakeAssets implements AssetsLike {
  public readonly requestedPaths: string[] = [];

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    this.requestedPaths.push(path);
    const canned: Record<string, { body: string; contentType: string }> = {
      '/viewer.html': { body: '<html>viewer shell</html>', contentType: 'text/html; charset=utf-8' },
      '/viewer.js': { body: 'console.log("viewer");', contentType: 'application/javascript; charset=utf-8' },
      '/viewer.css': { body: 'body { margin: 0; }', contentType: 'text/css; charset=utf-8' },
    };
    const hit = canned[path];
    if (!hit) {
      return new Response('asset not found', { status: 404 });
    }
    // A real Assets binding tends to set its own aggressive cache-control on
    // hashed/static files; setting one here too proves routes.ts overrides it
    // rather than merely adding to it.
    return new Response(hit.body, {
      status: 200,
      headers: { 'content-type': hit.contentType, 'cache-control': 'public, max-age=3600' },
    });
  }
}

async function seedBucket(bucket: MemoryBucket): Promise<{ appMeta: ArtifactMeta; fileMeta: ArtifactMeta }> {
  const appMeta: ArtifactMeta = {
    id: APP_ID,
    kind: 'app',
    title: 'DNA Toolkit',
    description: 'Reverse-complement a sequence',
    hash: APP_HASH,
    publishedAt: '2026-09-01T00:00:00.000Z',
    entry: '.applications/dna-toolkit/src/index.html',
    dirName: 'dna-toolkit',
    files: [
      { path: 'w/.applications/dna-toolkit/src/index.html', size: 17, sha256: 'x'.repeat(64) },
      { path: 'w/.applications/dna-toolkit/dist/bundle.js', size: 15, sha256: 'y'.repeat(64) },
    ],
  };
  const fileMeta: ArtifactMeta = {
    id: FILE_ID,
    kind: 'file',
    title: 'results.csv',
    description: null,
    hash: FILE_HASH,
    publishedAt: '2026-09-05T00:00:00.000Z',
    entry: 'results.csv',
    files: [{ path: 'results.csv', size: 12, sha256: 'z'.repeat(64) }],
  };

  await bucket.put(metaKey('app', APP_ID), JSON.stringify(appMeta), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  await bucket.put(
    `${versionPrefix('app', APP_ID, APP_HASH)}w/.applications/dna-toolkit/src/index.html`,
    '<html>app</html>',
    { httpMetadata: { contentType: 'text/html; charset=utf-8' } }
  );
  await bucket.put(
    `${versionPrefix('app', APP_ID, APP_HASH)}w/.applications/dna-toolkit/dist/bundle.js`,
    'console.log(1)'
    // No explicit content type here on purpose: exercises the contentTypeFor() fallback.
  );

  await bucket.put(metaKey('file', FILE_ID), JSON.stringify(fileMeta), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  await bucket.put(`${versionPrefix('file', FILE_ID, FILE_HASH)}results.csv`, 'a,b,c\n1,2,3\n', {
    httpMetadata: { contentType: 'text/csv; charset=utf-8' },
  });

  const index: ShareIndex = {
    updatedAt: fileMeta.publishedAt,
    artifacts: [
      {
        id: APP_ID,
        kind: 'app',
        title: appMeta.title,
        description: appMeta.description,
        publishedAt: appMeta.publishedAt,
        hash: APP_HASH,
      },
      {
        id: FILE_ID,
        kind: 'file',
        title: fileMeta.title,
        description: fileMeta.description,
        publishedAt: fileMeta.publishedAt,
        hash: FILE_HASH,
      },
    ],
  };
  await bucket.put(INDEX_KEY, JSON.stringify(index));

  return { appMeta, fileMeta };
}

function makeEnv(bucket: MemoryBucket, assets: AssetsLike, overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    BUCKET: bucket,
    ASSETS: assets,
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    ACCESS_DISABLED: 'true',
    ...overrides,
  };
}

function req(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://acabox-share.example.workers.dev${path}`, { headers });
}

describe('handleWebRequest — routing (Access disabled)', () => {
  let bucket: MemoryBucket;
  let assets: FakeAssets;
  let env: WebEnv;

  beforeEach(async () => {
    bucket = new MemoryBucket();
    assets = new FakeAssets();
    await seedBucket(bucket);
    env = makeEnv(bucket, assets);
  });

  it('GET / renders the listing with both artifacts, newest first, no-store, and the html security headers', async () => {
    const res = await handleWebRequest(req('/'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    const body = await res.text();
    expect(body).toContain('Shared from Acabox');
    expect(body).toContain('DNA Toolkit');
    expect(body).toContain('results.csv');
    // results.csv was published later than DNA Toolkit -> newest first.
    expect(body.indexOf('results.csv')).toBeLessThan(body.indexOf('DNA Toolkit'));
  });

  it('GET / renders the empty state when index.json is missing', async () => {
    const emptyBucket = new MemoryBucket();
    const res = await handleWebRequest(req('/'), makeEnv(emptyBucket, assets));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Nothing published yet.');
  });

  it('GET / escapes a <script> title read out of a real index.json in the bucket', async () => {
    const evilBucket = new MemoryBucket();
    const index: ShareIndex = {
      updatedAt: '2026-09-01T00:00:00.000Z',
      artifacts: [
        {
          id: APP_ID,
          kind: 'app',
          title: '<script>alert(1)</script>',
          description: null,
          publishedAt: '2026-09-01T00:00:00.000Z',
          hash: APP_HASH,
        },
      ],
    };
    await evilBucket.put(INDEX_KEY, JSON.stringify(index));
    const res = await handleWebRequest(req('/'), makeEnv(evilBucket, assets));
    const body = await res.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('GET /a/:id/ serves viewer.html with no-store and the html security headers, overriding the asset cache-control', async () => {
    const res = await handleWebRequest(req(`/a/${APP_ID}/`), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>viewer shell</html>');
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(assets.requestedPaths).toContain('/viewer.html');
  });

  it('GET /a/:id/ 404s for a malformed id without touching ASSETS', async () => {
    const res = await handleWebRequest(req('/a/BAD ID!/'), env);
    expect(res.status).toBe(404);
    expect(assets.requestedPaths).not.toContain('/viewer.html');
  });

  it('GET /a/:id/meta.json returns the stored ArtifactMeta with no-store', async () => {
    const res = await handleWebRequest(req(`/a/${APP_ID}/meta.json`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const parsed = await res.json();
    expect(parsed).toMatchObject({ id: APP_ID, kind: 'app', title: 'DNA Toolkit' });
  });

  it('GET /a/:id/meta.json 404s with the not-found JSON shape when the id does not exist', async () => {
    const res = await handleWebRequest(req('/a/nosuchid1234567/meta.json'), env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not-found' });
  });

  it('GET /a/:id/meta.json 404s with the same JSON shape for a malformed id', async () => {
    const res = await handleWebRequest(req('/a/x/meta.json'), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
  });

  it('GET /a/:id/v/:hash/w/* serves the versioned object with content-type from stored httpMetadata and immutable caching', async () => {
    const res = await handleWebRequest(
      req(`/a/${APP_ID}/v/${APP_HASH}/w/.applications/dna-toolkit/src/index.html`),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>app</html>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('GET /a/:id/v/:hash/w/* falls back to contentTypeFor() when no httpMetadata content type was stored', async () => {
    const res = await handleWebRequest(
      req(`/a/${APP_ID}/v/${APP_HASH}/w/.applications/dna-toolkit/dist/bundle.js`),
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  });

  it('GET /a/:id/v/:hash/w/* 404s for a missing file', async () => {
    const res = await handleWebRequest(req(`/a/${APP_ID}/v/${APP_HASH}/w/does/not/exist.js`), env);
    expect(res.status).toBe(404);
  });

  it('GET /a/:id/v/:hash/w/* 404s a path containing .. segments rather than serving anything outside the version prefix', async () => {
    // The WHATWG URL parser itself collapses unencoded ".." segments before
    // this handler ever sees the path (verified: this exact path parses to
    // pathname "/a/<id>/v/etc/passwd", which matches none of the route
    // patterns), so this ends up 404ing via the catch-all rather than via
    // normalizeSnapshotPath. The percent-encoded case right below is the one
    // that actually exercises normalizeSnapshotPath's own traversal check.
    const res = await handleWebRequest(
      req(`/a/${APP_ID}/v/${APP_HASH}/w/.applications/../../../etc/passwd`),
      env
    );
    expect(res.status).toBe(404);
  });

  it('GET /a/:id/v/:hash/w/* refuses a percent-encoded .. segment via normalizeSnapshotPath', async () => {
    const res = await handleWebRequest(
      req(`/a/${APP_ID}/v/${APP_HASH}/w/.applications%2f..%2f..%2fetc%2fpasswd`),
      env
    );
    expect(res.status).toBe(404);
  });

  it('GET /a/:id/v/:hash/w/* 404s for a malformed hash', async () => {
    const res = await handleWebRequest(
      req(`/a/${APP_ID}/v/not-a-hash/w/.applications/dna-toolkit/src/index.html`),
      env
    );
    expect(res.status).toBe(404);
  });

  it('GET /f/:id/ redirects to the versioned entry file with no-store', async () => {
    const res = await handleWebRequest(req(`/f/${FILE_ID}/`), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/f/${FILE_ID}/v/${FILE_HASH}/results.csv`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /f/:id/ 404s when the meta is missing', async () => {
    const res = await handleWebRequest(req('/f/nosuchid1234567/'), env);
    expect(res.status).toBe(404);
  });

  it('GET /f/:id/v/:hash/:name serves the file inline with immutable caching', async () => {
    const res = await handleWebRequest(req(`/f/${FILE_ID}/v/${FILE_HASH}/results.csv`), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('a,b,c\n1,2,3\n');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('GET /f/:id/v/:hash/:name refuses a .. traversal segment', async () => {
    const res = await handleWebRequest(req(`/f/${FILE_ID}/v/${FILE_HASH}/..%2f..%2fsecret`), env);
    expect(res.status).toBe(404);
  });

  it('GET /f/:id/v/:hash/:name 404s for a missing name', async () => {
    const res = await handleWebRequest(req(`/f/${FILE_ID}/v/${FILE_HASH}/nope.csv`), env);
    expect(res.status).toBe(404);
  });

  it('GET /viewer.js and /viewer.css pass through to ASSETS with no-store, not the html security headers', async () => {
    const jsRes = await handleWebRequest(req('/viewer.js'), env);
    expect(jsRes.status).toBe(200);
    expect(await jsRes.text()).toBe('console.log("viewer");');
    expect(jsRes.headers.get('cache-control')).toBe('no-store');
    expect(jsRes.headers.get('x-content-type-options')).toBeNull();

    const cssRes = await handleWebRequest(req('/viewer.css'), env);
    expect(cssRes.status).toBe(200);
    expect(await cssRes.text()).toBe('body { margin: 0; }');
    expect(cssRes.headers.get('cache-control')).toBe('no-store');
  });

  it('404s any unmatched path', async () => {
    const res = await handleWebRequest(req('/this/route/does/not/exist'), env);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Auth gate — real RS256 tokens, signed and verified with globalThis.crypto.
// Helpers reproduced from accessJwt.test.ts (not exported there, and that
// file is owned by another ticket, so it is not modified here).
// ---------------------------------------------------------------------------

const subtle = globalThis.crypto.subtle;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  ) as Promise<CryptoKeyPair>;
}

async function jwkFor(publicKey: CryptoKey, kid: string): Promise<Jwks['keys'][number]> {
  const jwk = await subtle.exportKey('jwk', publicKey);
  return { kid, kty: jwk.kty as string, n: jwk.n as string, e: jwk.e as string, alg: 'RS256' };
}

async function signToken(header: unknown, payload: unknown, privateKey: CryptoKey): Promise<string> {
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return { aud: [AUD], iss: ISSUER, exp: nowSeconds + 3600, email: 'ilias@academia.edu', ...overrides };
}

/** A fake jwksCache whose `get()`/`invalidate()` are individually controllable, for the retry test. */
function makeControllableJwksCache(sequence: Jwks[]): {
  get: jest.Mock<Promise<Jwks>, []>;
  invalidate: jest.Mock<void, []>;
} {
  let index = 0;
  const get = jest.fn(async () => sequence[Math.min(index, sequence.length - 1)]);
  const invalidate = jest.fn(() => {
    index += 1;
  });
  return { get, invalidate };
}

describe('handleWebRequest — auth gate (Access enabled)', () => {
  let bucket: MemoryBucket;
  let assets: FakeAssets;
  let keyPair: CryptoKeyPair;

  beforeAll(async () => {
    keyPair = await generateKeyPair();
  });

  beforeEach(async () => {
    bucket = new MemoryBucket();
    assets = new FakeAssets();
    await seedBucket(bucket);
  });

  function envWithoutAccessDisabled(): WebEnv {
    return { BUCKET: bucket, ASSETS: assets, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };
  }

  it('401s with "Sign in required" when no token is present', async () => {
    const res = await handleWebRequest(req('/'), envWithoutAccessDisabled());
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Sign in required');
  });

  it('503s (still closed) when the signing keys cannot be fetched, instead of a raw 500', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, validPayload(), keyPair.privateKey);
    const get = jest.fn(async () => { throw new Error('certs endpoint unreachable'); });
    const invalidate = jest.fn();

    const res = await handleWebRequest(req('/', { 'Cf-Access-Jwt-Assertion': token }), envWithoutAccessDisabled(), {
      jwksCache: { get, invalidate },
    });

    expect(res.status).toBe(503);
    expect(await res.text()).toBe('Could not verify sign-in. Try again in a moment.');
  });

  it('a validly signed token passes and reaches routing', async () => {
    const jwk = await jwkFor(keyPair.publicKey, 'kid-1');
    const jwks: Jwks = { keys: [jwk] };
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, validPayload(), keyPair.privateKey);

    const get = jest.fn(async () => jwks);
    const invalidate = jest.fn();

    const res = await handleWebRequest(req('/', { 'Cf-Access-Jwt-Assertion': token }), envWithoutAccessDisabled(), {
      jwksCache: { get, invalidate },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Shared from Acabox');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('403s a token signed by a different key than the one in the JWKS', async () => {
    const jwk = await jwkFor(keyPair.publicKey, 'kid-1');
    const jwks: Jwks = { keys: [jwk] };
    const otherKeyPair = await generateKeyPair();
    // Same kid, wrong private key -> signature check fails (not "unknown kid").
    const token = await signToken({ alg: 'RS256', kid: 'kid-1' }, validPayload(), otherKeyPair.privateKey);

    const get = jest.fn(async () => jwks);
    const invalidate = jest.fn();

    const res = await handleWebRequest(req('/', { 'Cf-Access-Jwt-Assertion': token }), envWithoutAccessDisabled(), {
      jwksCache: { get, invalidate },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/signature/i);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('on an unknown key id, invalidates the cache exactly once and succeeds once the refreshed JWKS has the key', async () => {
    const jwk = await jwkFor(keyPair.publicKey, 'kid-current');
    const staleJwks: Jwks = { keys: [] };
    const freshJwks: Jwks = { keys: [jwk] };
    const token = await signToken({ alg: 'RS256', kid: 'kid-current' }, validPayload(), keyPair.privateKey);

    const jwksCache = makeControllableJwksCache([staleJwks, freshJwks]);

    const res = await handleWebRequest(req('/', { 'Cf-Access-Jwt-Assertion': token }), envWithoutAccessDisabled(), {
      jwksCache,
    });

    expect(res.status).toBe(200);
    expect(jwksCache.invalidate).toHaveBeenCalledTimes(1);
    expect(jwksCache.get).toHaveBeenCalledTimes(2);
  });

  it('still 403s when the key remains unknown after the retry', async () => {
    const staleJwks: Jwks = { keys: [] };
    const token = await signToken({ alg: 'RS256', kid: 'kid-never-found' }, validPayload(), keyPair.privateKey);

    const jwksCache = makeControllableJwksCache([staleJwks, staleJwks]);

    const res = await handleWebRequest(req('/', { 'Cf-Access-Jwt-Assertion': token }), envWithoutAccessDisabled(), {
      jwksCache,
    });

    expect(res.status).toBe(403);
    expect(jwksCache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('only the literal string "true" bypasses auth — ACCESS_DISABLED: "false" still requires a token', async () => {
    const env: WebEnv = { ...envWithoutAccessDisabled(), ACCESS_DISABLED: 'false' };
    const res = await handleWebRequest(req('/'), env);
    expect(res.status).toBe(401);
  });
});
