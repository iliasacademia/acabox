/**
 * Route handling for `acabox-share-api` — contract C4 in
 * `docs/design/sharing-tickets.md`. This is the one mutable surface of the
 * sharing feature (the sibling `acabox-share` Worker is read-only behind
 * Cloudflare Access), so every route — including `/v1/health` — requires the
 * publish bearer token, compared in constant time.
 *
 * Worker runtime only: no Node imports, no `Buffer`. `Request`/`Response`/
 * `URL`/`ReadableStream` come from the tsconfig's ES2020+DOM lib, which is
 * the same surface the real Workers runtime exposes.
 */

import type { ApiEnv, BucketLike } from '../../shared/bucket';
import {
  contentTypeFor,
  isValidHash,
  isValidShareId,
  kindPrefix,
  metaKey,
  normalizeSnapshotPath,
  versionPrefix,
  INDEX_KEY,
  type ArtifactMeta,
  type ShareIndex,
  type ShareIndexEntry,
  type ShareKind,
} from '../../../cobuilding/shared/share';

/** R2's own per-call delete cap; also used as the list page size. */
const BATCH_SIZE = 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(status: number, error: string): Response {
  return jsonResponse({ error }, status);
}

function isShareKind(value: string): value is ShareKind {
  return value === 'app' || value === 'file';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Length check plus XOR-accumulate over char codes — every byte is examined
 * regardless of where (or whether) a mismatch occurs, so a wrong token takes
 * the same time to reject as a right one.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(request: Request, env: ApiEnv): boolean {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  // Fail closed: a Worker deployed without the secret must refuse everything,
  // not throw on `undefined.length` and surface as a 500.
  if (typeof env.PUBLISH_TOKEN !== 'string' || env.PUBLISH_TOKEN.length === 0) return false;
  return timingSafeEqual(token, env.PUBLISH_TOKEN);
}

/**
 * The `*` tail arrives as individually percent-encoded segments (real `/`
 * characters are the separators; a literal space inside one component is
 * `%20`). Decode each segment on its own — never the joined string — so a
 * `..` produced only by decoding still can't hide from `normalizeSnapshotPath`.
 */
function decodeTail(rawSegments: string[]): string | null {
  const decoded: string[] = [];
  for (const segment of rawSegments) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return normalizeSnapshotPath(decoded.join('/'));
}

async function listAllKeys(bucket: BucketLike, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: BATCH_SIZE });
    for (const obj of page.objects) keys.push(obj.key);
    if (!page.truncated || page.cursor === undefined) break;
    cursor = page.cursor;
  }
  return keys;
}

async function deleteKeys(bucket: BucketLike, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    if (batch.length > 0) await bucket.delete(batch);
  }
}

async function readIndex(bucket: BucketLike): Promise<ShareIndex> {
  const obj = await bucket.get(INDEX_KEY);
  if (!obj) return { updatedAt: new Date().toISOString(), artifacts: [] };
  try {
    const parsed = JSON.parse(await obj.text()) as ShareIndex;
    if (!Array.isArray(parsed.artifacts)) return { updatedAt: new Date().toISOString(), artifacts: [] };
    return parsed;
  } catch {
    return { updatedAt: new Date().toISOString(), artifacts: [] };
  }
}

