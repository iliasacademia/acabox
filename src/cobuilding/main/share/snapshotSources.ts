/**
 * Snapshot source enumeration + hash for the sharing feature.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * — this file implements ticket M1 (contracts C1-C3).
 *
 * ELECTRON-FREE: no `electron`, no `electron-log`. Only `fs.promises`, `path`
 * and `crypto`, so this runs unmodified under plain Jest (no Electron ABI
 * mismatch, no mocking).
 *
 * WHAT GETS SNAPSHOTTED
 * ----------------------
 * Two roots, both under `<workspaceRoot>/.applications/`:
 *   - `<dirName>/`  the app itself, mapped to `w/.applications/<dirName>/…`
 *   - `_vendor/`    the shared design-system assets, mapped to
 *                   `w/.applications/_vendor/…`
 * `_vendor` is optional — a workspace that has never built a mini-app has
 * none, and that is not an error (`syncMiniAppAssets` populates it lazily).
 *
 * SYMLINKS: FOLLOW, BUT ONLY WITHIN THE WORKSPACE
 * ------------------------------------------------
 * `toolDataMigration.ts` makes `.applications/<dirName>/{input,output}`
 * relative symlinks into `<workspaceRoot>/tool-data/<dirName>/{input,output}`
 * (the code/data split — see that file's header). A snapshot must dereference
 * those to pick up the real working files, which is why every entry is
 * `stat`'d (follows the link) rather than `lstat`'d. Three symlink hazards
 * follow from doing that on a directory the user (or the agent) fully
 * controls:
 *   - a dangling link (target removed) — `stat` throws ENOENT; skipped
 *     silently, the same way `miniApps:export`'s `cp(..., {dereference:true})`
 *     would fail loudly on one, except here a broken link is routine (an
 *     `output/` before a tool has ever run) rather than exceptional.
 *   - a link that resolves OUTSIDE the workspace (e.g. someone symlinks
 *     `.applications/x/evil -> /etc`) — publishing must never walk into the
 *     rest of the filesystem, so every symlink's `realpath` is checked against
 *     the workspace root's `realpath` and skipped if it escapes. Non-symlink
 *     entries need no such check: they can only be reached by joining onto an
 *     already-validated ancestor path, so they are inside the tree by
 *     construction.
 *   - a link the agent points back at a workspace path that is itself in the
 *     snapshot — not specially handled. A cycle would only occur through
 *     `input`/`output`, which are excluded outright when `includeInput` is
 *     false and are never self-referential in practice; not defended against
 *     here because nothing in this codebase creates one.
 *
 * EXCLUSIONS
 * ----------
 * `node_modules`, `.git`, `.DS_Store` anywhere in the tree; the top-level
 * `input/` directory of the app root (not `_vendor`, which has none) when
 * `includeInput` is false. `output/` is never excluded.
 *
 * HASHING (C3)
 * ------------
 * Per file: streamed sha256 hex — `fs.createReadStream`, never a full read
 * into memory, because a mini-app's `dist/bundle.js` or a CSV dropped in
 * `output/` can be double-digit megabytes and this runs once per publish, not
 * once per boot. The snapshot hash is sha256 over the sorted lines
 * `<snapshotPath> <sha256hex>\n` — sorted so the hash depends only on file
 * identity and content, never on directory walk order or the snapshot's
 * absolute location on disk (verified by a test: the same fixture copied to a
 * different temp dir hashes identically).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SnapshotFile } from '../../shared/share';

export interface SnapshotSourceSpec {
  workspaceRoot: string;
  dirName: string;
  includeInput: boolean;
}

/** One file that will go into the snapshot, before hashing. */
export interface SnapshotSource {
  /** Posix, e.g. `w/.applications/x/output/a.json`. See C2. */
  snapshotPath: string;
  /** Absolute filesystem path to read the bytes from (symlinks resolved). */
  sourcePath: string;
  size: number;
}

const EXCLUDED_NAMES = new Set(['node_modules', '.git', '.DS_Store']);

