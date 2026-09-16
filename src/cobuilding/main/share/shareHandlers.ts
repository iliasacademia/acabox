/**
 * IPC surface for sharing: wires the app publisher (M5), the file publisher
 * (M6), the settings/registry store (M7) and the manifest `published` record
 * (M8) to the renderer.
 *
 * Design: `docs/design/sharing.md`. Contracts: `docs/design/sharing-tickets.md`
 * — this file implements ticket M9.
 *
 * WHY THE HANDLER BODIES ARE PLAIN EXPORTED FUNCTIONS, NOT INLINE IN
 * `registerShareHandlers`
 * ---------------------------------------------------------------------------
 * Every handler takes `deps` explicitly and is exported on its own, so a test
 * calls e.g. `publishApp(deps, dirName, opts)` directly — no `ipcMain`, no
 * Electron main process, no round-trip. `registerShareHandlers` itself is a
 * thin binder: it stores `deps` for `recomputeAndBroadcastApp` (used by M10,
 * which fires long after the registering call returns) and hooks each
 * function up to `ipcMain.handle`.
 *
 * WHY EVERY FAILURE IS RETURNED, NEVER RETHROWN
 * -----------------------------------------------
 * Electron prefixes a rejected `ipcMain.handle` across the IPC boundary with
 * "Error invoking remote method '...': ", which would put plumbing text in
 * front of a message meant for the user (see the `chat:send` note in
 * CLAUDE.md). Every handler below therefore wraps its risky work in
 * try/catch and returns `{ ok: false, error: err.message }` — the modules it
 * calls (`publishApp.ts`, `publishFile.ts`) are the ones allowed to throw.
 *
 * WHY PUBLISH CHECKS CONFIGURATION BUT UNPUBLISH DOES NOT
 * -----------------------------------------------------------
 * The ticket's rule is specifically about *publishing*: attempting to publish
 * with no site URL / API URL / token configured returns the friendly
 * not-configured message before any network attempt. Unpublish has no
 * equivalent short-circuit — if settings were cleared after a publish, the
 * attempt still runs through `ShareApiClient` and surfaces whatever error
 * that produces (still returned, never thrown), rather than leaving the user
 * unable to clear the local `published` marker at all.
 */
import { ipcMain } from 'electron';
import * as path from 'path';
import { assertWithinAllowedDirs } from '../fileHandlers';
import { readManifest } from '../manifestIO';
import type { PublishedInfo, ShareSettings, SnapshotSummary } from '../../shared/share';
import {
  computeAppStatus,
  publishApp as runPublishApp,
  unpublishApp as runUnpublishApp,
} from './publishApp';
import {
  computeFileStatus,
  publishFile as runPublishFile,
  unpublishFile as runUnpublishFile,
} from './publishFile';
import { clearPublished, manifestPathFor, readPublished, writePublished } from './publishedRecord';
import { ShareApiClient, ShareApiError, type ShareApi } from './shareApiClient';
import {
  getPublishedFile,
  getShareSettings,
  getShareSettingsForUi,
  isShareConfigured,
  removePublishedFile,
  saveShareSettings,
  setPublishedFile,
  type ShareSettingsForUi,
} from './shareStore';

const NOT_CONFIGURED_ERROR =
  'Sharing is not configured. Add the site URL, API URL and token in Settings → Sharing.';

