/**
 * Stages a snapshot on disk: materializes every `SnapshotSource` (M1) into a
 * staging directory laid out exactly as C2 describes, applying the
 * `local-file://` rewrite (M2) to the app's own code files along the way.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * — this file implements ticket M3 (contracts C1, C2, C3).
 *
 * ELECTRON-FREE: no `electron`, no `electron-log`. Only `fs.promises` and
 * `path`, so this runs unmodified under plain Jest.
 *
 * WHY THE REWRITE HAPPENS HERE, NOT IN M1 OR M2
 * -----------------------------------------------
 * M2 (`rewriteLocalFileUrls.ts`) is a pure string transform with no idea
 * where bytes come from or go, and M1 (`snapshotSources.ts`) only enumerates
 * and hashes — it never touches a file's content. This module is the one
 * place that knows both: which source file a given `SnapshotSource` came
 * from, and which staged files should be rewritten (`shouldRewrite`, gated on
 * `dirName` and extension — `_vendor/**` and `output/**` are copied
 * byte-for-byte even when they happen to contain the literal, per M2's own
 * contract). Doing it at stage time, not hash time, is also why the hash
 * covers pre-rewrite bytes (C3): the rewritten output embeds the hash, so it
 * cannot be an input to computing that same hash.
 *
 * WHY `size` IS MEASURED POST-STAGE, NOT COPIED FROM `SnapshotSource.size`
 * ---------------------------------------------------------------------------
 * `SnapshotSource.size` (M1) is the SOURCE file's size, before any rewrite. A
 * rewrite changes byte length — `local-file://` is 13 bytes, a versioned base
 * like `/a/<id>/v/<64-hex-hash>/w` is longer — and the `size` this module
 * returns is what the caller (M4/M5) will upload, i.e. the length of what
 * actually landed on disk here. `contentType`, by contrast, depends only on
 * the (unchanged) extension, so it is read straight off
 * `contentTypeFor(source.snapshotPath)` without touching the staged bytes.
 *
 * WHY `stagingDir` IS NEVER CREATED OR DELETED HERE
 * ----------------------------------------------------
 * The caller owns the staging directory's whole lifecycle (create it, upload
 * from it, tear it down). This module only ever creates directories INSIDE
 * it (`mkdir -p` the parent of each staged file) and never removes anything,
 * so a caller that wants to inspect the staged tree after a partial failure
 * still can.
 */
import * as fs from 'fs';
import * as path from 'path';
import { contentTypeFor, versionedBase } from '../../shared/share';
import { rewriteLocalFileUrls, shouldRewrite } from './rewriteLocalFileUrls';
import type { SnapshotSource } from './snapshotSources';

/** One file materialized into the staging directory, ready to upload. */
export interface StagedFile {
  /** Posix, e.g. `w/.applications/x/output/a.json`. Same as `SnapshotSource.snapshotPath`. */
  snapshotPath: string;
  /** Absolute filesystem path under `stagingDir` where the bytes now live. */
  absPath: string;
  contentType: string;
  /** Size of the STAGED file — post-rewrite where a rewrite applied. */
  size: number;
}

export interface StageSnapshotInput {
  sources: SnapshotSource[];
  dirName: string;
  kind: 'app';
  id: string;
  hash: string;
  stagingDir: string;
}

function bySnapshotPath(a: StagedFile, b: StagedFile): number {
  return a.snapshotPath < b.snapshotPath ? -1 : a.snapshotPath > b.snapshotPath ? 1 : 0;
}

/**
 * Materializes `input.sources` under `input.stagingDir`: for a file under the
 * app's own directory with a rewritable extension (`shouldRewrite`), reads it
 * as utf-8, rewrites every `local-file://` literal to
 * `versionedBase(input.kind, input.id, input.hash)`, and writes the result;
 * every other file is copied byte-for-byte (`fs.promises.copyFile`).
 *
 * Returns the staged files sorted by `snapshotPath` (sorted here rather than
 * trusted from the caller — M1 already returns `sources` sorted, but this
 * module's own contract is "sorted output" regardless of input order).
 */
export async function stageSnapshot(input: StageSnapshotInput): Promise<StagedFile[]> {
  const { sources, dirName, kind, id, hash, stagingDir } = input;
  const base = versionedBase(kind, id, hash);

  const staged: StagedFile[] = [];

  for (const source of sources) {
    const targetPath = path.join(stagingDir, source.snapshotPath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    if (shouldRewrite(source.snapshotPath, dirName)) {
      const text = await fs.promises.readFile(source.sourcePath, 'utf8');
      const { output } = rewriteLocalFileUrls(text, base);
      await fs.promises.writeFile(targetPath, output, 'utf8');
    } else {
      await fs.promises.copyFile(source.sourcePath, targetPath);
    }

    const stat = await fs.promises.stat(targetPath);
    staged.push({
      snapshotPath: source.snapshotPath,
      absPath: targetPath,
      contentType: contentTypeFor(source.snapshotPath),
      size: stat.size,
    });
  }

  staged.sort(bySnapshotPath);
  return staged;
}
