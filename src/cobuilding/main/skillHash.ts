/**
 * Content hashing for the skill store.
 *
 * "Modified" is DERIVED, never flagged: a file is modified when its sha256
 * differs from the baseline hash recorded when we last wrote it. That is
 * write-path-agnostic by construction — an agent `Edit`, a `Bash` heredoc, vim
 * and the Acabox editor all land in the same inode through the render symlink,
 * and none of them can forget to set a flag. It is also self-healing: edit a
 * file and edit it back and the chip clears on its own.
 *
 * WHY THE PRISTINE MANIFEST IS COMPUTED AT BOOT, NOT AT BUILD TIME
 * ----------------------------------------------------------------
 * In dev the "shipped" tree IS the git working tree
 * (`src/cobuilding/skills/`), so a manifest baked at build time is stale the
 * moment anyone edits a skill — and the dev/packaged divergence that produces
 * is exactly the class of trap CLAUDE.md already records elsewhere. Hashing
 * 255 files costs single-digit milliseconds. One code path, no staleness.
 *
 * WHAT IS AND IS NOT PART OF A HASH
 * ---------------------------------
 * Content, the POSIX-relative path, and the exec bit. Not mtime, not inode, so
 * `touch` is not a modification and a re-copy is not a change. The path is in
 * the tree hash so a rename registers; the exec bit is in it so
 * `chmod +x scripts/*.py` registers, which for a skill that ships runnable
 * scripts is a real difference.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Above this, `hashFile` stops reading the whole file.
 *
 * The hazard is a user (or the agent) dropping a dataset inside a skill
 * directory: reconcile runs at boot on the path `agentInfrastructure.start()`
 * awaits, so a multi-gigabyte read there is a boot stall with no explanation.
 * Nothing Acabox ships comes close — the largest shipped file is 407 KB — so
 * this only ever fires on content a user put there.
 */
export const LARGE_FILE_FALLBACK_BYTES = 5 * 1024 * 1024;

/** How much of each end of an oversized file the fallback actually reads. */
export const LARGE_FILE_SAMPLE_BYTES = 64 * 1024;