export interface ShareHandlerDeps {
  getWorkspaceRoot: () => string | null;
  getAllowedPaths: () => string[];
  /** Sends `channel`/`payload` to every open window. */
  broadcast: (channel: string, payload: unknown) => void;
  /** Test seam. Default builds a `ShareApiClient` from the given settings. */
  createApi?: (settings: ShareSettings) => ShareApi;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildApi(deps: ShareHandlerDeps, settings: ShareSettings): ShareApi {
  if (deps.createApi) return deps.createApi(settings);
  return new ShareApiClient({ apiUrl: settings.apiUrl, token: settings.publishToken });
}

/** `path.relative`, posix-separated, so the registry key is stable across platforms. */
function workspaceRelativeKey(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join(path.posix.sep);
}

async function titleAndDescriptionFromManifest(
  workspaceRoot: string,
  dirName: string,
): Promise<{ title: string; description: string | null }> {
  const manifest = await readManifest(manifestPathFor(workspaceRoot, dirName));
  const title =
    manifest && typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : dirName;
  const description = manifest && typeof manifest.description === 'string' ? manifest.description : null;
  return { title, description };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<ShareSettingsForUi> {
  return getShareSettingsForUi();
}

export async function saveSettings(patch: {
  siteUrl: string;
  apiUrl: string;
  publishToken?: string;
  clearToken?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  return saveShareSettings(patch);
}

/**
 * One real GET at `/v1/health`, through the same `ShareApi` a publish would
 * use. A `ShareApiError` carries the real HTTP status (0 for a network
 * error); an unconfigured store never reaches the network at all.
 */
export async function test(deps: ShareHandlerDeps): Promise<{ ok: boolean; status: number; error: string | null }> {
  if (!isShareConfigured()) {
    return { ok: false, status: 0, error: 'Sharing is not configured' };
  }
  const settings = getShareSettings();
  const api = buildApi(deps, settings);
  try {
    await api.health();
    return { ok: true, status: 200, error: null };
  } catch (err) {
    if (err instanceof ShareApiError) return { ok: false, status: err.status, error: err.message };
    return { ok: false, status: 0, error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export async function planApp(
  deps: ShareHandlerDeps,
  dirName: string,
  includeInput: boolean,
): Promise<
  | { ok: true; summary: SnapshotSummary; hash: string; published: PublishedInfo | null; behind: boolean }
  | { ok: false; error: string }
> {
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return { ok: false, error: 'No active workspace' };
  try {
    const existing = await readPublished(workspaceRoot, dirName);
    const { hash, behind, summary } = await computeAppStatus({ workspaceRoot, dirName, includeInput, existing });
    return { ok: true, summary, hash, published: existing, behind };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function publishApp(
  deps: ShareHandlerDeps,
  dirName: string,
  opts: { includeInput: boolean },
): Promise<{ ok: true; published: PublishedInfo; unchanged: boolean } | { ok: false; error: string }> {
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return { ok: false, error: 'No active workspace' };
  if (!isShareConfigured()) return { ok: false, error: NOT_CONFIGURED_ERROR };

  const settings = getShareSettings();
  const api = buildApi(deps, settings);
  try {
    const existing = await readPublished(workspaceRoot, dirName);
    const { title, description } = await titleAndDescriptionFromManifest(workspaceRoot, dirName);
    const { published, unchanged } = await runPublishApp(api, {
      workspaceRoot,
      dirName,
      includeInput: opts.includeInput,
      siteUrl: settings.siteUrl,
      title,
      description,
      existing,
      onProgress: (p) => deps.broadcast('share:progress', { dirName, uploaded: p.uploaded, total: p.total }),
    });
    await writePublished(workspaceRoot, dirName, published);
    deps.broadcast('share:changed', { dirName });
    return { ok: true, published, unchanged };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function unpublishApp(
  deps: ShareHandlerDeps,
  dirName: string,
): Promise<{ ok: boolean; error?: string }> {
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return { ok: false, error: 'No active workspace' };
  try {
    const existing = await readPublished(workspaceRoot, dirName);
    if (!existing) return { ok: true }; // nothing published — no-op
    const settings = getShareSettings();
    const api = buildApi(deps, settings);
    await runUnpublishApp(api, existing);
    await clearPublished(workspaceRoot, dirName);
    deps.broadcast('share:changed', { dirName });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function statusApp(
  deps: ShareHandlerDeps,
  dirName: string,
): Promise<{ published: PublishedInfo | null; behind: boolean }> {
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return { published: null, behind: false };
  const published = await readPublished(workspaceRoot, dirName);
  if (!published) return { published: null, behind: false };
  try {
    const { behind } = await computeAppStatus({
      workspaceRoot,
      dirName,
      includeInput: published.includeInput ?? true,
      existing: published,
    });
    return { published, behind };
  } catch {
    // App directory may have moved/vanished since publish — report what we
    // know (published) rather than throwing out of a status read.
    return { published, behind: false };
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function publishFile(
  deps: ShareHandlerDeps,
  filePath: string,
): Promise<{ ok: true; published: PublishedInfo; unchanged: boolean } | { ok: false; error: string }> {
  try {
    assertWithinAllowedDirs(filePath, deps.getAllowedPaths());
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return { ok: false, error: 'No active workspace' };
  if (!isShareConfigured()) return { ok: false, error: NOT_CONFIGURED_ERROR };

  const relKey = workspaceRelativeKey(workspaceRoot, filePath);
  const existing = getPublishedFile(relKey);
  const settings = getShareSettings();
  const api = buildApi(deps, settings);
  try {
    const { published, unchanged } = await runPublishFile(api, {
      absPath: filePath,
      siteUrl: settings.siteUrl,
      existing,
      title: path.basename(filePath),
    });
    setPublishedFile(relKey, published);
    deps.broadcast('share:changed', { filePath });
    return { ok: true, published, unchanged };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function unpublishFile(
  deps: ShareHandlerDeps,
  filePath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    assertWithinAllowedDirs(filePath, deps.getAllowedPaths());
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return { ok: false, error: 'No active workspace' };

  const relKey = workspaceRelativeKey(workspaceRoot, filePath);
  const existing = getPublishedFile(relKey);
  if (!existing) return { ok: true }; // nothing published — no-op
  try {
    const settings = getShareSettings();
    const api = buildApi(deps, settings);
    await runUnpublishFile(api, existing);
    removePublishedFile(relKey);
    deps.broadcast('share:changed', { filePath });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function statusFile(
  deps: ShareHandlerDeps,
  filePath: string,
): Promise<{ published: PublishedInfo | null; behind: boolean }> {
  try {
    assertWithinAllowedDirs(filePath, deps.getAllowedPaths());
  } catch {
    return { published: null, behind: false };
  }
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return { published: null, behind: false };

  const relKey = workspaceRelativeKey(workspaceRoot, filePath);
  const existing = getPublishedFile(relKey);
  if (!existing) return { published: null, behind: false };
  try {
    const { behind } = await computeFileStatus({ absPath: filePath, existing });
    return { published: existing, behind };
  } catch {
    return { published: existing, behind: false };
  }
}

// ---------------------------------------------------------------------------
// Registration + M10's hook
// ---------------------------------------------------------------------------

/**
 * Captured so `recomputeAndBroadcastApp` (called from far outside this
 * module, by M10's build/run hooks) can reach the same `getWorkspaceRoot`/
 * `broadcast` the IPC handlers use, without every future caller having to
 * carry `deps` of its own.
 */
let registeredDeps: ShareHandlerDeps | null = null;

export function registerShareHandlers(deps: ShareHandlerDeps): void {
  registeredDeps = deps;

  ipcMain.handle('share:getSettings', () => getSettings());
  ipcMain.handle('share:saveSettings', (_event, patch) => saveSettings(patch));
  ipcMain.handle('share:test', () => test(deps));
  ipcMain.handle('share:planApp', (_event, dirName: string, includeInput: boolean) =>
    planApp(deps, dirName, includeInput));
  ipcMain.handle('share:publishApp', (_event, dirName: string, opts: { includeInput: boolean }) =>
    publishApp(deps, dirName, opts));
  ipcMain.handle('share:unpublishApp', (_event, dirName: string) => unpublishApp(deps, dirName));
  ipcMain.handle('share:statusApp', (_event, dirName: string) => statusApp(deps, dirName));
  ipcMain.handle('share:publishFile', (_event, filePath: string) => publishFile(deps, filePath));
  ipcMain.handle('share:unpublishFile', (_event, filePath: string) => unpublishFile(deps, filePath));
  ipcMain.handle('share:statusFile', (_event, filePath: string) => statusFile(deps, filePath));
}

/**
 * The two moments a snapshot changes without the user clicking Publish: a
 * successful build and a finished run (M10). Reads the manifest's
 * `published` record, recomputes `behind` against the live workspace, and
 * broadcasts `share:changed` so any open Settings/Tools/viewer surface
 * re-reads status — a no-op when the app was never published.
 */
export async function recomputeAndBroadcastApp(dirName: string): Promise<void> {
  const deps = registeredDeps;
  if (!deps) return;
  const workspaceRoot = deps.getWorkspaceRoot();
  if (!workspaceRoot) return;
  const published = await readPublished(workspaceRoot, dirName);
  if (!published) return;
  try {
    await computeAppStatus({
      workspaceRoot,
      dirName,
      includeInput: published.includeInput ?? true,
      existing: published,
    });
  } catch {
    // App directory may have moved/vanished — still tell listeners to refresh.
  }
  deps.broadcast('share:changed', { dirName });
}
