/**
 * Workspace provisioning — everything Acabox puts into the agent's cwd before
 * a turn can run.
 *
 * This module used to force-copy 21 hardcoded skill directories over whatever
 * was in `<workspace>/.claude/skills` on every boot, and delete anything not on
 * the list. Skills now live in a per-user store (`skillStore.ts`) and reach the
 * workspace as symlinks (`skillRender.ts`), so a user (or agent) edit survives.
 * What is left here is the rest of the provisioning: the workspace `CLAUDE.md`,
 * the Claude Code `settings.json` that wires the PreToolUse hooks, the hook
 * scripts themselves, and the shared mini-app assets under `.applications/`.
 *
 * Those four were force-overwritten by exactly the same mechanism and carry
 * exactly the same silent-edit-destruction bug — nobody has noticed only
 * because nobody edits them yet. They now go through `reconcileProvisionedFile`
 * below, which knows what it last wrote and can therefore tell an upstream
 * change from a local one.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

import {
  getCobuildingSourceDir,
  getSkillsStoreDir,
  pruneSkillsTrash,
  reconcile,
  readSkillsState,
  skillStorePath,
} from './skillStore';
import type { ReconcileResult } from './skillStore';
import { renderSkills } from './skillRender';
import type { RenderResult } from './skillRender';
import { hashFileIf } from './skillHash';
import { updateManifest } from './manifestIO';

/**
 * The skill that owns the shared mini-app assets. `.applications/_bridge`,
 * `_vendor`, `_templates`, `_reusable` and the `install` wrapper are all copies
 * of files inside it, which is why they have to come from the STORE and not
 * from the shipped tree — see `syncMiniAppAssets`.
 */
const MINI_APP_SKILL = 'manage-mini-application';