function sha256Hex(data: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Size plus the first and last 64 KiB, for a file too large to read whole.
 *
 * THE DESIGN DOC SAYS "size + mtime" HERE AND THAT IS MEASURABLY WRONG.
 * The store is seeded and reverted with `cpSync(..., preserveTimestamps: true)`,
 * and that option **rounds mtime to whole milliseconds** — measured on Node
 * v25.9.0, source `…296601.7986` became destination `…296602`. So a size+mtime
 * hash would differ between pristine and store on the very copy that seeds it,
 * and a large built-in file would read MODIFIED forever behind a Revert button
 * that could never clear it. Whole seconds would paper over it and still break
 * on a rounding step across a second boundary.
 *
 * A bounded content sample has none of that: it is deterministic, identical
 * across any faithful copy, and reads 128 KiB no matter how big the file is.
 * The cost is a false negative — an in-place edit in the middle of a huge file
 * that does not change its length reads as unmodified. That is a strictly
 * better failure than a permanently-stuck chip, and it can only happen to
 * content a user dropped into a skill directory themselves.
 */
function hashLargeFile(absPath: string, size: number): string {
  const h = crypto.createHash('sha256');
  h.update(`size:${size}\0`);
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(LARGE_FILE_SAMPLE_BYTES);
    let read = fs.readSync(fd, buf, 0, LARGE_FILE_SAMPLE_BYTES, 0);
    h.update(buf.subarray(0, read));
    read = fs.readSync(fd, buf, 0, LARGE_FILE_SAMPLE_BYTES, size - LARGE_FILE_SAMPLE_BYTES);
    h.update(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return `partial-sha256:${size}:${h.digest('hex')}`;
}

/**
 * Hash one path. Three shapes, each self-describing so a state file is
 * readable and so the sampled hash can never be mistaken for a whole-content
 * one:
 *
 *   `sha256:<hex>`                    a regular file, hashed byte for byte
 *   `link:<hex>`                      a symlink, hashed as its readlink target
 *   `partial-sha256:<size>:<hex>`     a file past LARGE_FILE_FALLBACK_BYTES
 *
 * Throws on a missing path — callers that expect absence use `hashFileIf`.
 */
export function hashFile(absPath: string): string {
  const st = fs.lstatSync(absPath);
  if (st.isSymbolicLink()) {
    // The target string, not what it points at. A skill's symlink is part of
    // its shape; following it would hash something outside the skill.
    return `link:${sha256Hex(fs.readlinkSync(absPath))}`;
  }
  if (st.size > LARGE_FILE_FALLBACK_BYTES) {
    return hashLargeFile(absPath, st.size);
  }
  return `sha256:${sha256Hex(fs.readFileSync(absPath))}`;
}

/** `hashFile`, or undefined when the path does not exist or cannot be read. */
export function hashFileIf(absPath: string): string | undefined {
  try {
    return hashFile(absPath);
  } catch {
    return undefined;
  }
}

export interface SkillTreeEntry {
  /** POSIX-relative to the skill root, e.g. `scripts/recalc.py`. */
  relPath: string;
  hash: string;
  /** `mode & 0o111` on a regular file. Always false for a symlink: macOS
   *  reports 0o755 on every link's own mode, so including it would say every
   *  skill that ships a symlink also ships an executable. */
  exec: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Every file under `dir`, sorted by POSIX-relative path.
 *
 * Symlinks are leaves — we record the link and never recurse through it. A
 * skill directory reached through the render symlink would otherwise be
 * walkable back into itself, and a link into the user's data would put an
 * arbitrary tree inside a skill's hash.
 */
export function readSkillTree(dir: string): SkillTreeEntry[] {
  const out: SkillTreeEntry[] = [];

  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // Unreadable subtree: absent rather than fatal.
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      // Note the ordering: a symlink Dirent reports isDirectory() === false
      // (measured, and pinned by a test), so this check has to come first or a
      // link to a directory would silently be treated as a file.
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.lstatSync(abs);
          out.push({
            relPath: rel,
            hash: `link:${sha256Hex(fs.readlinkSync(abs))}`,
            exec: false,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          /* raced away between readdir and lstat */
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, fifos: not a skill's business
      try {
        const st = fs.lstatSync(abs);
        out.push({
          relPath: rel,
          hash: hashFile(abs),
          exec: (st.mode & 0o111) !== 0,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* raced away */
      }
    }
  };

  walk(dir, '');
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/** relPath -> hash for every file under `dir`. The shape a baseline is stored in. */
export function hashSkillFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readSkillTree(dir)) out[entry.relPath] = entry.hash;
  return out;
}

/**
 * One hash for a whole directory: sha256 over, per file sorted by path, the
 * path, a NUL, the file hash, a NUL, one exec byte, a NUL.
 *
 * A missing directory hashes as an empty tree, which is the same value as a
 * directory that exists and is empty. Callers that care about the difference
 * (adoption compares a workspace directory against a shipped skill) must check
 * existence themselves — `pristineTreeHash` returns undefined for an unknown
 * id precisely so that comparison cannot accidentally succeed.
 */
export function hashTree(dir: string): string {
  const h = crypto.createHash('sha256');
  for (const entry of readSkillTree(dir)) {
    h.update(entry.relPath);
    h.update(NUL);
    h.update(entry.hash);
    h.update(NUL);
    h.update(entry.exec ? EXEC_YES : EXEC_NO);
    h.update(NUL);
  }
  return `sha256:${h.digest('hex')}`;
}

const NUL = Buffer.from([0]);
const EXEC_YES = Buffer.from([1]);
const EXEC_NO = Buffer.from([0]);

export interface PristineSkill {
  id: string;
  dir: string;
  treeHash: string;
  /** relPath -> hash. Seeds a baseline directly. */
  files: Record<string, string>;
}

/**
 * The read-only shipped tree, hashed. Computed once per boot and passed around
 * — every caller wants the same answer and nobody should re-walk 255 files.
 */
export interface PristineManifest {
  root: string;
  /**
   * Whether the shipped tree was actually READ, as opposed to found missing.
   *
   * This exists because absence and unreadability produce the same empty map,
   * and reconcile draws a destructive conclusion from absence: a built-in that
   * is not in the manifest was "dropped upstream", so its store copy is deleted
   * (unmodified) or permanently retagged `custom` with its baseline erased
   * (modified — which loses Revert forever, even after the tree comes back).
   *
   * The root really can become unreadable at runtime: the bundle sits on an
   * ejected or network volume, the user drags `Acabox.app` to the Trash while
   * it is running, App Translocation moves it, or in dev a branch switch takes
   * `src/cobuilding/skills/` with it. None of those are consent to delete the
   * user's skills.
   *
   * A readable-but-EMPTY root counts as unavailable too, and that asymmetry is
   * deliberate. A build that genuinely ships zero skills does not exist — it
   * would fail the `_bridge` boot assertion — whereas a partially-populated or
   * mid-extraction Resources directory is a real state. The cost of a false
   * "unavailable" is one boot where reconcile does nothing and self-heals; the
   * cost of a false "everything was dropped upstream" is irreversible.
   */
  available: boolean;
  /**
   * Changes whenever any shipped skill changes. Reconcile runs when this moves
   * OR when the app version moves; the hash clause is what makes a dev
   * `git pull` behave identically to a release upgrade.
   *
   * Derived from the per-skill tree hashes rather than by re-walking the root,
   * because we have just walked it. Consequence, stated so nobody is surprised:
   * a file at the pristine root that is not inside a skill directory does not
   * affect it. There are none, and one would not be a skill.
   */
  rootHash: string;
  skills: Map<string, PristineSkill>;
}

/** A directory is a skill if and only if it contains SKILL.md. */
function isSkillDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

export function readPristineManifest(pristineRoot: string): PristineManifest {
  const skills = new Map<string, PristineSkill>();

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(pristineRoot, { withFileTypes: true });
  } catch {
    // No shipped tree at all. Returning an empty manifest rather than throwing
    // is deliberate: it degrades to "the store keeps whatever it has", where
    // throwing here would sit on the boot path. `available: false` is what
    // makes that degradation real — without it reconcile reads the empty map
    // as "upstream dropped every skill". See the field's comment.
    return {
      root: pristineRoot,
      available: false,
      rootHash: `sha256:${sha256Hex('')}`,
      skills,
    };
  }

  for (const entry of entries) {
    // Directories only, and symlinks are not followed — the shipped tree is
    // ours and has none, so one appearing is a packaging accident, not a skill.
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(pristineRoot, entry.name);
    if (!isSkillDir(dir)) continue;
    skills.set(entry.name, {
      id: entry.name,
      dir,
      treeHash: hashTree(dir),
      files: hashSkillFiles(dir),
    });
  }

  const h = crypto.createHash('sha256');
  for (const id of [...skills.keys()].sort()) {
    h.update(id);
    h.update(NUL);
    h.update(skills.get(id)!.treeHash);
    h.update(NUL);
  }

  return {
    root: pristineRoot,
    available: skills.size > 0,
    rootHash: `sha256:${h.digest('hex')}`,
    skills,
  };
}

/** Tree hash of a shipped skill, or undefined if nothing ships under that id. */
export function pristineTreeHash(
  manifest: PristineManifest,
  id: string,
): string | undefined {
  return manifest.skills.get(id)?.treeHash;
}
