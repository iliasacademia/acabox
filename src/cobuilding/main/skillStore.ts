/**
 * The skill store — the one writable copy of every skill's bytes.
 *
 * Three layers, and the whole design is which of them is allowed to be written:
 *
 *   P  pristine   `<app>/src/cobuilding/skills/` in dev, `Contents/Resources/
 *                 skills/` when packaged. READ-ONLY, always. Every packaged
 *                 file is in `_CodeSignature/CodeResources`, so writing there
 *                 breaks `codesign --verify --strict`, and `selfUpdater` `mv`s
 *                 the whole bundle away on the next update. It is a seed
 *                 source, a revert source, and a hash reference — nothing else.
 *   W  store      `<userData>/<channel>/skills/<id>/`. The only writable copy.
 *                 Survives workspace deletion and app upgrades.
 *   R  render     `<workspace>/.claude/skills/<id>` — an absolute symlink to W.
 *                 Zero bytes. Built by `skillRender.ts`.
 *
 * Because R is a symlink, `open()` resolves the layer at write time: an agent
 * `Edit`, a `Bash` heredoc, vim, TextEdit and the Acabox editor all deposit
 * bytes in the same inode. There is no second copy to reconcile and no sync
 * direction to get backwards. That is what this module is protecting.
 *
 * WHAT REPLACES THE OLD BEHAVIOUR
 * -------------------------------
 * `skills.ts:copySkillsToWorkspace` (deleted) force-copied 21 hardcoded skills
 * over the workspace on every boot and `rmSync`d recursively anything it did
 * not recognise. So a skill edit silently vanished at the next launch, and a
 * skill the agent created was destroyed. Here, nothing is ever silently destroyed:
 * an unknown directory in the render target is ADOPTED into the store, and an
 * upstream change that collides with a local edit becomes a conflict the user
 * is shown rather than an overwrite.
 *
 * THE STATE FILE IS A REBUILDABLE CACHE
 * -------------------------------------
 * `skills-state.json` lives in userData, the agent has unrestricted Bash, and
 * it *will* eventually be deleted or corrupted. Losing it must not lose a fork:
 * recovery re-derives every entry by comparing store hashes against pristine
 * hashes ("equals what shipped" = unmodified, anything else = modified) rather
 * than re-seeding. What recovery genuinely cannot recover is the two pieces of
 * pure user intent that have no on-disk evidence — `enabled: false` and
 * `removed: true` — so a lost state file re-enables everything and re-seeds a
 * removed built-in. Bytes survive; preferences do not.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

import {
  HOST_OWNED_SKILL_PATHS,
  SKILLS_RENDER_SUBDIR,
  SKILLS_STATE_FILE,
  SKILLS_STATE_VERSION,
  SKILLS_STORE_DIR,
  SKILLS_TRASH_DIR,
  emptySkillsState,
  parseSkillFrontmatter,
  validateSkillId,
} from '../shared/skills';
import type {
  SkillDeclaredMetadata,
  SkillDescriptor,
  SkillFrontmatter,
  SkillOrigin,
  SkillSource,
  SkillStateEntry,
  SkillsState,
} from '../shared/skills';
import { readManifest, updateManifest } from './manifestIO';
import {
  hashFileIf,
  hashSkillFiles,
  hashTree,
  readPristineManifest,
  readSkillTree,
} from './skillHash';
import type { PristineManifest, PristineSkill } from './skillHash';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Where the read-only shipped tree lives — `src/cobuilding` in dev,
 * `Contents/Resources` when packaged.
 *
 * The one definition. `skills.ts` imports it from here rather than keeping its
 * own: it needs the same root for `CLAUDE.md`, `settings.json` and `hooks/`,
 * and two resolvers for one directory is how the pristine tree and the store
 * would end up disagreeing about what "shipped" means.
 */
export function getCobuildingSourceDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(app.getAppPath(), 'src', 'cobuilding');
}

export function getPristineSkillsDir(): string {
  return path.join(getCobuildingSourceDir(), 'skills');
}

export function getSkillsStoreDir(): string {
  return path.join(app.getPath('userData'), SKILLS_STORE_DIR);
}

/**
 * Pre-revert forks. A SIBLING of the store, never inside it, so the renderer
 * never tries to link a trash entry as a skill.
 */
export function getSkillsTrashDir(): string {
  return path.join(app.getPath('userData'), SKILLS_TRASH_DIR);
}

export function getSkillsStateFile(): string {
  return path.join(app.getPath('userData'), SKILLS_STATE_FILE);
}

export function skillStorePath(id: string): string {
  return path.join(getSkillsStoreDir(), id);
}

/**
 * Resolve `relPath` inside `base`, refusing anything that escapes.
 *
 * `..` and absolute paths are the obvious cases; the less obvious one is a
 * symlink already inside the skill, which `path.resolve` cannot see. That is
 * acceptable here because the alternative — `realpath` on every write — would
 * refuse the render symlink itself, and because a skill's own symlinks are
 * stripped at import (`skillImporter`, a later stage).
 */
function resolveWithin(base: string, relPath: string): string | null {
  if (!relPath || path.isAbsolute(relPath)) return null;
  const abs = path.resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/**
 * Does `relPath` fall under a host-owned pattern?
 *
 * Deliberately not a glob library: the only pattern that exists is
 * `references/findings/**`, and a real matcher would invite patterns whose
 * semantics nobody has thought through on a set that is excluded from both the
 * baseline and the revert set.
 */
function isHostOwned(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return relPath === prefix || relPath.startsWith(`${prefix}/`);
    }
    return relPath === pattern;
  });
}

function hostOwnedPathsFor(entry: SkillStateEntry): readonly string[] {
  return entry.hostOwnedPaths ?? HOST_OWNED_SKILL_PATHS;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/**
 * Copy from pristine into the store.
 *
 * `preserveTimestamps` keeps a re-seed idempotent in every observable
 * dimension, mtime included, so `changedAt` on the Knowledge row only moves
 * when someone actually changed something rather than every time the store
 * self-heals. (It is deliberately NOT load-bearing for hashing: `cpSync`
 * rounds the timestamp to whole milliseconds, which is why `hashFile`'s
 * oversize path samples content instead of trusting mtime.)
 *
 * `verbatimSymlinks` keeps a relative link relative; the default rewrites it
 * against the new location, which would change the link's bytes and therefore
 * its hash.
 *
 * The EINTR retry is inherited from `skills.ts`, where it was added against a
 * real failure — a signal during a large recursive copy aborts `cpSync`.
 */
function copyTree(src: string, dest: string, maxRetries = 5): void {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.cpSync(src, dest, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      return;
    } catch (err: any) {
      if (err && err.code === 'EINTR' && attempt < maxRetries) continue;
      throw err;
    }
  }
}

function copyOneFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { preserveTimestamps: true, verbatimSymlinks: true, force: true });
}

/**
 * Move a path into the trash, creating parents. Rename first (instant, and
 * atomic on one volume), falling back to copy + remove across devices.
 */