async function writeIndex(bucket: BucketLike, index: ShareIndex): Promise<void> {
  await bucket.put(INDEX_KEY, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

async function handleHealth(): Promise<Response> {
  return jsonResponse({ ok: true });
}

async function handleListArtifacts(env: ApiEnv): Promise<Response> {
  return jsonResponse(await readIndex(env.BUCKET));
}

async function handleGetArtifact(env: ApiEnv, kind: ShareKind, id: string): Promise<Response> {
  const obj = await env.BUCKET.get(metaKey(kind, id));
  if (!obj) return errorResponse(404, 'not-found');
  // Pass the stored bytes straight through rather than re-parsing/re-stringifying —
  // what comes back is exactly what was committed.
  return new Response(await obj.text(), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handlePutFile(
  request: Request,
  env: ApiEnv,
  kind: ShareKind,
  id: string,
  hash: string,
  rawTailSegments: string[]
): Promise<Response> {
  const rel = decodeTail(rawTailSegments);
  if (rel === null) return errorResponse(400, 'invalid-path');

  const key = versionPrefix(kind, id, hash) + rel;
  const contentType = request.headers.get('content-type') ?? contentTypeFor(rel);
  await env.BUCKET.put(key, request.body ?? new Uint8Array(0), {
    httpMetadata: { contentType },
  });
  return jsonResponse({ ok: true, key });
}

/**
 * A commit supersedes the previous version wholesale: every object under
 * `<kind>/<id>/v/` whose version segment is not `keepHash` is deleted, paged
 * and batched so an app with thousands of files can't exceed R2's per-call
 * delete limit.
 */
async function deleteStaleVersions(bucket: BucketLike, kind: ShareKind, id: string, keepHash: string): Promise<void> {
  const versionsPrefix = `${kindPrefix(kind)}/${id}/v/`;
  const keepPrefix = `${versionsPrefix}${keepHash}/`;
  const allKeys = await listAllKeys(bucket, versionsPrefix);
  const stale = allKeys.filter((key) => !key.startsWith(keepPrefix));
  await deleteKeys(bucket, stale);
}

/**
 * Only the fields the contract requires are validated (id/kind match the
 * URL, a well-formed hash, a non-empty entry, an array of files) — title,
 * description, publishedAt and dirName are the caller's business and are
 * defaulted, not rejected, if absent.
 */
function isValidArtifactMetaBody(body: unknown, kind: ShareKind, id: string): body is ArtifactMeta {
  if (!isPlainObject(body)) return false;
  const { kind: bodyKind, id: bodyId, hash, entry, files } = body;
  if (bodyKind !== kind) return false;
  if (bodyId !== id) return false;
  if (typeof hash !== 'string' || !isValidHash(hash)) return false;
  if (typeof entry !== 'string' || entry.length === 0) return false;
  if (!Array.isArray(files)) return false;
  return true;
}

async function handlePutMeta(request: Request, env: ApiEnv, kind: ShareKind, id: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'invalid-json');
  }

  if (!isValidArtifactMetaBody(body, kind, id)) {
    return errorResponse(400, 'invalid-meta');
  }
  const meta = body;

  await env.BUCKET.put(metaKey(kind, id), JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  const index = await readIndex(env.BUCKET);
  const entry: ShareIndexEntry = {
    id: meta.id,
    kind: meta.kind,
    title: typeof meta.title === 'string' ? meta.title : '',
    description: meta.description ?? null,
    publishedAt: typeof meta.publishedAt === 'string' ? meta.publishedAt : new Date().toISOString(),
    hash: meta.hash,
  };
  const rest = index.artifacts.filter((a) => !(a.id === id && a.kind === kind));
  const artifacts = [...rest, entry].sort((a, b) =>
    a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0
  );
  await writeIndex(env.BUCKET, { updatedAt: new Date().toISOString(), artifacts });

  await deleteStaleVersions(env.BUCKET, kind, id, meta.hash);

  return jsonResponse({ ok: true });
}

async function handleDeleteArtifact(env: ApiEnv, kind: ShareKind, id: string): Promise<Response> {
  const idPrefix = `${kindPrefix(kind)}/${id}/`;
  const keys = await listAllKeys(env.BUCKET, idPrefix);
  await deleteKeys(env.BUCKET, keys);

  const index = await readIndex(env.BUCKET);
  const artifacts = index.artifacts.filter((a) => !(a.id === id && a.kind === kind));
  if (artifacts.length !== index.artifacts.length) {
    await writeIndex(env.BUCKET, { updatedAt: new Date().toISOString(), artifacts });
  }

  // 200 even when nothing existed — deleting an already-absent id is not an error.
  return jsonResponse({ ok: true });
}

export async function handleApiRequest(request: Request, env: ApiEnv): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return errorResponse(401, 'unauthorized');
  }

  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter((s) => s.length > 0);

  if (segments.length === 2 && segments[0] === 'v1' && segments[1] === 'health') {
    if (request.method !== 'GET') return errorResponse(404, 'not-found');
    return handleHealth();
  }

  if (segments.length === 2 && segments[0] === 'v1' && segments[1] === 'artifacts') {
    if (request.method !== 'GET') return errorResponse(404, 'not-found');
    return handleListArtifacts(env);
  }

  if (segments.length >= 4 && segments[0] === 'v1' && segments[1] === 'artifacts') {
    const kindRaw = segments[2];
    if (!isShareKind(kindRaw)) return errorResponse(404, 'not-found');
    const kind = kindRaw;
    const id = segments[3];

    if (segments.length === 4) {
      if (!isValidShareId(id)) return errorResponse(400, 'invalid-id');
      if (request.method === 'GET') return handleGetArtifact(env, kind, id);
      if (request.method === 'PUT') return handlePutMeta(request, env, kind, id);
      if (request.method === 'DELETE') return handleDeleteArtifact(env, kind, id);
      return errorResponse(404, 'not-found');
    }

    if (segments.length >= 6 && segments[4] === 'v') {
      if (request.method !== 'PUT') return errorResponse(404, 'not-found');
      if (!isValidShareId(id)) return errorResponse(400, 'invalid-id');
      const hash = segments[5];
      if (!isValidHash(hash)) return errorResponse(400, 'invalid-hash');
      return handlePutFile(request, env, kind, id, hash, segments.slice(6));
    }
  }

  return errorResponse(404, 'not-found');
}
