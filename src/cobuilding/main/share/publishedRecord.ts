/**
 * Reads and writes the `published` field on a mini-app's own `manifest.json`
 * — the on-disk record that a tool has been published as a shared, read-only
 * snapshot (see `docs/design/sharing.md`). This is the *app* counterpart to
 * `shareStore.ts`'s `files` registry (M7): an app's publish state travels
 * with the app folder itself (so it survives export/import), while a
 * published *file*'s state lives in host-owned settings because a bare file
 * has no manifest of its own to carry it.
 *
 * Every write goes through `manifestIO.ts`'s `updateManifest` — the same
 * atomic temp-file+rename, per-path-queued primitive every other manifest
 * writer in this app uses (see that file's header for why: concurrent
 * read-modify-writes on the same manifest.json otherwise tear each other's
 * writes).
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * (this file implements ticket M8).
 *
 * Electron-free: takes a workspace root and a dir name, and goes through
 * `manifestIO.ts`, which is itself Electron-free — no `electron` import here.
 * Callers (the `miniApps:list` handler, the M9 IPC handlers) are responsible
 * for validating `dirName` before it reaches this module.
 */
import * as path from 'path';
import { updateManifest, readManifest } from '../manifestIO';
import type { PublishedInfo, ShareKind } from '../../shared/share';

const SHARE_KINDS: ReadonlySet<string> = new Set<ShareKind>(['app', 'file']);

export function manifestPathFor(workspaceRoot: string, dirName: string): string {
  return path.join(workspaceRoot, '.applications', dirName, 'manifest.json');
}

/**
 * Validates the shape `writePublished` writes: string `id`/`url`/`hash`/
 * `publishedAt` and a `kind` of `app` or `file`. Anything else — including a
 * manifest hand-edited into something malformed, or a stray non-object value
 * — is not a usable `PublishedInfo`. Exported so `fileHandlers.ts`'s
 * `miniApps:list` applies the identical check rather than a second copy of it.
 */
export function isPublishedInfo(x: unknown): x is PublishedInfo {
  if (!x || typeof x !== 'object') return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.kind === 'string' &&
    SHARE_KINDS.has(v.kind) &&
    typeof v.url === 'string' &&
    typeof v.hash === 'string' &&
    typeof v.publishedAt === 'string'
  );
}

/** Reads `manifest.published`, validated. Malformed or missing → null. */
export async function readPublished(workspaceRoot: string, dirName: string): Promise<PublishedInfo | null> {
  const manifest = await readManifest(manifestPathFor(workspaceRoot, dirName));
  const candidate = manifest?.published;
  return isPublishedInfo(candidate) ? candidate : null;
}

/** Stamps `manifest.published`, via `updateManifest` so it can't race another writer. */
export async function writePublished(
  workspaceRoot: string,
  dirName: string,
  info: PublishedInfo,
): Promise<void> {
  await updateManifest(manifestPathFor(workspaceRoot, dirName), (manifest) => {
    manifest.published = info;
    return manifest;
  });
}

/** Removes `manifest.published` (unpublish). A no-op if it was never set. */
export async function clearPublished(workspaceRoot: string, dirName: string): Promise<void> {
  await updateManifest(manifestPathFor(workspaceRoot, dirName), (manifest) => {
    delete manifest.published;
    return manifest;
  });
}