function moveInto(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err: any) {
    if (err && err.code === 'EXDEV') {
      copyTree(src, dest);
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * A fresh trash directory for one revert or delete.
 *
 * Revert is rename-to-trash then copy-from-pristine, NEVER a bare delete. The
 * user may want one paragraph of what they wrote back, and "Take the new
 * version" has to be as recoverable as everything else here.
 */
function newTrashDir(id: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const root = getSkillsTrashDir();
  let dir = path.join(root, `${id}-${stamp}`);
  let n = 0;
  while (fs.existsSync(dir)) {
    n += 1;
    dir = path.join(root, `${id}-${stamp}-${n}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Finished forks older than this are dropped. Called at boot by the wiring. */
export const SKILLS_TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function pruneSkillsTrash(maxAgeMs: number = SKILLS_TRASH_MAX_AGE_MS): number {
  const root = getSkillsTrashDir();
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    try {
      if (fs.statSync(abs).mtimeMs >= cutoff) continue;
      fs.rmSync(abs, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn(`[Skills] Could not prune trash ${entry.name}: ${(err as Error).message}`);
    }
  }
  if (removed > 0) log.info(`[Skills] Pruned ${removed} expired trash entr(ies)`);
  return removed;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Coerce whatever is on disk into a usable state object. Anything unrecognised
 * degrades to the empty state, which reconcile then rebuilds from hashes — the
 * cache property this file's header describes.
 */
function normalizeState(raw: Record<string, unknown> | null | undefined): SkillsState {
  const state = emptySkillsState();
  if (!raw || typeof raw !== 'object') return state;

  if (typeof raw.seededAppVersion === 'string') state.seededAppVersion = raw.seededAppVersion;
  if (typeof raw.pristineRootHash === 'string') state.pristineRootHash = raw.pristineRootHash;

  const skills = raw.skills;
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return state;

  for (const [id, value] of Object.entries(skills as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    // B23. This is the ONE funnel every consumer of the state file comes
    // through, and until now it copied keys verbatim. `skillStorePath` is a
    // bare `path.join`, and `reconcile`'s dropped-upstream pass calls it with
    // whatever key it finds — so a traversal id in a hand-edited or corrupted
    // state file became a recursive delete at boot. Guarding here rather than
    // in `reconcile` covers every other reader for free.
    //
    // Precondition is arbitrary write into userData, which in this app means
    // the agent's already-unrestricted Bash, so this is not an escalation
    // boundary. It is one line, and the alternative is a delete outside the
    // store.
    if (!validateSkillId(id).ok) {
      log.warn(`[Skills] Ignoring unusable skill id in the state file: ${JSON.stringify(id)}`);
      continue;
    }
    const entry = value as SkillStateEntry;
    const origin: SkillOrigin =
      entry.origin === 'builtin' || entry.origin === 'imported' ? entry.origin : 'custom';
    state.skills[id] = { ...entry, origin, enabled: entry.enabled !== false };
  }
  return state;
}

export async function readSkillsState(): Promise<SkillsState> {
  return normalizeState(await readManifest(getSkillsStateFile()));
}

/**
 * One serialized read-modify-write of the state file.
 *
 * Everything that touches the store runs INSIDE the mutator, so the filesystem
 * work and the record of it are one queued transaction — `manifestIO` chains
 * cycles per path, which is exactly the machinery written for the manifest
 * race that once destroyed a tool's name/description/icon.
 *
 * The mutator is synchronous by `manifestIO`'s contract, which is why every
 * filesystem call in this module is the sync variant. A throw inside it means
 * nothing is written, so a half-done mutation leaves the state describing the
 * world before it — and reconcile self-heals a built-in whose directory went
 * missing.
 */
async function updateSkillsState<T>(
  mutate: (state: SkillsState) => T,
): Promise<{ state: SkillsState; value: T }> {
  let value!: T;
  const written = await updateManifest(getSkillsStateFile(), (raw) => {
    const state = normalizeState(raw);
    value = mutate(state);
    state.version = SKILLS_STATE_VERSION;
    return state as unknown as Record<string, unknown>;
  });
  return { state: normalizeState(written), value };
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Files whose bytes differ from the baseline: changed, deleted, or added
 * inside a skill that ships one. Host-owned paths are excluded — a findings
 * ledger the host wrote is not a user modification of a shipped skill.
 */
/**
 * Host-owned files that actually exist in the store for this skill —
 * `references/findings/**`, the accumulated knowledge ledger.
 *
 * The counterpart to `modifiedFiles`, which deliberately EXCLUDES these: a
 * ledger the host wrote is not a user edit of a shipped skill, so it must not
 * make the skill read MODIFIED and block an upstream fix.
 *
 * That exclusion is right for the "did the user change this" question and
 * catastrophically wrong for the "is it safe to delete this" question, which
 * used the same function. Anything deciding to DESTROY a skill must ask both.
 */
export function hostOwnedFiles(id: string, entry: SkillStateEntry): string[] {
  const hostOwned = hostOwnedPathsFor(entry);
  return Object.keys(hashSkillFiles(skillStorePath(id)))
    .filter((rel) => isHostOwned(rel, hostOwned))
    .sort();
}

export function modifiedFiles(id: string, entry: SkillStateEntry): string[] {
  const baseline = entry.baseline;
  if (!baseline) return [];
  const hostOwned = hostOwnedPathsFor(entry);
  const store = hashSkillFiles(skillStorePath(id));
  const out = new Set<string>();
  for (const [rel, hash] of Object.entries(baseline)) {
    if (isHostOwned(rel, hostOwned)) continue;
    if (store[rel] !== hash) out.add(rel);
  }
  for (const rel of Object.keys(store)) {
    if (isHostOwned(rel, hostOwned)) continue;
    if (!(rel in baseline)) out.add(rel);
  }
  return [...out].sort();
}

/**
 * `modified` for one skill, or **undefined** for a skill with no baseline.
 *
 * Undefined is the point: a custom skill has no pristine counterpart, so both
 * `true` and `false` would be a claim we cannot support, and the UI renders no
 * chip at all rather than a fabricated one.
 */
export function isModified(id: string, entry: SkillStateEntry): boolean | undefined {
  if (!entry.baseline) return undefined;
  return modifiedFiles(id, entry).length > 0;
}

function describeSkill(id: string, entry: SkillStateEntry): SkillDescriptor {
  const storePath = skillStorePath(id);

  if (entry.removed) {
    // The bytes are in the trash and the directory is gone. Report what the
    // record still knows and nothing more — a zero file count here is the
    // truth, not a placeholder.
    return {
      id,
      origin: entry.origin,
      enabled: entry.enabled,
      storePath,
      declaredName: entry.declared?.name,
      description: entry.declared?.description,
      license: entry.declared?.license,
      frontmatterOk: true,
      skillMdBytes: 0,
      fileCount: 0,
      execCount: 0,
      provenance: entry.source,
      importedAt: entry.importedAt,
      removed: true,
    };
  }

  const tree = readSkillTree(storePath);
  const skillMd = tree.find((f) => f.relPath === 'SKILL.md');
  const changedAt = tree.length
    ? Math.max(...tree.map((f) => f.mtimeMs))
    : undefined;

  let front: SkillFrontmatter = { ok: false, error: 'No SKILL.md in this skill directory.' };
  if (skillMd) {
    try {
      front = parseSkillFrontmatter(fs.readFileSync(path.join(storePath, 'SKILL.md'), 'utf-8'));
    } catch (err) {
      front = { ok: false, error: `SKILL.md could not be read: ${(err as Error).message}` };
    }
  }

  return {
    id,
    origin: entry.origin,
    enabled: entry.enabled,
    storePath,
    // A declared name is shown only when it disagrees with the directory name;
    // repeating the id as an "alias" would be noise.
    declaredName: front.name && front.name !== id ? front.name : undefined,
    description: front.description,
    whenToUse: front.whenToUse,
    license: front.license ?? entry.declared?.license,
    source: front.source,
    frontmatterOk: front.ok,
    frontmatterError: front.error,
    skillMdBytes: skillMd?.size ?? 0,
    fileCount: tree.length,
    execCount: tree.filter((f) => f.exec).length,
    changedAt,
    provenance: entry.source,
    importedAt: entry.importedAt,
    modified: isModified(id, entry),
  };
}

/** Every skill the store knows about, id-sorted. Removed built-ins included. */
export async function listSkills(): Promise<SkillDescriptor[]> {
  const state = await readSkillsState();
  return Object.keys(state.skills)
    .sort()
    .map((id) => describeSkill(id, state.skills[id]!));
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export type SkillConflictKind =
  /** Upstream changed a file the user had also edited. */
  | 'changed-upstream'
  /** Upstream changed a file the user had deleted. */
  | 'user-deleted-and-changed'
  /** The user created a file at a path upstream now ships. */
  | 'user-created-at-upstream-path';

export interface SkillFileConflict {
  id: string;
  relPath: string;
  kind: SkillConflictKind;
  /** The shipped hash now, so "keep mine" can be dismissed against exactly it. */
  upstreamHash: string;
}

export interface ReconcileResult {
  /**
   * Whether the per-file table ran. False on an ordinary boot: nothing shipped
   * has changed, so there is nothing to fast-forward and nothing to conflict.
   */
  upgraded: boolean;
  /**
   * The shipped tree could not be read, so every conclusion that depends on it
   * was skipped. Surfaced rather than swallowed: the observable symptom is
   * "reconcile did nothing", and without this the reason is invisible.
   */
  pristineUnavailable: boolean;
  pristineRootHash: string;
  /** Skills copied in from pristine (first run, a new release, or self-heal). */
  seeded: string[];
  fastForwarded: Array<{ id: string; relPath: string }>;
  conflicts: SkillFileConflict[];
  /** Real directories moved out of the render target into the store. */
  adopted: Array<{ id: string; fromName: string }>;
  /** Store directories the state file had no record of. */
  recovered: string[];
  /** Byte-identical pre-migration copies deleted from the render target. */
  migrated: string[];
  /** Built-ins upstream dropped, with no local edits — removed outright. */
  removedUpstream: string[];
  /** Built-ins upstream dropped that had local edits — retagged custom. */
  keptAsCustom: string[];
  errors: Array<{ id: string; message: string }>;
}

export interface ReconcileOptions {
  /**
   * When given, real directories under `<workspaceDir>/.claude/skills` are
   * adopted into the store first. Always pass it at boot — it is the only
   * thing standing between a skill the agent created with `mkdir` and the old
   * behaviour, which deleted it.
   */
  workspaceDir?: string;
  /** Pre-computed pristine manifest, so a caller need not hash the tree twice. */
  pristine?: PristineManifest;
  /** Overrides `app.getVersion()`. Tests, and nothing else. */
  appVersion?: string;
}

function emptyResult(pristineRootHash: string): ReconcileResult {
  return {
    upgraded: false,
    pristineUnavailable: false,
    pristineRootHash,
    seeded: [],
    fastForwarded: [],
    conflicts: [],
    adopted: [],
    recovered: [],
    migrated: [],
    removedUpstream: [],
    keptAsCustom: [],
    errors: [],
  };
}

/**
 * Is there a real directory at this path?
 *
 * Deliberately not `existsSync`. A store entry that is a regular file, a
 * dangling symlink or anything else is NOT a skill, and treating it as one is
 * worse than treating it as absent: the seeder would skip it forever, the
 * render would happily symlink to it, and the CLI would silently drop the
 * skill because `<link>/SKILL.md` is ENOTDIR. Answering "no" here re-seeds it,
 * which is the self-heal every other corruption in this module gets.
 */
function isDirectorySync(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function storeIds(): string[] {
  try {
    return fs
      .readdirSync(getSkillsStoreDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Take ownership of real directories sitting in the render target.
 *
 * This is the deliberate inversion of `skills.ts:54-64`, which `rmSync`s
 * recursively and silently anything it does not recognise — destroying, on the
 * very upgrade that promises to protect edits, a skill the agent just created.
 * Here there are exactly two outcomes and neither loses bytes:
 *
 *  - byte-identical to what ships under the same name → a pre-migration copy.
 *    Deleted, because the identical bytes are about to be seeded into the
 *    store from pristine. Deleting and re-seeding rather than moving the copy
 *    in is deliberate: a moved copy carries the copy's mtimes, and for a file
 *    past `LARGE_FILE_FALLBACK_BYTES` that alone would make it read MODIFIED
 *    forever.
 *  - anything else → moved into the store. If the name matches a shipped
 *    skill and that id is still free, it becomes that built-in with a pristine
 *    baseline, so a pre-migration edit arrives already MODIFIED and already
 *    revertible. Otherwise it is a custom skill, suffixed `-recovered-N` if
 *    the id is taken.
 */
function adoptRenderDirectories(
  workspaceDir: string,
  state: SkillsState,
  pristine: PristineManifest,
  result: ReconcileResult,
): void {
  const renderDir = path.join(workspaceDir, SKILLS_RENDER_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(renderDir, { withFileTypes: true });
  } catch {
    return; // No render target yet — first boot, nothing to adopt.
  }

  for (const entry of entries) {
    // Symlinks are the render's own output. Note the ordering: a symlink
    // Dirent reports isDirectory() === false, so the link check has to come
    // first or the directory check would never see one anyway — the test pins
    // this because a "tidy up the filter" commit is exactly how the old
    // delete would come back.
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;

    const abs = path.join(renderDir, entry.name);
    const shipped = pristine.skills.get(entry.name);

    try {
      if (shipped && hashTree(abs) === shipped.treeHash) {
        fs.rmSync(abs, { recursive: true, force: true });
        result.migrated.push(entry.name);
        log.info(`[Skills] Removed pre-migration copy of ${entry.name} (identical to shipped)`);
        continue;
      }

      let id = entry.name;
      let n = 0;
      while (state.skills[id] || fs.existsSync(skillStorePath(id))) {
        n += 1;
        id = `${entry.name}-recovered-${n}`;
      }

      moveInto(abs, skillStorePath(id));
      const asShipped = id === entry.name ? shipped : undefined;
      // B24. An UNKNOWN directory arrives DISABLED, matching the import path's
      // hardcoded `enabled: false` and for the same reason: nothing should
      // start influencing the model before the user has looked at it.
      //
      // This one is not merely tidiness. Adoption reads from the WORKSPACE,
      // where the agent has Write and Bash — so without this, an agent could
      // create `<workspace>/.claude/skills/<anything>/SKILL.md` and have it on
      // the roster, shaping every subsequent turn, at the next boot. Arriving
      // disabled makes that a proposal the user can see rather than a fait
      // accompli.
      //
      // A directory that IS a shipped skill stays enabled: on the pre-store
      // upgrade path these are the user's own existing built-ins (identical
      // copies are removed above, so what reaches here is one they edited), and
      // disabling those would silently empty a working roster. The residual is
      // that an agent could name its directory after a shipped skill to inherit
      // enabled — but that is then a MODIFICATION of a built-in, which the UI
      // flags and Revert undoes; it cannot introduce a new skill this way.
      state.skills[id] = asShipped
        ? { origin: 'builtin', enabled: true, baseline: { ...asShipped.files } }
        : { origin: 'custom', enabled: false, createdAt: nowIso() };
      result.adopted.push({ id, fromName: entry.name });
      log.info(
        `[Skills] Adopted workspace directory ${entry.name} into the store as ` +
          `${id} (${state.skills[id]!.origin})`,
      );
    } catch (err) {
      result.errors.push({ id: entry.name, message: (err as Error).message });
      log.warn(`[Skills] Could not adopt ${entry.name}: ${(err as Error).message}`);
    }
  }
}

/**
 * The per-file reconcile table, exactly as tabulated in
 * `docs/design/skills-plugins-connectors.md`. Three hashes decide every row:
 * B = the baseline, Pn = the shipped file now, Wn = the store file now.
 *
 * Two rows are additions to the table, both because the table's row as written
 * would be actively wrong:
 *  - `Wn === Pn` with `B ≠ Pn` is NOT a conflict. The user already has the new
 *    bytes; raising a conflict against bytes that already match would put an
 *    UPDATE AVAILABLE chip on a file that is up to date.
 *  - `dismissed[rel] === Pn` suppresses the conflict. That is what "keep mine"
 *    means, and without it the chip returns on every boot.
 */
function reconcileSkillFiles(
  id: string,
  entry: SkillStateEntry,
  shipped: PristineSkill,
  result: ReconcileResult,
): void {
  const hostOwned = hostOwnedPathsFor(entry);
  const baseline = entry.baseline ?? {};
  const dismissed = entry.dismissed ?? {};
  const storeDir = skillStorePath(id);
  const storeHashes = hashSkillFiles(storeDir);

  const nextBaseline: Record<string, string> = {};
  const nextDismissed: Record<string, string> = {};
  const nextUpdateAvailable: Record<string, string> = {};

  const rels = new Set([
    ...Object.keys(baseline),
    ...Object.keys(shipped.files),
    ...Object.keys(storeHashes),
  ]);

  for (const rel of [...rels].sort()) {
    // Host-owned paths are excluded from the baseline AND the revert set,
    // always. No shipped or imported skill ever contains one, so there is
    // never a legitimate upstream version to reconcile — and a user who grew
    // sixty findings inside a skill must not lose them to an upgrade.
    if (isHostOwned(rel, hostOwned)) continue;

    // `rel` can come out of the baseline map, and the state file sits in
    // userData where the agent has unrestricted Bash. A poisoned `../../…`
    // key must not turn a reconcile into a write or a delete outside the
    // skill — the paths derived from disk are already safe, this covers the
    // one that is not.
    const srcAbs = resolveWithin(shipped.dir, rel);
    const destAbs = resolveWithin(storeDir, rel);
    if (!srcAbs || !destAbs) {
      result.errors.push({ id, message: `Ignored out-of-tree baseline path "${rel}".` });
      continue;
    }

    const B = baseline[rel];
    const Pn = shipped.files[rel];
    const Wn = storeHashes[rel];
    const conflict = (kind: SkillConflictKind): void => {
      result.conflicts.push({ id, relPath: rel, kind, upstreamHash: Pn! });
      nextUpdateAvailable[rel] = Pn!;
    };

    if (Pn === undefined) {
      // Dropped upstream. The baseline entry goes either way; the bytes only
      // go when they are untouched.
      if (B !== undefined && Wn === B) {
        try {
          fs.rmSync(destAbs, { force: true });
        } catch (err) {
          result.errors.push({ id, message: `${rel}: ${(err as Error).message}` });
        }
      }
      // A file the user edited stays, orphaned: upstream dropping it is not
      // consent to delete their work.
      continue;
    }

    if (B === undefined) {
      if (Wn === undefined) {
        try {
          copyOneFile(srcAbs, destAbs);
          nextBaseline[rel] = Pn;
        } catch (err) {
          result.errors.push({ id, message: `${rel}: ${(err as Error).message}` });
        }
      } else if (Wn === Pn) {
        nextBaseline[rel] = Pn; // already identical — adopt, do not shout
      } else if (dismissed[rel] === Pn) {
        nextDismissed[rel] = Pn;
      } else {
        conflict('user-created-at-upstream-path');
      }
      continue;
    }

    if (Pn === B) {
      // Nothing shipped changed. Whatever the store says stands.
      nextBaseline[rel] = B;
      if (dismissed[rel]) nextDismissed[rel] = dismissed[rel]!;
      continue;
    }

    // Pn !== B: the shipped file moved.
    if (Wn === B) {
      try {
        copyOneFile(srcAbs, destAbs);
        nextBaseline[rel] = Pn;
        result.fastForwarded.push({ id, relPath: rel });
      } catch (err) {
        nextBaseline[rel] = B;
        result.errors.push({ id, message: `${rel}: ${(err as Error).message}` });
      }
      continue;
    }
    if (Wn === Pn) {
      nextBaseline[rel] = Pn;
      continue;
    }
    if (dismissed[rel] === Pn) {
      nextBaseline[rel] = B;
      nextDismissed[rel] = Pn;
      continue;
    }
    nextBaseline[rel] = B;
    conflict(Wn === undefined ? 'user-deleted-and-changed' : 'changed-upstream');
  }

  entry.baseline = nextBaseline;
  entry.dismissed = Object.keys(nextDismissed).length ? nextDismissed : undefined;
  entry.updateAvailable = Object.keys(nextUpdateAvailable).length ? nextUpdateAvailable : undefined;
}

/**
 * Bring the store in line with what ships, without ever losing a byte the user
 * wrote. Idempotent; runs at boot before the agent server starts, so the CLI
 * can never read a half-copied `SKILL.md`.
 */
export async function reconcile(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const pristine = opts.pristine ?? readPristineManifest(getPristineSkillsDir());
  const version = opts.appVersion ?? app.getVersion();
  fs.mkdirSync(getSkillsStoreDir(), { recursive: true });

  const { value: result } = await updateSkillsState((state) => {
    const out = emptyResult(pristine.rootHash);
    out.pristineUnavailable = !pristine.available;

    // WHEN THE SHIPPED TREE CANNOT BE READ, DO NOTHING THAT DEPENDS ON IT.
    //
    // Three of the passes below reason from a skill's ABSENCE in the manifest,
    // and an unreadable root makes everything absent: adoption and recovery
    // would classify shipped built-ins as `custom` with no baseline, and the
    // dropped-upstream pass would delete the unmodified ones outright and
    // permanently erase the baselines of the rest. All three are irreversible;
    // skipping them costs one boot and self-heals. Seeding and the per-file
    // table iterate the manifest itself, so they are already inert.
    //
    // This is not hypothetical — the root is inside the app bundle, which can
    // be on an ejected volume, translocated, moved to the Trash while running,
    // or (in dev) taken away by a branch switch. See `PristineManifest.available`.
    if (!pristine.available) {
      log.error(
        `[Skills] The shipped skill tree at ${pristine.root} is missing or empty. `
        + 'Leaving the store exactly as it is — seeding, adoption, recovery and '
        + 'dropped-upstream handling are all skipped, because every one of them '
        + 'would read "not shipped any more" from a tree we simply could not read.',
      );
      return out;
    }

    // The hash clause is what makes a dev `git pull` behave identically to a
    // release: the version string does not move, the tree does.
    out.upgraded =
      state.seededAppVersion !== version || state.pristineRootHash !== pristine.rootHash;

    if (opts.workspaceDir) adoptRenderDirectories(opts.workspaceDir, state, pristine, out);

    // Recovery: a store directory the state file does not know about. Classify
    // it by comparing against pristine rather than re-seeding, so a lost state
    // file costs preferences and never bytes.
    for (const id of storeIds()) {
      if (state.skills[id]) continue;
      const shipped = pristine.skills.get(id);
      // B24, recovery half. Same split as adoption above and for the same
      // reason, with the same deliberate exception: a recovered directory that
      // matches a shipped skill stays enabled, because the case this branch
      // exists for is a LOST STATE FILE, and answering that by turning the
      // user's whole roster off would be a worse outcome than the one it is
      // guarding against. An unrecognised directory has no such claim.
      state.skills[id] = shipped
        ? { origin: 'builtin', enabled: true, baseline: { ...shipped.files } }
        : { origin: 'custom', enabled: false, createdAt: nowIso() };
      out.recovered.push(id);
      log.info(`[Skills] Recovered untracked store directory ${id} as ${state.skills[id]!.origin}`);
    }

    // Seed: anything that ships and is not in the store. Covers first run, a
    // new built-in in a release, and self-healing a directory that was deleted
    // out from under us.
    for (const [id, shipped] of pristine.skills) {
      const entry = state.skills[id];
      if (entry?.removed) continue; // the user removed it; do not re-seed
      if (entry && entry.origin !== 'builtin') continue; // retagged custom — theirs now
      if (entry && isDirectorySync(skillStorePath(id))) continue;
      try {
        fs.rmSync(skillStorePath(id), { recursive: true, force: true });
        copyTree(shipped.dir, skillStorePath(id));
        state.skills[id] = {
          ...(entry ?? {}),
          origin: 'builtin',
          enabled: entry?.enabled ?? true,
          baseline: { ...shipped.files },
          dismissed: undefined,
          updateAvailable: undefined,
        };
        out.seeded.push(id);
        log.info(`[Skills] Seeded ${id} from the shipped tree`);
      } catch (err) {
        out.errors.push({ id, message: (err as Error).message });
        log.warn(`[Skills] Could not seed ${id}: ${(err as Error).message}`);
      }
    }

    // The per-file table. Only on an upgrade — on an ordinary boot nothing
    // shipped has moved, so every row would be a no-op at the cost of hashing
    // the whole store.
    if (out.upgraded) {
      for (const [id, entry] of Object.entries(state.skills)) {
        if (entry.origin !== 'builtin' || entry.removed) continue;
        const shipped = pristine.skills.get(id);
        if (!shipped) continue;
        reconcileSkillFiles(id, entry, shipped, out);
      }
    }

    // Dropped upstream. Presence-driven, so it runs every boot.
    for (const [id, entry] of Object.entries(state.skills)) {
      if (entry.origin !== 'builtin') continue;
      if (pristine.skills.has(id)) continue;
      if (entry.removed) {
        // Removed by the user and then dropped upstream: nothing left to hold.
        delete state.skills[id];
        continue;
      }
      if (!fs.existsSync(skillStorePath(id))) {
        delete state.skills[id];
        continue;
      }
      // B21. Two things were wrong here, and the second was the dangerous one.
      //
      // (1) The guard was `modifiedFiles(...).length === 0` alone, and
      //     `modifiedFiles` deliberately skips host-owned paths. So a skill
      //     carrying a hundred accumulated findings and no edits to its shipped
      //     files read "unmodified" — invisible to the very test deciding
      //     whether erasing it was safe. `hostOwnedFiles` asks the other half.
      // (2) The delete was a bare `rmSync`, bypassing the trash route every
      //     other destructive op in this module uses and the rule at the top of
      //     the file. Nothing to recover from, and no warning.
      //
      // Never reachable before 0.1.9 (no release had retired a shipped skill),
      // but `differential-expression` is recorded in CLAUDE.md as unrunnable
      // and staged for exactly that, which is what turns this from latent into
      // a blocker.
      const findings = hostOwnedFiles(id, entry);
      if (modifiedFiles(id, entry).length === 0 && findings.length === 0) {
        try {
          // Through the trash, like every other destructive path.
          const trashPath = newTrashDir(id);
          moveInto(skillStorePath(id), path.join(trashPath, id));
          delete state.skills[id];
          out.removedUpstream.push(id);
          log.info(`[Skills] ${id} no longer ships and was unmodified — moved to ${trashPath}`);
        } catch (err) {
          out.errors.push({ id, message: (err as Error).message });
        }
      } else if (findings.length > 0 && modifiedFiles(id, entry).length === 0) {
        // Unmodified, but it has learned something. Keep it for the same reason
        // an edited skill is kept: the knowledge is the user's, and upstream
        // dropping the skill is not consent to discard it.
        entry.origin = 'custom';
        entry.formerlyBuiltin = true;
        entry.baseline = undefined;
        entry.dismissed = undefined;
        entry.updateAvailable = undefined;
        out.keptAsCustom.push(id);
        log.info(
          `[Skills] ${id} no longer ships but holds ${findings.length} host-owned file(s) `
          + '— kept as a custom skill',
        );
      } else {
        // Their edits are theirs. Anthropic dropping a skill from our tree is
        // not consent to delete the user's work — this is precisely the case
        // the old prune loop got catastrophically wrong.
        entry.origin = 'custom';
        entry.formerlyBuiltin = true;
        entry.baseline = undefined;
        entry.dismissed = undefined;
        entry.updateAvailable = undefined;
        out.keptAsCustom.push(id);
        log.info(`[Skills] ${id} no longer ships but had local edits — kept as a custom skill`);
      }
    }

    // A non-builtin entry whose directory is gone describes nothing. Drop the
    // row rather than render a skill with no bytes.
    for (const [id, entry] of Object.entries(state.skills)) {
      if (entry.removed || entry.origin === 'builtin') continue;
      if (!fs.existsSync(skillStorePath(id))) {
        delete state.skills[id];
        log.info(`[Skills] Dropped ${id} from the index — its store directory is gone`);
      }
    }

    state.seededAppVersion = version;
    state.pristineRootHash = pristine.rootHash;
    return out;
  });

  log.info(
    `[Skills] Reconcile ${result.upgraded ? '(upgrade)' : '(no change)'}: ` +
      `${result.seeded.length} seeded, ${result.fastForwarded.length} fast-forwarded, ` +
      `${result.conflicts.length} conflict(s), ${result.adopted.length} adopted, ` +
      `${result.migrated.length} pre-migration copies removed, ${result.errors.length} error(s)`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface SkillMutationResult {
  ok: boolean;
  error?: string;
  /** Where the previous bytes went, when this operation moved any. */
  trashPath?: string;
  /** The id actually written — create may have been asked for a taken name. */
  id?: string;
}

/**
 * Read one file out of a skill. Rejects anything that escapes the skill dir.
 *
 * BOTH halves of the path are checked, and the id is the one that matters more.
 * `resolveWithin` only stops `relPath` escaping its base — but the base is
 * `join(storeDir, id)`, so an unvalidated `id` MOVES the base: `id = '..'`
 * lands it on userData, where every `relPath` under it then reads as "inside
 * the skill". That is a read of `agent.json`, which holds the raw API key, and
 * of `cobuilding-settings.json`. `writeSkillFile` has always validated the id;
 * this did not, and the asymmetry was the bug.
 */
export async function readSkillFile(id: string, relPath: string): Promise<string> {
  const idCheck = validateSkillId(id);
  if (!idCheck.ok) throw new Error(idCheck.error);
  const abs = resolveWithin(skillStorePath(id), relPath);
  if (!abs) throw new Error(`Invalid path "${relPath}" in skill ${id}.`);
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * Write one file into a skill, creating the skill as `custom` when it is new.
 *
 * This is the paved road for the agent's `write_skill_file` tool and for the
 * panel's Save. Raw `Edit` through the render symlink also works and is
 * correct — that is the point of the symlink — but it leaves the index to be
 * caught up at the next reconcile.
 */
export async function writeSkillFile(
  id: string,
  relPath: string,
  content: string,
  opts: { origin?: SkillOrigin } = {},
): Promise<SkillMutationResult> {
  const idCheck = validateSkillId(id);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };

  const dir = skillStorePath(id);
  const abs = resolveWithin(dir, relPath);
  if (!abs) return { ok: false, error: `Invalid path "${relPath}" in skill ${id}.` };

  const { value } = await updateSkillsState((state): SkillMutationResult => {
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const entry = state.skills[id];
    if (!entry) {
      state.skills[id] = {
        origin: opts.origin ?? 'custom',
        enabled: true,
        createdAt: nowIso(),
      };
    } else if (entry.removed) {
      entry.removed = false;
    }
    return { ok: true, id };
  });
  if (value.ok) log.info(`[Skills] Wrote ${id}/${relPath}`);
  return value;
}

const NEW_SKILL_TEMPLATE = (id: string, description: string) =>
  `---\nname: ${id}\ndescription: >\n  ${description}\n---\n\n# ${id}\n\nWhat Claude should do when this skill activates.\n`;

/**
 * Scaffold a new skill. The id is the directory name and therefore the name
 * the model types into `Skill({skill})`, so it is validated rather than
 * sanitized — an id we silently rewrote would no longer match the directory.
 */
export async function createSkill(
  id: string,
  opts: { description?: string } = {},
): Promise<SkillMutationResult> {
  const idCheck = validateSkillId(id);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };

  const { value } = await updateSkillsState((state): SkillMutationResult => {
    if (state.skills[id] && !state.skills[id]!.removed) {
      return { ok: false, error: `A skill called "${id}" already exists.` };
    }
    if (fs.existsSync(skillStorePath(id))) {
      return { ok: false, error: `A directory called "${id}" already exists in the store.` };
    }
    const description =
      opts.description?.trim() || 'Describe when Claude should use this skill.';
    try {
      fs.mkdirSync(skillStorePath(id), { recursive: true });
      fs.writeFileSync(path.join(skillStorePath(id), 'SKILL.md'), NEW_SKILL_TEMPLATE(id, description));
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    state.skills[id] = { origin: 'custom', enabled: true, createdAt: nowIso() };
    return { ok: true, id };
  });
  if (value.ok) log.info(`[Skills] Created custom skill ${id}`);
  return value;
}

/**
 * Everything an import has to record. Assembled by `skillImporter`'s
 * `FetchedSkill`, which is the only thing that produces a staged tree.
 *
 * There is deliberately NO `enabled` field. Imports start off the roster and
 * that is not a caller's decision to make — see `registerImportedSkill`.
 */
export interface ImportRegistration {
  /** Store id. The SOURCE directory name unless the user picked another. */
  id: string;
  /**
   * The staged tree, which is MOVED into the store. Owned by this call from
   * here on: on success it no longer exists at the old path.
   */
  stagingDir: string;
  source: SkillSource;
  declared: SkillDeclaredMetadata;
  aliasOfDirName: boolean;
  /** relPath -> git blob SHA at the pinned commit. "Has upstream changed?" */
  upstreamBlobs: Record<string, string>;
  fileCount: number;
  execCount: number;
  importedVia: 'ui' | 'agent';
  /** Marketplace name when the skill came out of a catalogue, else 'direct'. */
  importedFrom?: string;
}

/**
 * Depth-first search for a surviving symlink, synchronously.
 *
 * `lstat` semantics via `withFileTypes`, so a symlink-to-directory is seen as a
 * link and never recursed into.
 */
function findSymlink(dir: string, rel = ''): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return relPath;
    if (entry.isDirectory()) {
      const nested = findSymlink(path.join(dir, entry.name), relPath);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Move a staged import into the store and write its provenance.
 *
 * The ONE registration path: the GitHub subtree, the catalogue pick and the
 * local folder all arrive here, so there is a single place where the record is
 * written and a single place enforcing the two rules below.
 *
 * **`enabled: false`, always, and not negotiable.** The roster is a fixed
 * character budget that Acabox is already over, and past `dK8 = 20` characters
 * per skill the CLI drops descriptions entirely and emits bare `- name` lines
 * — silently, with no error and no log. So an unbudgeted import does not cost
 * the user the imported skill, it costs them every OTHER skill's ability to
 * activate. That is far too destructive to leave to a caller, which is why
 * `ImportRegistration` has no `enabled` field to pass and why this writes the
 * literal.
 *
 * **A collision refuses; it never renames and never replaces.** §7 of the
 * design doc leaves the policy open and `resolveImportId` picks it: the id is
 * what the model types into `Skill({skill})` and what the skill's own prose
 * refers to, so a silent suffix produces a skill whose body names something
 * that does not exist — and a silent replace destroys a built-in behind a
 * button labelled "Import". Refusing is the only non-destructive answer, and
 * the caller has `resolveImportId`'s `suggestedId` to offer as one click. Note
 * this refuses against a `removed: true` entry too: that record is what
 * `restoreAllBuiltins` uses to bring the built-in back, so overwriting it
 * would quietly forfeit the restore.
 *
 * Two hash sets are written, and the pairing is the point. `upstreamBlobs`
 * (git blob SHAs, from the archive) answers "has upstream changed"; `baseline`
 * (sha256, taken from the store right after the move) answers "have I changed
 * it". One alone cannot express taking an upstream fix to `scripts/run.py`
 * while keeping accreted edits to `SKILL.md`.
 */
export async function registerImportedSkill(reg: ImportRegistration): Promise<SkillMutationResult> {
  const idCheck = validateSkillId(reg.id);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };

  // The last gate before bytes become permanent. Every real caller has already
  // run `stripSymlinks`, so this can only fire on a path that skipped the
  // safety pass — and it refuses rather than stripping quietly, because the
  // user has just been shown a disclosure listing what was removed and that
  // list has to stay true.
  const link = findSymlink(reg.stagingDir);
  if (link) {
    return {
      ok: false,
      error:
        `"${link}" is a symlink, and an imported skill may not contain one. ` +
        'This payload did not go through the importer\'s safety pass.',
    };
  }

  const { value } = await updateSkillsState((state): SkillMutationResult => {
    if (state.skills[reg.id]) {
      return {
        ok: false,
        error: `A skill called "${reg.id}" already exists. Import it under a different name.`,
      };
    }
    if (fs.existsSync(skillStorePath(reg.id))) {
      return { ok: false, error: `A directory called "${reg.id}" already exists in the store.` };
    }

    try {
      moveInto(reg.stagingDir, skillStorePath(reg.id));
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    const at = nowIso();
    state.skills[reg.id] = {
      origin: 'imported',
      // Not a caller's decision. See the header.
      enabled: false,
      createdAt: at,
      source: reg.source,
      importedAt: at,
      importedVia: reg.importedVia,
      importedFrom: reg.importedFrom,
      // `upstreamTreeSha` is deliberately absent. It is a GitHub tree object
      // id, and the import path is the codeload tarball — which costs zero API
      // calls precisely because it never asks for one. Recomputing it locally
      // would not give upstream's value either: we strip symlinks, so our tree
      // would diverge from theirs on exactly the skills where it matters.
      // `checkForUpdate` returns the real one when the user asks.
      upstreamBlobs: reg.upstreamBlobs,
      baseline: hashSkillFiles(skillStorePath(reg.id)),
      declared: reg.declared,
      aliasOfDirName: reg.aliasOfDirName,
      fileCount: reg.fileCount,
      execCount: reg.execCount,
      hostOwnedPaths: [...HOST_OWNED_SKILL_PATHS],
    };
    return { ok: true, id: reg.id };
  });

  if (value.ok) {
    log.info(
      `[Skills] Imported ${reg.id} (${reg.fileCount} file(s), ${reg.execCount} executable(s)) ` +
        `from ${reg.source.kind === 'github-subdir'
          ? `${reg.source.owner}/${reg.source.repo}@${(reg.source.sha ?? '').slice(0, 7)}`
          : reg.source.localPath} — off the roster until enabled`,
    );
  }
  return value;
}

/**
 * Remove a skill. The verbs differ in the UI because the operations differ:
 * a custom skill is Deleted (record and bytes both go), a built-in is Removed
 * (`removed: true` survives so the seeder does not immediately bring it back
 * and so `restoreAllBuiltins` can).
 */
export async function deleteSkill(id: string): Promise<SkillMutationResult> {
  const { value } = await updateSkillsState((state): SkillMutationResult => {
    // B25. Guarded in the function rather than at the `skills:delete` IPC, so
    // every caller is covered rather than the one that happened to be noticed.
    const idCheck = validateSkillId(id);
    if (!idCheck.ok) return { ok: false, error: idCheck.error };

    const entry = state.skills[id];
    if (!entry) return { ok: false, error: `No skill called "${id}".` };
    if (entry.removed) return { ok: true, id };

    let trashPath: string | undefined;
    if (fs.existsSync(skillStorePath(id))) {
      try {
        trashPath = newTrashDir(id);
        moveInto(skillStorePath(id), path.join(trashPath, id));
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    if (entry.origin === 'builtin') {
      entry.removed = true;
      entry.updateAvailable = undefined;
    } else {
      delete state.skills[id];
    }
    return { ok: true, id, trashPath };
  });
  if (value.ok) log.info(`[Skills] Removed ${id} (fork kept at ${value.trashPath ?? 'nothing to keep'})`);
  return value;
}

/**
 * On or off the roster.
 *
 * Not a sandbox and not a disk-level mechanism: a disabled skill keeps every
 * byte and keeps its render symlink, and only stops costing roster characters.
 * `buildSkillRuntimeConfig` is the enforcement — see its comment for why the
 * render must NOT skip disabled skills.
 */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<SkillMutationResult> {
  const { value } = await updateSkillsState((state): SkillMutationResult => {
    const entry = state.skills[id];
    if (!entry) return { ok: false, error: `No skill called "${id}".` };
    if (entry.removed && enabled) {
      return { ok: false, error: `"${id}" was removed. Restore it before enabling it.` };
    }
    entry.enabled = enabled;
    return { ok: true, id };
  });
  return value;
}

/** "Keep mine" — the conflict stays dismissed until the NEXT release moves it. */
export async function dismissFileUpdate(id: string, relPath: string): Promise<SkillMutationResult> {
  const { value } = await updateSkillsState((state): SkillMutationResult => {
    const entry = state.skills[id];
    if (!entry) return { ok: false, error: `No skill called "${id}".` };
    const upstream = entry.updateAvailable?.[relPath];
    if (!upstream) return { ok: false, error: `No pending update for ${id}/${relPath}.` };
    entry.dismissed = { ...(entry.dismissed ?? {}), [relPath]: upstream };
    const remaining = { ...entry.updateAvailable };
    delete remaining[relPath];
    entry.updateAvailable = Object.keys(remaining).length ? remaining : undefined;
    return { ok: true, id };
  });
  return value;
}

/**
 * Put one file back to what shipped.
 *
 * Rename-to-trash, then copy-from-pristine. Never a bare delete, and never a
 * copy over a live file: the destination has just been renamed away, so
 * `cpSync` writes into nothing and cannot hit the `EACCES` /
 * `ERR_FS_CP_DIR_TO_NON_DIR` classes that brick boot today.
 */
export async function revertFile(id: string, relPath: string): Promise<SkillMutationResult> {
  const pristine = readPristineManifest(getPristineSkillsDir());
  const shipped = pristine.skills.get(id);

  const { value } = await updateSkillsState((state): SkillMutationResult => {
    const entry = state.skills[id];
    if (!entry) return { ok: false, error: `No skill called "${id}".` };
    if (entry.origin !== 'builtin') {
      return { ok: false, error: `"${id}" is not a built-in skill, so there is nothing to revert to.` };
    }
    if (isHostOwned(relPath, hostOwnedPathsFor(entry))) {
      return { ok: false, error: `${relPath} is written by Acabox, not by the shipped skill.` };
    }
    if (!shipped) {
      return { ok: false, error: `"${id}" is no longer part of this version of Acabox.` };
    }
    const src = resolveWithin(shipped.dir, relPath);
    const dest = resolveWithin(skillStorePath(id), relPath);
    if (!src || !dest) return { ok: false, error: `Invalid path "${relPath}".` };
    if (!fs.existsSync(src)) {
      // Nothing to revert TO. Refusing with a real message is the only honest
      // answer; fabricating a "restored" state would be a mock.
      return { ok: false, error: `${relPath} is not part of the shipped ${id} skill.` };
    }

    let trashPath: string | undefined;
    try {
      if (fs.existsSync(dest)) {
        trashPath = newTrashDir(id);
        moveInto(dest, path.join(trashPath, relPath));
      }
      copyOneFile(src, dest);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    entry.baseline = { ...(entry.baseline ?? {}), [relPath]: shipped.files[relPath]! };
    if (entry.dismissed) {
      const next = { ...entry.dismissed };
      delete next[relPath];
      entry.dismissed = Object.keys(next).length ? next : undefined;
    }
    if (entry.updateAvailable) {
      const next = { ...entry.updateAvailable };
      delete next[relPath];
      entry.updateAvailable = Object.keys(next).length ? next : undefined;
    }
    return { ok: true, id, trashPath };
  });
  if (value.ok) log.info(`[Skills] Reverted ${id}/${relPath}`);
  return value;
}

/**
 * Put a whole skill back to what shipped.
 *
 * Files the user ADDED inside the skill go to the trash with the rest — stated
 * verbatim in the confirm dialog, because it is the one surprising part. Files
 * under a host-owned path do not: they are lifted out of the fork and put back
 * afterwards, so a Revert cannot cost the user a findings ledger.
 */
export async function revertSkill(id: string): Promise<SkillMutationResult> {
  const pristine = readPristineManifest(getPristineSkillsDir());
  const shipped = pristine.skills.get(id);

  const { value } = await updateSkillsState((state): SkillMutationResult => {
    const entry = state.skills[id];
    if (!entry) return { ok: false, error: `No skill called "${id}".` };
    if (entry.origin !== 'builtin') {
      return { ok: false, error: `"${id}" is not a built-in skill, so there is nothing to revert to.` };
    }
    if (!shipped) {
      return { ok: false, error: `"${id}" is no longer part of this version of Acabox.` };
    }

    const dir = skillStorePath(id);
    const hostOwned = hostOwnedPathsFor(entry);
    const preserve = fs.existsSync(dir)
      ? readSkillTree(dir).map((f) => f.relPath).filter((rel) => isHostOwned(rel, hostOwned))
      : [];

    let trashPath: string | undefined;
    try {
      if (fs.existsSync(dir)) {
        trashPath = newTrashDir(id);
        moveInto(dir, path.join(trashPath, id));
      }
      copyTree(shipped.dir, dir);
      for (const rel of preserve) {
        copyOneFile(path.join(trashPath!, id, rel), path.join(dir, rel));
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    entry.baseline = { ...shipped.files };
    entry.dismissed = undefined;
    entry.updateAvailable = undefined;
    entry.removed = undefined;
    return { ok: true, id, trashPath };
  });
  if (value.ok) log.info(`[Skills] Reverted skill ${id} (fork kept at ${value.trashPath})`);
  return value;
}

export interface RestoreBuiltinsSummary {
  /** Built-ins with at least one modified file. */
  modified: string[];
  /** Built-ins the user removed. */
  removed: string[];
  /** Custom and imported skills, which a restore cannot touch. */
  unaffected: string[];
}

/**
 * The real counts behind the confirm dialog, computed BEFORE the call so the
 * copy quotes measured numbers instead of a guess.
 */
export async function summarizeBuiltinRestore(): Promise<RestoreBuiltinsSummary> {
  const state = await readSkillsState();
  const summary: RestoreBuiltinsSummary = { modified: [], removed: [], unaffected: [] };
  for (const [id, entry] of Object.entries(state.skills)) {
    if (entry.origin !== 'builtin') {
      summary.unaffected.push(id);
      continue;
    }
    if (entry.removed) summary.removed.push(id);
    else if (modifiedFiles(id, entry).length > 0) summary.modified.push(id);
  }
  return summary;
}

export interface RestoreBuiltinsResult {
  reverted: string[];
  restored: string[];
  errors: Array<{ id: string; message: string }>;
}

/**
 * Put every built-in back to what shipped.
 *
 * The guarantee that it cannot touch a custom or imported skill comes from the
 * data model, not from care in the loop: the iteration is over entries FILTERED
 * by `origin === 'builtin'`, so there is no code path from here to anyone
 * else's bytes. Keep it that way.
 */
export async function restoreAllBuiltins(): Promise<RestoreBuiltinsResult> {
  const state = await readSkillsState();
  const builtins = Object.entries(state.skills)
    .filter(([, entry]) => entry.origin === 'builtin')
    .map(([id]) => id)
    .sort();

  const out: RestoreBuiltinsResult = { reverted: [], restored: [], errors: [] };
  for (const id of builtins) {
    const entry = (await readSkillsState()).skills[id];
    if (!entry || entry.origin !== 'builtin') continue;
    const wasRemoved = !!entry.removed;
    const needsRevert = wasRemoved || modifiedFiles(id, entry).length > 0;

    if (needsRevert) {
      const result = await revertSkill(id);
      if (!result.ok) {
        out.errors.push({ id, message: result.error ?? 'unknown error' });
        continue;
      }
      if (wasRemoved) out.restored.push(id);
      else out.reverted.push(id);
    }
    await setSkillEnabled(id, true);
  }
  log.info(
    `[Skills] Restored built-ins: ${out.reverted.length} reverted, ` +
      `${out.restored.length} brought back, ${out.errors.length} error(s)`,
  );
  return out;
}

/**
 * Hash of one store file, for the editor's version check: hash at open,
 * re-hash at save, and on a mismatch show the conflict affordance rather than
 * silently overwriting an edit the agent made while the panel was open.
 */
export function skillFileHash(id: string, relPath: string): string | undefined {
  // Same id-moves-the-base hazard as `readSkillFile`; this one leaks existence
  // and a content hash rather than the bytes, which is still an answer about a
  // file outside the store.
  if (!validateSkillId(id).ok) return undefined;
  const abs = resolveWithin(skillStorePath(id), relPath);
  if (!abs) return undefined;
  return hashFileIf(abs);
}
