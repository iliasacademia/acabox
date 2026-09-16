/**
 * App publisher + status for the sharing feature: orchestrates
 * hash -> stage -> upload -> commit against a `ShareApi` (M4), and answers
 * "is the shared copy behind the workspace" with no network call at all.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * — this file implements ticket M5 (contracts C1-C4).
 *
 * ELECTRON-FREE: no `electron`, no `electron-log`. Only `fs.promises`, `os`,
 * `path` and `crypto`, so this runs unmodified under plain Jest.
 *
 * WHY THE UNCHANGED CHECK COMES BEFORE ANY STAGING
 * --------------------------------------------------
 * `listSnapshotSources` + `hashSnapshotSources` (M1) are the only work needed
 * to know whether the workspace has drifted from what's already published. If
 * it hasn't, there is nothing to stage, upload or commit — `publishApp`
 * returns the existing `PublishedInfo` untouched and makes zero `ShareApi`
 * calls. This is also why no staging directory is created in that branch:
 * there would be nothing to put in it.
 *
 * WHY BYTES, NEVER A STREAM
 * --------------------------
 * Per the ticket, each staged file is read in full via `fs.promises.readFile`
 * and handed to `api.putFile` as a `Uint8Array`. `ShareApiClient.request`
 * only retries a body it can resend, and a `ReadableStream` can be consumed
 * exactly once (see its own header) — so a stream body silently disables
 * retries for exactly the requests most likely to hit a transient network
 * blip (many small PUTs in a row). Buffering here keeps every upload
 * retryable.
 *
 * BOUNDED CONCURRENCY
 * --------------------
 * `runPool` is a minimal worker-pool: `concurrency` loops each pull the next
 * staged file off a shared cursor until none remain. If any upload throws,
 * that loop's promise rejects and `Promise.all` propagates it — other loops
 * already in flight are not cancelled (nothing here needs them to be; the
 * `finally` block below reclaims the staging directory regardless of how
 * uploading ended).
 *
 * `onProgress` fires once per file, immediately after that file's own upload
 * resolves — so with `concurrency > 1` the reported `uploaded` count can
 * "jump" as several finish close together, but it always ends at
 * `{ uploaded: total, total }` once every upload has settled successfully.
 *
 * WHY THE STAGING DIR IS ALWAYS RECLAIMED
 * ------------------------------------------
 * `stageSnapshot` (M3) never creates or deletes `stagingDir` itself — the
 * caller owns its lifecycle. This module creates it right before staging and
 * removes it in a `finally`, so a failure partway through upload or commit
 * never leaves a snapshot's worth of copied files (including a rewritten
 * `dist/bundle.js`, which embeds this publish's id and hash) sitting in the
 * OS temp directory.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ArtifactMeta, PublishedInfo, SnapshotFile, SnapshotSummary } from '../../shared/share';
import { artifactUrl, mintShareId, summarizeSnapshot } from '../../shared/share';
import type { ShareApi } from './shareApiClient';
import { hashSnapshotSources, listSnapshotSources } from './snapshotSources';
import { stageSnapshot } from './stageSnapshot';

export interface PublishAppInput {
  workspaceRoot: string;
  dirName: string;
  includeInput: boolean;
  siteUrl: string;
  title: string;
  description: string | null;
  /** Reuse its id when present. */
  existing: PublishedInfo | null;
  /** Default `os.tmpdir()`. */
  stagingRoot?: string;
  /** Default 4. */
  concurrency?: number;
  onProgress?: (p: { uploaded: number; total: number }) => void;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Runs `worker` over `items` with at most `concurrency` in flight at once.
 * Each of `concurrency` loops claims the next index off a shared cursor
 * until the items are exhausted. If `worker` throws for any item, that loop's
 * promise rejects and propagates out of `Promise.all` — loops already running
 * are not aborted.
 */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const loops: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    loops.push(
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          await worker(items[index]);
        }
      })(),
    );
  }
  await Promise.all(loops);
}

/**
 * Orchestrates a full publish: hash the current workspace snapshot, compare
 * against `existing`, and if it has changed, stage it, upload every staged
 * file, then commit the artifact's metadata. Returns `unchanged: true` (with
 * no `ShareApi` calls at all) when the hash matches `existing.hash`.
 */
export async function publishApp(
  api: ShareApi,
  input: PublishAppInput,
): Promise<{ published: PublishedInfo; unchanged: boolean }> {
  const {
    workspaceRoot,
    dirName,
    includeInput,
    siteUrl,
    title,
    description,
    existing,
    stagingRoot,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress,
  } = input;

  const sources = await listSnapshotSources({ workspaceRoot, dirName, includeInput });
  const { hash, files } = await hashSnapshotSources(sources);

  if (existing && existing.hash === hash) {
    return { published: existing, unchanged: true };
  }

  const id = existing?.id ?? mintShareId();
  const stagingDir = path.join(stagingRoot ?? os.tmpdir(), `acabox-share-${randomUUID()}`);
  await fs.promises.mkdir(stagingDir, { recursive: true });

  try {
    const staged = await stageSnapshot({ sources, dirName, kind: 'app', id, hash, stagingDir });

    const total = staged.length;
    let uploaded = 0;
    await runPool(staged, concurrency, async (file) => {
      const body = await fs.promises.readFile(file.absPath);
      await api.putFile('app', id, hash, file.snapshotPath, body, file.contentType);
      uploaded += 1;
      onProgress?.({ uploaded, total });
    });

    const publishedAt = new Date().toISOString();
    const meta: ArtifactMeta = {
      id,
      kind: 'app',
      title,
      description,
      hash,
      publishedAt,
      entry: `.applications/${dirName}/src/index.html`,
      dirName,
      files,
    };
    await api.commit(meta);

    const published: PublishedInfo = {
      id,
      kind: 'app',
      url: artifactUrl(siteUrl, 'app', id),
      hash,
      publishedAt,
      includeInput,
    };
    return { published, unchanged: false };
  } finally {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Hashes the current workspace snapshot and reports whether it differs from
 * `existing` — no staging, no network. Used to render "up to date" / "N files
 * changed since you last shared this" without a full publish.
 */
export async function computeAppStatus(input: {
  workspaceRoot: string;
  dirName: string;
  includeInput: boolean;
  existing: PublishedInfo | null;
}): Promise<{ hash: string; behind: boolean; summary: SnapshotSummary; files: SnapshotFile[] }> {
  const { workspaceRoot, dirName, includeInput, existing } = input;
  const sources = await listSnapshotSources({ workspaceRoot, dirName, includeInput });
  const { hash, files } = await hashSnapshotSources(sources);
  const behind = existing !== null && existing.hash !== hash;
  const summary = summarizeSnapshot(files, dirName);
  return { hash, behind, summary, files };
}

/** Deletes the published app's artifact (all versions + its meta/index entry). */
export async function unpublishApp(api: ShareApi, existing: PublishedInfo): Promise<void> {
  await api.remove('app', existing.id);
}
