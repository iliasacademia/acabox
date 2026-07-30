/**
 * The import flow, between `skillImporter` (which knows how to get bytes) and
 * `skillStore` (which knows how to keep them).
 *
 * It exists for one reason the IPC handlers cannot supply on their own: an
 * import is FOUR user gestures — paste a URL, browse a catalogue, preview a
 * skill, commit it — and naively each one would download the repository again.
 * `openai/plugins` is 21.7 MB and takes about six seconds, so re-downloading
 * per gesture turns a four-click flow into half a minute of waiting for bytes
 * that never left the machine. Everything here is that cache and its lifetime.
 *
 * TWO CACHES, DIFFERENT LIFETIMES
 * -------------------------------
 * - **The catalogue.** One at a time, keyed by the resolved commit SHA and the
 *   scope. Holding a second would double 60 MB of unpacked tree for no benefit
 *   — the picker shows one repository. Superseded means disposed.
 * - **Staged skills.** Small (a skill is a few hundred KB at worst) and one per
 *   preview, so several may be live if the user looks at three skills before
 *   picking one. A staged tree has already been through the safety pass, so
 *   committing it is a move rather than a re-fetch.
 *
 * Both live under `os.tmpdir()` and both are disposed by `disposeImportCaches`,
 * which the renderer calls when the modal closes. Nothing here survives a
 * restart, and nothing needs to: a pinned SHA fetches identically tomorrow.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No update check on a timer, no background prefetch, no "popular skills" list.
 * `api.github.com` is 60 requests per hour for the whole machine and the only
 * thing that spends it here is `resolveRef` — one call per URL the user pastes.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import log from 'electron-log';

import {
  fetchCatalogue,
  fetchSubtree,
  importFromCatalogue,
  importLocalFolder,
  parseGithubUrl,
  resolveImportId,
  resolveRef,
  type CatalogueSkill,
  type DownloadProgress,
  type FetchedSkill,
  type SkillCatalogue,
  type SkillImportProblem,
  type StrippedLink,
} from './skillImporter';
import { readSkillsState, registerImportedSkill } from '../skillStore';
import type { SkillSource } from '../../shared/skills';

// ---------------------------------------------------------------------------
// Wire shapes — everything below crosses IPC, so it is plain data
// ---------------------------------------------------------------------------

export interface ImportUrlTarget {
  owner: string;
  repo: string;
  /** The ref as pasted, for display. The pin is `sha`. */
  ref?: string;
  /** Resolved 40-char commit SHA. Never a branch. */
  sha: string;
  subpath: string;
}

export type ImportTargetKind = 'catalogue' | 'skill';

export interface ParsedImportUrl extends ImportUrlTarget {
  /**
   * `catalogue` when the URL names a repository root, `skill` when it names a
   * subdirectory.
   *
   * This is a classification of the URL, not of the repository, and it cannot
   * be anything else without downloading first: whether a root holds one skill
   * or six hundred is a fact about its bytes. It is honest because it is what
   * the user asked for — a root means "show me what is in here", a deep link
   * means "I want that one". A root that turns out to hold no skills at all
   * reports zero entries, which is the true answer to the question asked.
   */
  kind: ImportTargetKind;
  /** Canonical https URL to the exact tree at the pinned commit. */
  url: string;
}

export type ImportRequest =
  | { kind: 'github-subdir'; owner: string; repo: string; sha: string; ref?: string; subpath: string }
  | { kind: 'local-folder'; localPath: string };

export interface CatalogueResult {
  owner: string;
  repo: string;
  ref?: string;
  sha: string;
  /** `marketplace.json`'s own name, when the repo has one. */
  marketplaceName?: string;
  /** Bytes downloaded, so the UI can state what the browse actually cost. */
  archiveBytes: number;
  skills: CatalogueSkill[];
}

/**
 * Everything the confirm screen shows. The `SKILL.md` body is included in full
 * and on purpose: it is instructions the model will follow, and the design's
 * safety position is that the user reads it before committing.
 */
