/**
 * Routing for `acabox-share` (the public site) — contract C5 in
 * `docs/design/sharing-tickets.md`. Runs inside a Cloudflare Worker: no Node
 * imports, no `Buffer`, only `fetch`/`Request`/`Response`/`Headers`/`URL` and
 * whatever `WebEnv` hands in (`BUCKET`, `ASSETS`).
 *
 * Every route is gated by a valid Cloudflare Access JWT first (see
 * `accessJwt.ts`), unless `env.ACCESS_DISABLED === 'true'` (local `wrangler
 * dev` only). The "unknown key id" reason is special: it means the JWKS cache
 * is stale (key rotation), not that the request is unauthenticated, so it
 * gets exactly one invalidate-and-retry before failing for real — see the
 * header comment on `verifyAccessJwt` in `accessJwt.ts`.
 */

import type { AssetsLike, BucketLike, BucketObject, WebEnv } from '../../shared/bucket';
import {
  type ArtifactMeta,
  type ShareIndex,
  INDEX_KEY,
  contentTypeFor,
  isValidHash,
  isValidShareId,
  metaKey,
  normalizeSnapshotPath,
  versionPrefix,
} from '../../../cobuilding/shared/share';
import { createJwksCache, extractAccessToken, verifyAccessJwt, type Jwks } from './accessJwt';
import { renderListing } from './listingPage';

export interface HandleWebRequestDeps {
  jwksCache?: { get(): Promise<Jwks>; invalidate(): void };
  nowSeconds?: () => number;
}

const NO_STORE = 'no-store';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function textResponse(body: string, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': NO_STORE,
      ...extraHeaders,
    },
  });
}

function plainNotFound(): Response {
  return textResponse('Not found', 404);
}

