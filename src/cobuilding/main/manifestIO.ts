import * as path from 'path';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';

/**
 * Serialized, atomic IO for mini-app manifest.json files.
 *
 * Several handlers do read-modify-write on the same manifest, and opening a
 * tool fires two of them at once (miniApps:touch + tool:opened, plus
 * sessions:findForApp). fs.writeFile truncates in place, so a concurrent
 * reader can catch a torn/empty file, parse it as "no manifest", and rewrite
 * it from scratch — destroying name/description/icon/archived (observed live:
 * tool:opened minted a fresh manifest over a fully populated one). Writes here
 * go to a temp file + rename (atomic on POSIX) so readers only ever see a
 * complete file, and each path's update cycles are chained on a queue so
 * concurrent updates merge instead of last-write-wins.
 */

const updateQueues = new Map<string, Promise<unknown>>();

/** Read + parse a manifest. Returns null when missing or unreadable. */
export async function readManifest(manifestPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable — callers treat null as "no manifest yet".
  }
  return null;
}

/** Write a manifest atomically (temp file + rename). */
export async function writeManifestAtomic(
  manifestPath: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const tmpPath = path.join(path.dirname(manifestPath), `.manifest-${randomUUID()}.tmp`);
  await fsPromises.writeFile(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
  await fsPromises.rename(tmpPath, manifestPath);
}

/**
 * Run one read-modify-write cycle exclusively for this manifest path. A
 * missing manifest reaches `mutate` as {}. Returns the manifest as written.
 * Rejects if the write fails (mutations then did not persist).
 */
export async function updateManifest(
  manifestPath: string,
  mutate: (manifest: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prev = updateQueues.get(manifestPath) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* a failed predecessor doesn't block the queue */ })
    .then(async () => {
      const manifest = (await readManifest(manifestPath)) ?? {};
      const updated = mutate(manifest);
      await writeManifestAtomic(manifestPath, updated);
      return updated;
    });
  updateQueues.set(manifestPath, next);
  next
    .catch(() => { /* result surfaces to the caller; keep cleanup unrejected */ })
    .finally(() => {
      if (updateQueues.get(manifestPath) === next) updateQueues.delete(manifestPath);
    });
  return next;
}