export interface SkillImportPreview {
  /** The id this would take — the SOURCE directory name, never rewritten. */
  id: string;
  /** `id` is already used in the store. */
  collides: boolean;
  /** A free id offered as one click. Never applied automatically. */
  suggestedId?: string;
  declaredName?: string;
  description?: string;
  whenToUse?: string;
  license?: string;
  frontmatterOk: boolean;
  frontmatterError?: string;
  skillMd: string;
  skillMdBytes: number;
  fileCount: number;
  execCount: number;
  /** Named, not just counted — "1 SCRIPT" says much less than `scripts/run.py`. */
  execPaths: string[];
  totalBytes: number;
  strippedSymlinks: StrippedLink[];
  problems: SkillImportProblem[];
  source: SkillSource;
}

export type ImportProgress =
  | { phase: 'downloading'; receivedBytes: number }
  | { phase: 'extracting' };

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

interface CachedCatalogue {
  key: string;
  catalogue: SkillCatalogue;
}

let cachedCatalogue: CachedCatalogue | null = null;
const stagedSkills = new Map<string, FetchedSkill>();

function catalogueKey(t: { owner: string; repo: string; sha: string; subpath?: string }): string {
  return `${t.owner}/${t.repo}@${t.sha}#${t.subpath ?? ''}`;
}

function requestKey(req: ImportRequest): string {
  return req.kind === 'local-folder'
    ? `local:${req.localPath}`
    : `${req.owner}/${req.repo}@${req.sha}:${req.subpath}`;
}

async function stagingDir(): Promise<string> {
  // A directory *inside* a fresh mkdtemp, because both `fs.cp` and the tar
  // extraction want a destination that does not exist yet.
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'acabox-import-'));
  return path.join(parent, 'skill');
}