function jsonNotFound(): Response {
  return new Response(JSON.stringify({ error: 'not-found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * Wraps an object read from R2 as a `Response`. Content type prefers the
 * object's own stored `httpMetadata.contentType` (set by the api Worker at
 * publish time) and falls back to a guess from the key's extension — the
 * fallback is what covers a bucket populated by hand or by an older writer.
 */
function bucketObjectResponse(
  obj: BucketObject,
  key: string,
  cacheControl: string,
  extraHeaders?: Record<string, string>
): Response {
  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType ?? contentTypeFor(key));
  headers.set('cache-control', cacheControl);
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  }
  return new Response(obj.body, { status: 200, headers });
}

/**
 * Forwards a request to the `ASSETS` binding and returns a NEW `Response`
 * with our own cache-control (and, for HTML, the two security headers) —
 * the real Assets binding hands back a `Response` whose headers are
 * immutable, so overriding cache-control means copying into a fresh
 * `Headers` object rather than mutating the one we got back.
 */
async function assetResponse(request: Request, assets: AssetsLike, opts: { isHtml: boolean }): Promise<Response> {
  const upstream = await assets.fetch(request);
  const headers = new Headers(upstream.headers);
  headers.set('cache-control', NO_STORE);
  if (opts.isHtml) {
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/**
 * A `*` tail arrives as one or more `/`-joined, percent-encoded segments
 * (mirrors the api Worker's own PUT route, W2). Decode each segment on its
 * own — a segment can legitimately contain an encoded `/` or `%` — then hand
 * the joined, decoded string to `normalizeSnapshotPath` for the real
 * traversal check.
 */
function decodeTail(tail: string): string {
  return tail
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

async function loadIndex(bucket: BucketLike): Promise<ShareIndex> {
  const obj = await bucket.get(INDEX_KEY);
  if (!obj) {
    return { updatedAt: new Date(0).toISOString(), artifacts: [] };
  }
  try {
    const parsed = JSON.parse(await obj.text()) as ShareIndex;
    if (!parsed || !Array.isArray(parsed.artifacts)) {
      return { updatedAt: new Date(0).toISOString(), artifacts: [] };
    }
    return parsed;
  } catch {
    // A corrupt index.json shouldn't take the whole listing page down —
    // treat it the same as "nothing published yet".
    return { updatedAt: new Date(0).toISOString(), artifacts: [] };
  }
}

/**
 * Auth gate shared by every route. `env.ACCESS_DISABLED === 'true'` skips it
 * entirely (local `wrangler dev`, per the README). Otherwise: no token is a
 * plain 401 (nothing to blame the caller's credentials for — they sent
 * none); a token that fails verification is a 403 naming the reason, except
 * "Unknown key id", which gets one invalidate-and-retry first since it means
 * the cached JWKS is stale, not that the token is bad.
 */
async function authorize(
  request: Request,
  env: WebEnv,
  deps?: HandleWebRequestDeps
): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (env.ACCESS_DISABLED === 'true') {
    return { ok: true };
  }

  const token = extractAccessToken(request);
  if (!token) {
    return { ok: false, response: textResponse('Sign in required', 401) };
  }

  const jwksCache = deps?.jwksCache ?? createJwksCache(fetch, env.ACCESS_TEAM_DOMAIN);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const nowSeconds = deps?.nowSeconds?.();

  // A failure to fetch the team's signing keys is not the viewer's fault and
  // not a verdict on their token: refuse with a retryable 503 rather than let
  // the exception surface as an opaque 500. Still closed — nothing is served.
  let result;
  try {
    let jwks = await jwksCache.get();
    result = await verifyAccessJwt(token, { jwks, aud: env.ACCESS_AUD, issuer, nowSeconds });

    if (!result.ok && result.reason === 'Unknown key id') {
      jwksCache.invalidate();
      jwks = await jwksCache.get();
      result = await verifyAccessJwt(token, { jwks, aud: env.ACCESS_AUD, issuer, nowSeconds });
    }
  } catch {
    return { ok: false, response: textResponse('Could not verify sign-in. Try again in a moment.', 503) };
  }

  if (!result.ok) {
    return { ok: false, response: textResponse(result.reason, 403) };
  }

  return { ok: true };
}

export async function handleWebRequest(
  request: Request,
  env: WebEnv,
  deps?: HandleWebRequestDeps
): Promise<Response> {
  const auth = await authorize(request, env, deps);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/') {
    const index = await loadIndex(env.BUCKET);
    return htmlResponse(renderListing(index));
  }

  if (path === '/viewer.js' || path === '/viewer.css') {
    return assetResponse(request, env.ASSETS, { isHtml: false });
  }

  const appMetaMatch = /^\/a\/([^/]+)\/meta\.json$/.exec(path);
  if (appMetaMatch) {
    const id = appMetaMatch[1];
    if (!isValidShareId(id)) return jsonNotFound();
    const key = metaKey('app', id);
    const obj = await env.BUCKET.get(key);
    if (!obj) return jsonNotFound();
    return bucketObjectResponse(obj, key, NO_STORE);
  }

  const appAssetMatch = /^\/a\/([^/]+)\/v\/([^/]+)\/w\/(.*)$/.exec(path);
  if (appAssetMatch) {
    const [, id, hash, rawTail] = appAssetMatch;
    if (!isValidShareId(id) || !isValidHash(hash)) return plainNotFound();
    const rel = normalizeSnapshotPath(decodeTail(rawTail));
    if (!rel) return plainNotFound();
    const key = `${versionPrefix('app', id, hash)}w/${rel}`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return plainNotFound();
    return bucketObjectResponse(obj, rel, IMMUTABLE);
  }

  const appShellMatch = /^\/a\/([^/]+)\/$/.exec(path);
  if (appShellMatch) {
    const id = appShellMatch[1];
    if (!isValidShareId(id)) return plainNotFound();
    const viewerRequest = new Request(new URL('/viewer.html', request.url));
    return assetResponse(viewerRequest, env.ASSETS, { isHtml: true });
  }

  const fileAssetMatch = /^\/f\/([^/]+)\/v\/([^/]+)\/([^/]+)$/.exec(path);
  if (fileAssetMatch) {
    const [, id, hash, rawName] = fileAssetMatch;
    if (!isValidShareId(id) || !isValidHash(hash)) return plainNotFound();
    const name = normalizeSnapshotPath(decodeTail(rawName));
    if (!name) return plainNotFound();
    const key = `${versionPrefix('file', id, hash)}${name}`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return plainNotFound();
    return bucketObjectResponse(obj, name, IMMUTABLE, { 'content-disposition': 'inline' });
  }

  const fileShellMatch = /^\/f\/([^/]+)\/$/.exec(path);
  if (fileShellMatch) {
    const id = fileShellMatch[1];
    if (!isValidShareId(id)) return plainNotFound();
    const metaObj = await env.BUCKET.get(metaKey('file', id));
    if (!metaObj) return plainNotFound();
    let meta: ArtifactMeta;
    try {
      meta = JSON.parse(await metaObj.text()) as ArtifactMeta;
    } catch {
      return plainNotFound();
    }
    const location = `/f/${id}/v/${meta.hash}/${encodeURIComponent(meta.entry)}`;
    return new Response(null, { status: 302, headers: { Location: location, 'cache-control': NO_STORE } });
  }

  return plainNotFound();
}