/** `true` when `dirName` is safe to join onto a path: no separators, not dot-prefixed. */
function isValidDirName(dirName: string): boolean {
  return !!dirName && !dirName.includes('/') && !dirName.includes('\\') && !dirName.startsWith('.');
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.promises.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every file that belongs in the snapshot for `spec.dirName`,
 * sorted by `snapshotPath`. Throws if `dirName` is unsafe or the app
 * directory does not exist; an absent `_vendor` is not an error.
 */
export async function listSnapshotSources(spec: SnapshotSourceSpec): Promise<SnapshotSource[]> {
  const { workspaceRoot, dirName, includeInput } = spec;

  if (!isValidDirName(dirName)) {
    throw new Error(`Invalid app directory name: ${dirName}`);
  }

  const appDir = path.join(workspaceRoot, '.applications', dirName);
  const vendorDir = path.join(workspaceRoot, '.applications', '_vendor');

  if (!(await pathExists(appDir))) {
    throw new Error(`App not found: ${dirName}`);
  }

  // Resolved once and reused for every symlink containment check below. Using
  // the workspace's OWN realpath (rather than the raw `workspaceRoot` string)
  // matters because the workspace itself can sit behind a symlink (e.g. macOS
  // temp dirs: `/var/folders/...` -> `/private/var/folders/...`) — comparing a
  // resolved link target against an unresolved root would falsely reject
  // every symlink even when nothing escapes the workspace.
  const realWorkspaceRoot = await fs.promises.realpath(workspaceRoot);

  const sources: SnapshotSource[] = [];

  const isInsideWorkspace = (real: string): boolean =>
    real === realWorkspaceRoot || real.startsWith(realWorkspaceRoot + path.sep);

  /**
   * Recursive walk. `depth` is relative to the ROOT passed to this call (the
   * app dir or the vendor dir), which is what lets the `input/` exclusion
   * apply only at the app root and never to a coincidentally-named nested
   * directory.
   */
  async function walk(absDir: string, snapshotPrefix: string, depth: number, excludeTopInput: boolean): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable / raced away: treat as empty rather than fatal
    }

    for (const entry of entries) {
      const name = entry.name;
      if (EXCLUDED_NAMES.has(name)) continue;
      if (excludeTopInput && depth === 0 && name === 'input' && !includeInput) continue;

      const absPath = path.join(absDir, name);
      const snapshotPath = `${snapshotPrefix}/${name}`;

      let st: fs.Stats;
      if (entry.isSymbolicLink()) {
        try {
          st = await fs.promises.stat(absPath); // follows the link
        } catch {
          continue; // broken symlink: skip silently
        }
        let real: string;
        try {
          real = await fs.promises.realpath(absPath);
        } catch {
          continue; // raced away between stat and realpath
        }
        if (!isInsideWorkspace(real)) continue; // e.g. a link to /etc
      } else {
        try {
          st = await fs.promises.stat(absPath);
        } catch {
          continue; // raced away between readdir and stat
        }
      }

      if (st.isDirectory()) {
        await walk(absPath, snapshotPath, depth + 1, excludeTopInput);
      } else if (st.isFile()) {
        sources.push({ snapshotPath, sourcePath: absPath, size: st.size });
      }
      // sockets/fifos/etc: neither a file nor a directory — not this snapshot's business
    }
  }

  await walk(appDir, `w/.applications/${dirName}`, 0, true);

  if (await pathExists(vendorDir)) {
    await walk(vendorDir, 'w/.applications/_vendor', 0, false);
  }

  sources.sort((a, b) => (a.snapshotPath < b.snapshotPath ? -1 : a.snapshotPath > b.snapshotPath ? 1 : 0));
  return sources;
}

/** Streamed sha256 hex of one file's bytes — never buffers the whole file into memory. */
function hashFileStreamed(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Hash a snapshot per C3: per-file streamed sha256, then sha256 over the
 * sorted lines `<snapshotPath> <sha256hex>\n`. Sorts `sources` itself (by
 * `snapshotPath`) rather than trusting the caller, since the hash's whole
 * point is to be a function of file identity and content alone.
 */
export async function hashSnapshotSources(
  sources: SnapshotSource[],
): Promise<{ hash: string; files: SnapshotFile[] }> {
  const ordered = [...sources].sort((a, b) =>
    a.snapshotPath < b.snapshotPath ? -1 : a.snapshotPath > b.snapshotPath ? 1 : 0,
  );

  const files: SnapshotFile[] = [];
  for (const source of ordered) {
    const sha256 = await hashFileStreamed(source.sourcePath);
    files.push({ path: source.snapshotPath, size: source.size, sha256 });
  }

  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(`${file.path} ${file.sha256}\n`);
  }

  return { hash: hash.digest('hex'), files };
}