/** Remove a staged tree and the mkdtemp parent it sits in. */
async function discardStaged(fetched: FetchedSkill): Promise<void> {
  await fsp.rm(path.dirname(fetched.path), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Drop everything held for the import UI. Called when the modal closes and
 * before the caches are replaced.
 *
 * Safe to call at any time: a staged tree that has already been committed is no
 * longer in the map, because registration MOVED it into the store.
 */
export async function disposeImportCaches(): Promise<void> {
  const catalogue = cachedCatalogue;
  cachedCatalogue = null;
  const staged = [...stagedSkills.values()];
  stagedSkills.clear();

  if (catalogue) await catalogue.catalogue.dispose();
  for (const fetched of staged) await discardStaged(fetched);
  if (catalogue || staged.length) {
    log.info(`[SkillImport] Disposed catalogue cache and ${staged.length} staged import(s)`);
  }
}

// ---------------------------------------------------------------------------
// Step 1 — what did the user paste?
// ---------------------------------------------------------------------------

/**
 * Parse the pasted text and resolve its ref to a commit SHA.
 *
 * The SHA is resolved HERE, before anything is downloaded or shown, because a
 * pin recorded as a branch name is not a pin — every later step carries the
 * resolved value, so the catalogue the user browses and the skill they commit
 * are guaranteed to be the same bytes even if the branch moves in between.
 *
 * Costs one `api.github.com` request, or zero when the URL already names a full
 * SHA.
 */
export async function parseImportUrl(input: string): Promise<ParsedImportUrl> {
  const target = parseGithubUrl(input);
  if (!target) {
    throw new Error(
      'That does not look like a GitHub link. Paste a repository URL, or a link to a ' +
        'folder inside one — for example https://github.com/anthropics/skills.',
    );
  }
  const sha = await resolveRef(target.owner, target.repo, target.ref);
  const suffix = target.subpath ? `/${target.subpath}` : '';
  return {
    owner: target.owner,
    repo: target.repo,
    ref: target.ref,
    sha,
    subpath: target.subpath,
    kind: target.subpath ? 'skill' : 'catalogue',
    url: `https://github.com/${target.owner}/${target.repo}/tree/${sha}${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — the browse list
// ---------------------------------------------------------------------------

/**
 * Enumerate every skill in a repository. One tarball, zero further API calls,
 * and the result is cached for the session so picking a second skill out of the
 * same catalogue costs nothing.
 */
export async function loadCatalogue(
  target: ImportUrlTarget,
  onProgress?: (p: ImportProgress) => void,
): Promise<CatalogueResult> {
  const key = catalogueKey(target);
  if (cachedCatalogue?.key === key) {
    const c = cachedCatalogue.catalogue;
    log.info(`[SkillImport] Reusing cached catalogue ${key} (${c.skills.length} skills)`);
    return {
      owner: c.owner,
      repo: c.repo,
      ref: c.ref,
      sha: c.sha,
      marketplaceName: c.marketplaceName,
      archiveBytes: c.archiveBytes,
      skills: c.skills,
    };
  }

  // Replaced, not accumulated — one unpacked 21 MB repository at a time.
  if (cachedCatalogue) {
    const stale = cachedCatalogue;
    cachedCatalogue = null;
    await stale.catalogue.dispose();
  }

  const catalogue = await fetchCatalogue(
    { owner: target.owner, repo: target.repo, sha: target.sha, ref: target.ref, subpath: target.subpath },
    {
      // Bytes received and nothing else: codeload sends no `content-length`, so
      // there is no denominator and a percentage would be invented.
      onProgress: onProgress
        ? (p: DownloadProgress) => onProgress({ phase: 'downloading', receivedBytes: p.receivedBytes })
        : undefined,
    },
  );
  onProgress?.({ phase: 'extracting' });
  cachedCatalogue = { key, catalogue };

  return {
    owner: catalogue.owner,
    repo: catalogue.repo,
    ref: catalogue.ref,
    sha: catalogue.sha,
    marketplaceName: catalogue.marketplaceName,
    archiveBytes: catalogue.archiveBytes,
    skills: catalogue.skills,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — stage one skill and describe it
// ---------------------------------------------------------------------------

/**
 * The cached catalogue this request can be served out of, or null.
 *
 * A SHA match alone is not enough and the difference is not theoretical: a fork
 * shares its parent's commit ids, so `owner` and `repo` are what distinguish
 * `upstream/skills@abc` from `someone/skills@abc`. One predicate, used by both
 * the staging copy and the `importedFrom` attribution below — two answers to
 * "did this come out of the catalogue" would eventually disagree, and the way
 * they would disagree is a provenance record naming a marketplace the skill was
 * never in.
 */
function catalogueFor(req: Extract<ImportRequest, { kind: 'github-subdir' }>): SkillCatalogue | null {
  const cat = cachedCatalogue?.catalogue;
  if (!cat) return null;
  return cat.owner === req.owner && cat.repo === req.repo && cat.sha === req.sha ? cat : null;
}

/**
 * Get the bytes of one skill onto disk, safely, and remember where.
 *
 * Three sources, one exit: whichever way the tree arrived it has been through
 * `stripSymlinks`, `scanTree` and `validateImportedSkill` before this returns,
 * because all three call `describeExtractedSkill` inside the importer.
 *
 * When the skill lives in the already-downloaded catalogue this is a local
 * copy — no network at all. That is the whole payoff for holding the staging
 * directory open.
 */
async function stage(req: ImportRequest, onProgress?: (p: ImportProgress) => void): Promise<FetchedSkill> {
  const key = requestKey(req);
  const existing = stagedSkills.get(key);
  if (existing) return existing;

  const dest = await stagingDir();
  let fetched: FetchedSkill;

  try {
    if (req.kind === 'local-folder') {
      fetched = await importLocalFolder(req.localPath, dest);
    } else {
      const cat = catalogueFor(req);
      if (cat && cat.skills.some((s) => s.subpath === req.subpath)) {
        fetched = await importFromCatalogue(cat, req.subpath, dest);
      } else {
        fetched = await fetchSubtree(
          { owner: req.owner, repo: req.repo, sha: req.sha, ref: req.ref, subpath: req.subpath },
          dest,
          {
            onProgress: onProgress
              ? (p: DownloadProgress) => onProgress({ phase: 'downloading', receivedBytes: p.receivedBytes })
              : undefined,
          },
        );
      }
    }
  } catch (err) {
    // The FAILING path is the one that has to clean up after itself, and it is
    // also the common one — a typo in a subpath, a 404, a folder with no
    // SKILL.md. `importLocalFolder` and `fetchSubtree` both remove `dest`, but
    // the mkdtemp PARENT is ours and only ever reachable from here: nothing
    // recorded it, and `disposeImportCaches` walks the staged map, which a
    // throwing stage never got into. Without this every failed preview leaves
    // a directory in tmp for good.
    await fsp.rm(path.dirname(dest), { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  stagedSkills.set(key, fetched);
  return fetched;
}

/** Stage a skill and return everything the confirm screen has to state. */
export async function previewImport(
  req: ImportRequest,
  onProgress?: (p: ImportProgress) => void,
): Promise<SkillImportPreview> {
  const fetched = await stage(req, onProgress);
  const state = await readSkillsState();
  // Removed built-ins are included: their record is what a restore uses, so
  // their id is taken even though the directory is gone.
  const decision = resolveImportId(fetched.id, fetched.source, Object.keys(state.skills));

  return {
    id: fetched.id,
    collides: decision.collides,
    suggestedId: decision.suggestedId,
    declaredName: fetched.aliasOfDirName ? fetched.declared.name : undefined,
    description: fetched.declared.description,
    whenToUse: fetched.frontmatter.whenToUse,
    license: fetched.declared.license,
    frontmatterOk: fetched.frontmatter.ok,
    frontmatterError: fetched.frontmatter.error,
    skillMd: fetched.skillMd,
    skillMdBytes: fetched.skillMdBytes,
    fileCount: fetched.fileCount,
    execCount: fetched.execCount,
    execPaths: fetched.execPaths,
    totalBytes: fetched.totalBytes,
    strippedSymlinks: fetched.strippedSymlinks,
    problems: fetched.problems,
    source: fetched.source,
  };
}

// ---------------------------------------------------------------------------
// Step 4 — commit
// ---------------------------------------------------------------------------

export interface CommitImportResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/**
 * Move the staged skill into the store with its provenance record.
 *
 * `asId` is the user's answer to a collision or to an invalid source directory
 * name. It is a rename of the STORE entry only; nothing rewrites the skill's
 * own files, so the import baseline stays pristine and the row does not read
 * MODIFIED on the day it arrives.
 *
 * Staging is idempotent, so a caller that skipped the preview simply pays for
 * the fetch here.
 */
export async function commitImport(
  req: ImportRequest,
  asId?: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<CommitImportResult> {
  const fetched = await stage(req, onProgress);
  const importedFrom =
    req.kind === 'local-folder'
      ? 'local-folder'
      : catalogueFor(req)?.marketplaceName ?? 'direct';

  const result = await registerImportedSkill({
    id: asId?.trim() || fetched.id,
    stagingDir: fetched.path,
    source: fetched.source,
    declared: fetched.declared,
    aliasOfDirName: fetched.aliasOfDirName,
    upstreamBlobs: fetched.upstreamBlobs,
    fileCount: fetched.fileCount,
    execCount: fetched.execCount,
    importedVia: 'ui',
    importedFrom,
  });

  if (result.ok) {
    // The tree was moved, so the staging entry now names nothing. Dropping it
    // is not tidiness: leaving it would let a second commit register a skill
    // from a directory that no longer exists.
    stagedSkills.delete(requestKey(req));
    // …and the mkdtemp parent it sat in is now empty. `disposeImportCaches`
    // only sees entries still in the map, so without this a *successful*
    // import is the one path that leaks a directory into tmp forever.
    await fsp.rm(path.dirname(fetched.path), { recursive: true, force: true }).catch(() => undefined);
  }
  return { ok: result.ok, error: result.error, id: result.id };
}
