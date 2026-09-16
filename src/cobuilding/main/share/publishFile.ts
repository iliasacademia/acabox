/**
 * Publish / status / unpublish for a single shared workspace *file* — the
 * `file` counterpart to the app publisher (M5). A file has no manifest, no
 * `.applications/<dir>` tree, and no `local-file://` rewrite: it is one blob,
 * uploaded once and committed with a one-entry `ArtifactMeta`.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * — this file implements ticket M6 (contracts C1, C2, C4).
 *
 * ELECTRON-FREE: no `electron`, no `electron-log`. Only `fs`, `path` and
 * `crypto`, plus the `ShareApi` interface passed in by the caller — so this
 * runs unmodified under plain Jest and the caller (main, via `shareStore.ts`
 * and the M9 IPC handlers) is the only place a real `ShareApiClient` is
 * constructed.
 *
 * WHY THE SIZE CHECK RUNS BEFORE THE HASH
 * ----------------------------------------
 * `fs.promises.stat` is cheap; streaming sha256 over a rejected 300 MB file
 * is not. Checking the cheap thing first also means an oversize file makes
 * **zero** filesystem reads of its content and, more importantly, zero calls
 * into `api` — Workers request bodies are capped well under that size, so
 * there is no point letting a doomed upload start.
 *
 * WHY BYTES, NEVER A STREAM
 * --------------------------
 * `ShareApiClient.putFile` retries network errors, 429s and 5xx with
 * backoff (see that file's header) by re-issuing the same `fetch` call. A
 * `ReadableStream` from `fs.createReadStream` can only be consumed once — a
 * retry after a partial read would send a truncated body with no error. A
 * plain `Uint8Array` has no such state; `fetch` can read it again on every
 * attempt. Files this small (capped at `MAX_SHARED_FILE_BYTES`) cost nothing
 * to hold in memory once, unlike an app's `dist/bundle.js` which is streamed
 * elsewhere for exactly the reason a single file is not here.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactMeta, PublishedInfo } from '../../shared/share';
import { artifactUrl, contentTypeFor, mintShareId } from '../../shared/share';
import type { ShareApi } from './shareApiClient';

/** Workers request bodies are capped well under this; see the header. */
export const MAX_SHARED_FILE_BYTES = 100 * 1024 * 1024;

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Streamed sha256 hex of a file's bytes, plus its size (both from the same read — no separate `stat`). */
export function hashFile(absPath: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      size += buf.length;
    });
    stream.on('end', () => resolve({ hash: hash.digest('hex'), size }));
    stream.on('error', reject);
  });
}

export interface PublishFileInput {
  absPath: string;
  siteUrl: string;
  existing: PublishedInfo | null;
  title?: string;
}

/**
 * Refuses over `MAX_SHARED_FILE_BYTES` before any API call. Returns
 * `unchanged: true` (zero API calls) when the file's current hash matches
 * `existing.hash` — republishing an untouched file is a no-op, not a
 * re-upload. Otherwise uploads the bytes and commits `ArtifactMeta`, reusing
 * `existing.id` when there is one so the URL never changes across a refresh.
 */
export async function publishFile(api: ShareApi, input: PublishFileInput): Promise<{ published: PublishedInfo; unchanged: boolean }> {
  const { absPath, siteUrl, existing, title } = input;

  const stat = await fs.promises.stat(absPath);
  if (stat.size > MAX_SHARED_FILE_BYTES) {
    throw new Error(
      `"${path.basename(absPath)}" is ${formatMiB(stat.size)}, over the ${formatMiB(MAX_SHARED_FILE_BYTES)} sharing limit.`,
    );
  }

  const { hash, size } = await hashFile(absPath);

  if (existing && existing.hash === hash) {
    return { published: existing, unchanged: true };
  }

  const id = existing?.id ?? mintShareId();
  const basename = path.basename(absPath);
  const contentType = contentTypeFor(basename);

  const buffer = await fs.promises.readFile(absPath);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  await api.putFile('file', id, hash, basename, bytes, contentType);

  const publishedAt = new Date().toISOString();
  const meta: ArtifactMeta = {
    id,
    kind: 'file',
    title: title ?? basename,
    description: null,
    hash,
    publishedAt,
    entry: basename,
    files: [{ path: basename, size, sha256: hash }],
  };
  await api.commit(meta);

  const published: PublishedInfo = {
    id,
    kind: 'file',
    url: artifactUrl(siteUrl, 'file', id),
    hash,
    publishedAt,
  };

  return { published, unchanged: false };
}

/**
 * No network: `behind` is a pure comparison against the hash computed just
 * now, per the same rule `computeAppStatus` (M5) uses —
 * `existing !== null && existing.hash !== hash`. An unpublished file
 * (`existing === null`) is never "behind"; that is a different, unpublished
 * state.
 */
export async function computeFileStatus(input: { absPath: string; existing: PublishedInfo | null }): Promise<{ hash: string; behind: boolean }> {
  const { hash } = await hashFile(input.absPath);
  const behind = input.existing !== null && input.existing.hash !== hash;
  return { hash, behind };
}

export async function unpublishFile(api: ShareApi, existing: PublishedInfo): Promise<void> {
  await api.remove('file', existing.id);
}