function cpSyncWithRetry(src: string, dest: string, maxRetries = 5): void {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.cpSync(src, dest, { recursive: true });
      return;
    } catch (err: any) {
      if (err.code === 'EINTR' && attempt < maxRetries) {
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Provisioned-file reconciler
// ---------------------------------------------------------------------------

/**
 * What we last wrote to each provisioned path, so a later boot can tell "the
 * shipped file changed" from "the user changed it". Lives in userData next to
 * `skills-state.json`, for the same reason: the workspace is the agent's own
 * cwd, so a record kept there is a record the agent can rewrite.
 */
const PROVISIONING_STATE_FILE = 'workspace-provisioning.json';

interface ProvisioningState {
  version: number;
  /** workspace-relative POSIX path -> the hash of the bytes we last wrote. */
  files: Record<string, string>;
}

function getProvisioningStateFile(): string {
  return path.join(app.getPath('userData'), PROVISIONING_STATE_FILE);
}

/**
 * How a local divergence is resolved.
 *
 * - `keep-local` — the user's bytes win and we only ever fast-forward a file
 *   they have not touched. Right for guidance, which is advice.
 * - `restore` — the shipped bytes are put back, with the divergent copy moved
 *   into `<userData>/workspace-file-backups/<stamp>/` first.
 *
 * `restore` is deliberately NOT the same as the old blind overwrite: the bytes
 * are preserved and the backup path is logged, so an edit is recoverable
 * instead of gone. It applies only to `settings.json` and the hook scripts,
 * and it applies because those are the PreToolUse gate — the agent has
 * unrestricted `Write` and `Bash` inside the workspace, so "keep the local
 * edit" would hand it a permanent way to disable `block-secret-reads.sh`.
 * Preserving an edit is worth more than a security control everywhere except
 * on the security control itself.
 */
type ProvisionPolicy = 'keep-local' | 'restore';

interface ProvisionedFile {
  /** Path under `src/cobuilding/` (or `Resources/` when packaged). */
  src: string;
  /** Path under the workspace root. */
  dest: string;
  policy: ProvisionPolicy;
  /** chmod applied after any write. Hook scripts have to stay executable. */
  mode?: number;
}

export interface ProvisionedFileOutcome {
  dest: string;
  /** `seeded` = there was nothing there; `fast-forward` = we had written it. */
  action: 'unchanged' | 'seeded' | 'fast-forward' | 'kept-local' | 'restored';
  /** Where the divergent copy went, for `restored`. */
  backupPath?: string;
}

function backupDivergentCopy(destAbs: string, relDest: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(app.getPath('userData'), 'workspace-file-backups', stamp);
  const target = path.join(dir, relDest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(destAbs, target);
  return target;
}

/**
 * Bring one provisioned file in line with what ships, without destroying an
 * edit we did not make.
 *
 * The comparison is three-way, the same shape as the skill store's per-file
 * table: the shipped hash, the destination hash, and the hash of what we last
 * wrote. Without that third value there is no way to distinguish "the user
 * edited it" from "we shipped a new version", which is precisely why the old
 * unconditional `cpSync` could not do better than clobbering.
 */
function reconcileProvisionedFile(
  workspaceDir: string,
  file: ProvisionedFile,
  state: ProvisioningState,
): ProvisionedFileOutcome {
  const srcAbs = path.join(getCobuildingSourceDir(), file.src);
  const destAbs = path.join(workspaceDir, file.dest);

  const shipped = hashFileIf(srcAbs);
  if (!shipped) {
    // Nothing to provision from. Not an error: `hooks/` is optional in a
    // partially-built tree, and a missing source must never delete a live file.
    return { dest: file.dest, action: 'unchanged' };
  }

  const current = hashFileIf(destAbs);
  const baseline = state.files[file.dest];

  const write = (action: ProvisionedFileOutcome['action'], backupPath?: string): ProvisionedFileOutcome => {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.cpSync(srcAbs, destAbs, { force: true });
    if (file.mode !== undefined) fs.chmodSync(destAbs, file.mode);
    state.files[file.dest] = shipped;
    return { dest: file.dest, action, backupPath };
  };

  if (current === undefined) return write('seeded');

  // The exec bit is not part of the hash, so a hook that lost +x reads as
  // identical. Re-apply unconditionally — it costs a syscall and a
  // non-executable hook fails the turn rather than the check.
  if (file.mode !== undefined) {
    try { fs.chmodSync(destAbs, file.mode); } catch { /* best effort */ }
  }

  if (current === shipped) {
    // Already the shipped bytes however they got there. Adopt as the baseline
    // so a later release fast-forwards instead of reading as a local edit.
    state.files[file.dest] = shipped;
    return { dest: file.dest, action: 'unchanged' };
  }

  if (baseline === undefined || current === baseline) {
    // Either we have no record (first boot on this build — treat the shipped
    // version as authoritative for a file we have always overwritten anyway)
    // or the destination still holds exactly what we last wrote. Both are a
    // clean fast-forward.
    return write(baseline === undefined ? 'seeded' : 'fast-forward');
  }

  // Local divergence.
  if (file.policy === 'keep-local') {
    log.info(
      `[Provision] ${file.dest} differs from the shipped version and was edited locally — keeping the local copy`,
    );
    return { dest: file.dest, action: 'kept-local' };
  }

  let backupPath: string | undefined;
  try {
    backupPath = backupDivergentCopy(destAbs, file.dest);
  } catch (err) {
    log.warn(`[Provision] Could not back up ${file.dest}: ${(err as Error).message}`);
  }
  log.warn(
    `[Provision] ${file.dest} was modified locally; restoring the shipped version`
    + `${backupPath ? ` (previous copy kept at ${backupPath})` : ' (backup failed — previous copy is gone)'}`,
  );
  return write('restored', backupPath);
}

/** Every file the workspace is provisioned with, other than the skills. */
function provisionedFiles(): ProvisionedFile[] {
  const files: ProvisionedFile[] = [
    // Workspace guidance. Advice, not enforcement — a local edit stands.
    { src: 'CLAUDE.md', dest: path.join('.claude', 'CLAUDE.md'), policy: 'keep-local' },
    // Wires the PreToolUse hooks. Security-bearing, so `restore`.
    { src: 'settings.json', dest: path.join('.claude', 'settings.json'), policy: 'restore' },
  ];

  const hooksSrc = path.join(getCobuildingSourceDir(), 'hooks');
  let hookNames: string[] = [];
  try {
    hookNames = fs.readdirSync(hooksSrc).filter((n) => n.endsWith('.sh')).sort();
  } catch {
    // No hooks in this tree. Nothing to provision; the settings.json we ship
    // names them, so this only happens in a partially-built checkout.
  }
  for (const name of hookNames) {
    files.push({
      src: path.join('hooks', name),
      dest: path.join('.claude', 'hooks', name),
      policy: 'restore',
      mode: 0o755,
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Mini-app assets
// ---------------------------------------------------------------------------

/**
 * Copy the shared mini-app assets into `.applications/`.
 *
 * The source is the STORE copy of `manage-mini-application`, not the shipped
 * one. That is load-bearing rather than tidy: the skills UI shows MODIFIED and
 * a Revert button against the store, so if this read from pristine, a user who
 * edited `assets/reusable/useAppState.ts` would see the UI assert their edit
 * took effect while the next boot silently overwrote the copy every mini-app
 * actually builds against. Read from the store and the two agree by
 * construction.
 *
 * Requires the store to be seeded, so `reconcile()` must have run first.
 */
export function syncMiniAppAssets(workspaceDir: string): void {
  const assetsDir = path.join(skillStorePath(MINI_APP_SKILL), 'assets');
  const appsDir = path.join(workspaceDir, '.applications');

  if (!fs.existsSync(assetsDir)) {
    throw new Error(
      `Mini-app assets are missing from the skill store at ${assetsDir}. `
      + 'reconcile() must run before syncMiniAppAssets().',
    );
  }

  const bridgeSrc = path.join(assetsDir, 'bridge');
  const bridgeDest = path.join(appsDir, '_bridge');
  cpSyncWithRetry(bridgeSrc, bridgeDest);

  const vendorSrc = path.join(assetsDir, 'vendor');
  if (fs.existsSync(vendorSrc)) {
    const vendorDest = path.join(appsDir, '_vendor');
    cpSyncWithRetry(vendorSrc, vendorDest);
  }

  const templatesSrc = path.join(assetsDir, 'templates');
  if (fs.existsSync(templatesSrc)) {
    const templatesDest = path.join(appsDir, '_templates');
    cpSyncWithRetry(templatesSrc, templatesDest);
  }

  const reusableSrc = path.join(assetsDir, 'reusable');
  if (fs.existsSync(reusableSrc)) {
    const reusableDest = path.join(appsDir, '_reusable');
    cpSyncWithRetry(reusableSrc, reusableDest);
  }

  // Install wrapper: the only sanctioned way for the agent to install software.
  // We always overwrite from source and verify the copy landed + is executable.
  const installSrc = path.join(assetsDir, 'install');
  const installDest = path.join(appsDir, 'install');
  fs.mkdirSync(appsDir, { recursive: true });
  fs.cpSync(installSrc, installDest, { force: true });
  fs.chmodSync(installDest, 0o755);
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  reconcile?: ReconcileResult;
  render?: RenderResult;
  files: ProvisionedFileOutcome[];
  /** Steps that threw. Provisioning continues past each one. */
  errors: Array<{ step: string; message: string }>;
}

/**
 * Provisioning is serialised. Boot calls it, `WorkspaceController.create` calls
 * it, and `agentInfrastructure.start()` awaits it before the agent server comes
 * up — three entry points that can overlap. Two concurrent runs would have the
 * store reconciler and the symlink render interleaving on the same directories.
 * Same idiom as `manifestIO`'s per-path queue, one queue because there is one
 * workspace.
 */
let provisionQueue: Promise<unknown> = Promise.resolve();

export function provisionWorkspace(workspaceDir: string): Promise<ProvisionResult> {
  const next = provisionQueue
    .catch(() => { /* a failed predecessor doesn't block the queue */ })
    .then(() => runProvision(workspaceDir));
  provisionQueue = next.catch(() => { /* keep the queue alive */ });
  return next;
}

async function runProvision(workspaceDir: string): Promise<ProvisionResult> {
  const started = Date.now();
  const result: ProvisionResult = { files: [], errors: [] };

  // Each step is independent and every one of them is better done partially
  // than not at all: a failure to write CLAUDE.md must not cost the user their
  // hooks, and neither must cost them the skill render. Before this, one throw
  // out of the hardcoded SKILLS array (an ENOENT on a renamed directory) took
  // out `provisionWorkspace` two lines above `createMainWindow()` and produced
  // an app with no window at all.
  const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      result.errors.push({ step: name, message });
      log.error(`[Provision] ${name} failed: ${message}`);
    }
  };

  await step('pruneSkillsTrash', () => {
    const removed = pruneSkillsTrash();
    if (removed) log.info(`[Provision] Pruned ${removed} expired skill trash entr(ies)`);
  });

  // Must precede syncMiniAppAssets: the store is where the mini-app assets are
  // read from, and on a fresh install it does not exist until this runs.
  await step('reconcileSkills', async () => {
    const rec = await reconcile({ workspaceDir });
    result.reconcile = rec;
    if (rec.pristineUnavailable) {
      // Not a warning. Every skill Acabox ships is unreachable, so the store
      // keeps whatever it already had and a fresh install gets nothing at all
      // — including the mini-app assets, which is what the `_bridge` assertion
      // below is about to report as its own separate failure.
      result.errors.push({
        step: 'reconcileSkills',
        message: 'The shipped skill tree could not be read; the store was left untouched.',
      });
      log.error(
        '[Provision] The shipped skill tree is missing or empty. Reconcile made no changes '
        + 'on purpose — see the [Skills] line above for the path it tried.',
      );
    }
    log.info(
      `[Provision] Skill store reconciled in ${Date.now() - started}ms: `
      + `upgraded=${rec.upgraded} seeded=${rec.seeded.length} adopted=${rec.adopted.length} `
      + `recovered=${rec.recovered.length} fastForwarded=${rec.fastForwarded.length} `
      + `conflicts=${rec.conflicts.length} removedUpstream=${rec.removedUpstream.length} `
      + `keptAsCustom=${rec.keptAsCustom.length}`,
    );
    if (rec.seeded.length) log.info(`[Provision] Seeded skills: ${rec.seeded.join(', ')}`);
    if (rec.adopted.length) {
      log.info(`[Provision] Adopted into the store: ${rec.adopted.map((a) => a.fromName).join(', ')}`);
    }
    for (const c of rec.conflicts) {
      log.warn(`[Provision] Skill conflict ${c.id}/${c.relPath}: ${c.kind} — local copy kept`);
    }
    for (const e of rec.errors) log.error(`[Provision] Skill ${e.id}: ${e.message}`);
  });

  await step('renderSkills', async () => {
    const state = await readSkillsState();
    const render = await renderSkills(workspaceDir, state);
    result.render = render;
    log.info(
      `[Provision] Rendered ${render.linked.length + render.unchanged.length} skill(s) into `
      + `${render.renderDir} (linked=${render.linked.length} unchanged=${render.unchanged.length} `
      + `unlinked=${render.unlinked.length} adoptable=${render.adoptable.length})`,
    );
    for (const e of render.errors) log.error(`[Provision] Render ${e.id}: ${e.message}`);
  });

  await step('provisionedFiles', async () => {
    const stateFile = getProvisioningStateFile();
    const outcomes: ProvisionedFileOutcome[] = [];
    // One read-modify-write of the state file around the whole set, through
    // manifestIO so the bytes and the record of them land atomically.
    await updateManifest(stateFile, (raw) => {
      const state: ProvisioningState = {
        version: 1,
        files: (raw.files && typeof raw.files === 'object' ? raw.files : {}) as Record<string, string>,
      };
      for (const file of provisionedFiles()) {
        try {
          outcomes.push(reconcileProvisionedFile(workspaceDir, file, state));
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          result.errors.push({ step: `provision:${file.dest}`, message });
          log.error(`[Provision] ${file.dest} failed: ${message}`);
        }
      }
      return state as unknown as Record<string, unknown>;
    });
    result.files = outcomes;
    const changed = outcomes.filter((o) => o.action !== 'unchanged');
    if (changed.length) {
      log.info(
        `[Provision] Workspace files: ${changed.map((o) => `${o.dest}=${o.action}`).join(', ')}`,
      );
    }
  });

  await step('syncMiniAppAssets', () => syncMiniAppAssets(workspaceDir));

  // Boot assertion. `.applications/_bridge` is what every mini-app bundle
  // imports; without it esbuild fails to resolve `@bridge` and EVERY build
  // breaks, at build time, with an error nobody would trace back to
  // provisioning. It now comes out of the skill store rather than the shipped
  // tree, so a mis-ordering here (render before reconcile, a store the
  // reconciler failed to seed) would produce exactly that on a fresh install.
  // Fail loudly at boot instead — the smoke test exercises this path.
  const bridgeDir = path.join(workspaceDir, '.applications', '_bridge');
  if (!fs.existsSync(bridgeDir)) {
    throw new Error(
      `Provisioning did not produce ${bridgeDir}. Every mini-app build resolves its `
      + `bridge from there, so this is fatal. The assets come from the skill store at `
      + `${path.join(getSkillsStoreDir(), MINI_APP_SKILL, 'assets')} — check the `
      + `reconcileSkills / syncMiniAppAssets errors above.`,
    );
  }

  log.info(`[Provision] Workspace provisioned in ${Date.now() - started}ms (${result.errors.length} error(s))`);
  return result;
}
