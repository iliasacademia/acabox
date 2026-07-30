/**
 * The render: `<workspace>/.claude/skills/<id>` -> `<store>/<id>`, absolute
 * symlinks, zero bytes.
 *
 * WHY A SYMLINK AND NOT A COPY
 * ----------------------------
 * `open()` resolves the link at write time, so an agent `Edit`, a `Bash`
 * heredoc, vim and the Acabox editor all deposit bytes in the same inode.
 * There is no second copy to reconcile and no sync direction to get backwards.
 * The CLI accepts it: the loader guard in the bundled binary is
 * `if(!D.isDirectory()&&!D.isSymbolicLink())return` — the *inclusive* form —
 * and it takes `D.name`, the link's name, so the render controls skill
 * identity. A dangling link degrades safely: `readFile(link/SKILL.md)` returns
 * ENOENT and the loader returns, so a broken store entry is an absent skill
 * rather than a crash.
 *
 * WHY IT MUST LIVE UNDER `.claude/`
 * ---------------------------------
 * `containerService.syncWorkspaceSymlinks` reaps workspace-ROOT symlinks that
 * resolve outside the workspace, and skips dot-prefixed names
 * (`containerService.ts:220-227`, the skip at `:221`). A root-level `skills`
 * link matches every reap condition and would be deleted on **every**
 * `containerService.start()`. Keeping the render under the dot-directory also
 * keeps 255 skill files out of `FilesTab`'s count, which hides only `.`- and
 * `~$`-prefixed entries — the "Home says no files but I have files" bug.
 *
 * WHY DISABLED SKILLS ARE STILL LINKED
 * ------------------------------------
 * Disable is a roster-budget decision, enforced by `buildSkillRuntimeConfig`
 * omitting the id from `Options.skills`. If the render also skipped disabled
 * skills, a disable would become irreversible mid-session (the bytes would be
 * gone from cwd while the allowlist is fixed at session create) and a
 * re-enabled skill's own relative paths would break. The two sides are one
 * decision; do not change either alone.
 */
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

import { SKILLS_RENDER_SUBDIR } from '../shared/skills';
import type { SkillsState } from '../shared/skills';
import { readSkillsState, getSkillsStoreDir, skillStorePath } from './skillStore';

export interface RenderResult {
  /** Absolute path of `<workspace>/.claude/skills`. */
  renderDir: string;
  /** Links created or repointed. */
  linked: string[];
  /** Links that were already correct — the whole-boot case. */
  unchanged: string[];
  /** Stale links into our store, unlinked. */
  unlinked: string[];
  /**
   * Real directories we found and deliberately did NOT touch. Reconcile adopts
   * them; the render's job is to be incapable of destroying one.
   */
  adoptable: string[];
  errors: Array<{ id: string; message: string }>;
}

/** Where the render lives for a given workspace. */
export function getRenderDir(workspaceDir: string): string {
  return path.join(workspaceDir, SKILLS_RENDER_SUBDIR);
}

/**
 * Rebuild the render. Idempotent: on an ordinary boot every link is already
 * correct and nothing is written.
 *
 * `state` may be supplied by a caller that has just reconciled, so the state
 * file is not read twice.
 */
export async function renderSkills(
  workspaceDir: string,
  state?: SkillsState,
): Promise<RenderResult> {
  const resolved = state ?? (await readSkillsState());
  const renderDir = getRenderDir(workspaceDir);
  const storeDir = getSkillsStoreDir();
  const result: RenderResult = {
    renderDir,
    linked: [],
    unchanged: [],
    unlinked: [],
    adoptable: [],
    errors: [],
  };

  fs.mkdirSync(renderDir, { recursive: true });

  // Every non-removed skill, enabled or not. See the header.
  const live = Object.entries(resolved.skills)
    .filter(([, entry]) => !entry.removed)
    .map(([id]) => id)
    .sort();

  for (const id of live) {
    const target = skillStorePath(id);
    const link = path.join(renderDir, id);
    try {
      if (!fs.existsSync(target)) {
        // The index says it exists and the disk disagrees. Linking anyway would
        // produce a dangling link the CLI silently skips; reconcile re-seeds a
        // built-in and drops a custom entry, so leaving it unlinked is right.
        result.errors.push({ id, message: 'no directory in the store' });
        continue;
      }

      let existing: fs.Stats | null = null;
      try {
        existing = fs.lstatSync(link);
      } catch (err: any) {
        if (!err || err.code !== 'ENOENT') throw err;
      }

      if (existing?.isSymbolicLink()) {
        if (fs.readlinkSync(link) === target) {
          result.unchanged.push(id);
          continue;
        }
        // Repoint. `unlink`, never `rmSync(link, {recursive:true})` with a
        // trailing separator — measured: with the separator the delete
        // resolves THROUGH the link and empties the store copy.
        fs.unlinkSync(link);
      } else if (existing) {
        // A real directory or file. Never ours to delete: reconcile adopts it
        // into the store, which is the deliberate inversion of the old
        // recursive prune.
        result.adoptable.push(id);
        continue;
      }

      // Absolute, and typed 'dir' — the type argument is ignored on POSIX but
      // is what a future Windows port would need, and costs nothing here.
      fs.symlinkSync(target, link, 'dir');
      result.linked.push(id);
    } catch (err) {
      result.errors.push({ id, message: (err as Error).message });
      log.warn(`[Skills] Could not link ${id}: ${(err as Error).message}`);
    }
  }

  // Sweep links into our store that no live skill claims — how a removed or
  // deleted skill actually leaves the agent's reach. Links pointing anywhere
  // else are somebody's deliberate work and are left alone.
  const liveSet = new Set(live);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(renderDir, { withFileTypes: true });
  } catch (err) {
    result.errors.push({ id: '', message: (err as Error).message });
    return result;
  }

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    if (liveSet.has(entry.name)) continue;
    const link = path.join(renderDir, entry.name);
    let target = '';
    try {
      target = fs.readlinkSync(link);
    } catch {
      continue;
    }
    const resolvedTarget = path.isAbsolute(target)
      ? target
      : path.resolve(renderDir, target);
    if (
      resolvedTarget !== storeDir &&
      !resolvedTarget.startsWith(storeDir + path.sep)
    ) {
      continue;
    }
    try {
      fs.unlinkSync(link);
      result.unlinked.push(entry.name);
      log.info(`[Skills] Unlinked stale render entry ${entry.name}`);
    } catch (err) {
      result.errors.push({ id: entry.name, message: (err as Error).message });
    }
  }

  log.info(
    `[Skills] Rendered ${live.length} skill(s) into ${renderDir}: ` +
      `${result.linked.length} linked, ${result.unchanged.length} unchanged, ` +
      `${result.unlinked.length} unlinked, ${result.adoptable.length} left for adoption, ` +
      `${result.errors.length} error(s)`,
  );
  return result;
}
