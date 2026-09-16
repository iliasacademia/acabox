/**
 * Increment 6 of `docs/design/mcp-hosting.md` — install a hosted MCP server
 * from npm (6a) or a GitHub repo (6b).
 *
 * Both paths converge deliberately fast. Everything after "the bytes are on
 * disk" — dependency install, entry resolution, the probe, the atomic swap,
 * registering DISABLED — is one code path, so npm and GitHub cannot drift
 * into disclosing different things or arriving in different states.
 *
 * ORDER IS THE SAFETY PROPERTY, and it is this:
 *
 *   fetch → strip symlinks → scan/cap → install deps → probe → swap → register
 *
 *   - **Strip symlinks before anything reads the tree.** bsdtar refuses `..`
 *     but DOES materialise absolute symlinks, and this app has been bitten by
 *     that once already (see `skillImporter.stripSymlinks`). Nothing may stat,
 *     hash or execute a tree that still contains links.
 *   - **Probe in the STAGING directory**, never after the swap. A server that
 *     cannot answer `initialize` must never become the thing at the real path,
 *     because that path is what an existing record already points at.
 *   - **Register disabled**, and not by this module's choice:
 *     `registerHostedServer` writes `enabled: false` as a literal and takes no
 *     field a caller could use to override it. The install puts code on disk;
 *     the USER decides whether it ever runs. That is the same property
 *     Increment 5 preserves for agent-authored servers, and the reason this is
 *     not an MCP tool the agent can call.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * No source builds, ever — see `npmProject.ts`. No `npx`. No update path yet:
 * an install is pinned (exact version / 40-char SHA) and re-installing is how
 * you move it, which keeps "what is running" answerable from the record alone.
 */

import log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { hashSkillFiles } from '../skillHash';
import {
  parseGithubUrl,
  resolveRef,
  fetchSubtreeRaw,
  stripSymlinks,
  scanTree,
} from '../knowledge/skillImporter';
import { installNpmPackage, installProjectDeps, resolveEntryFile, resolveExactVersion, type LogSink } from './npmProject';
import { hostedServerDir, registerHostedServer, getHostedServer, isEncryptionAvailable } from './store';
import { probeServer } from './supervisor';
import { ensureNpmAvailable } from '../nodeSetup';
import { validateHostedServer } from '../../shared/hostedMcp';
import { diagnoseInstall } from './diagnose';
import type { HostedInstallSource, HostedMcpEntry, HostedToolDescriptor } from '../../shared/hostedMcp';

/**
 * Caps for an installed SERVER tree, deliberately separate from
 * `skillImporter`'s skill caps. A server legitimately carries `node_modules`
 * once its deps land, so the cap is checked on the SOURCE tree only, before
 * any install — the point is to refuse "you pasted a whole monorepo", not to
 * police what npm resolves.
 */
export const MAX_SERVER_SOURCE_FILES = 4000;
export const MAX_SERVER_SOURCE_BYTES = 64 * 1024 * 1024;

/** `ELECTRON_RUN_AS_NODE` is absent from `hostedEnv.ts`'s allowlist on purpose
 *  (nothing should inherit it from Acabox) and is layered on through the
 *  record's own env, which `buildHostedEnv` always lets through. Identical to
 *  `authored.ts`'s `AUTHORED_RUN_ENV`. */
const INSTALLED_RUN_ENV: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };

export type InstallSourceRequest =
  | { kind: 'npm'; pkg: string; version?: string }
  | { kind: 'github'; url: string; subpath?: string };

export interface InstallRequest {
  id: string;
  label?: string;
  source: InstallSourceRequest;
  env?: Record<string, string>;
  /** Every line of installer output. There is no percentage to report —
   *  codeload sends no `content-length` — so the UI shows a live log instead
   *  of a fabricated bar, the rule `ImportSkillPanel` already follows. */
  onLog?: LogSink;
}

export type InstallResult =
  | { ok: true; id: string; toolCount: number; toolNames: string[]; install: HostedInstallSource }
  | { ok: false; error: string };

const NO_ENCRYPTION_MESSAGE =
  'Acabox cannot reach this machine’s keychain, so it will not store a server that runs code on your computer.';

export async function installHostedServer(req: InstallRequest): Promise<InstallResult> {
  const onLog: LogSink = req.onLog ?? (() => { /* discarded */ });

  if (!isEncryptionAvailable()) return { ok: false, error: NO_ENCRYPTION_MESSAGE };

  // Validate the id against the SAME rules and the SAME namespace a manually
  // added server goes through — an installed server is not a privileged
  // second class of record, and the id collides with connectors too.
  const existing = await getHostedServer(req.id);
  if (existing) return { ok: false, error: `A server named "${req.id}" already exists. Remove it first, or pick another name.` };

  const parentDir = path.dirname(hostedServerDir(req.id));
  fs.mkdirSync(parentDir, { recursive: true });
  const stagingDir = path.join(parentDir, `${req.id}.installing-${randomUUID()}`);
  const backupDir = path.join(parentDir, `${req.id}.previous-${randomUUID()}`);

  try {
    const fetched = req.source.kind === 'npm'
      ? await fetchFromNpm(stagingDir, req.source, onLog)
      : await fetchFromGithub(stagingDir, req.source, onLog);

    const entry: HostedMcpEntry = {
      command: process.execPath,
      args: [fetched.entryFile],
      cwd: stagingDir,
    };

    onLog('Starting the server once to read its tool list…');
    const probe = await probeServer({
      command: entry.command,
      args: entry.args,
      cwd: stagingDir,
      env: { ...INSTALLED_RUN_ENV, ...(req.env ?? {}) },
    });
    if (!probe.ok) {
      cleanupDirBestEffort(stagingDir);
      return { ok: false, error: probe.error ?? 'The server did not answer initialize/tools-list.' };
    }
    onLog(`It offers ${probe.toolNames.length} tool${probe.toolNames.length === 1 ? '' : 's'}.`);

    const fileHashes = hashSkillFiles(stagingDir);
    const targetDir = hostedServerDir(req.id);

    try {
      if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
      fs.renameSync(stagingDir, targetDir);
    } catch (err) {
      if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
        try { fs.renameSync(backupDir, targetDir); } catch { /* best-effort roll-back */ }
      }
      cleanupDirBestEffort(stagingDir);
      return { ok: false, error: `Could not move the installed files into place: ${(err as Error).message}` };
    }
    cleanupDirBestEffort(backupDir);

    // The probe ran against the staging path; the record must describe where
    // the code now LIVES. Rewritten rather than recomputed from `install`, so
    // there is exactly one place the runnable path is decided.
    const finalEntry: HostedMcpEntry = {
      command: process.execPath,
      args: [path.join(targetDir, path.relative(stagingDir, fetched.entryFile))],
      cwd: targetDir,
    };

    const toolsAtApproval: HostedToolDescriptor[] = probe.toolNames.map((name) => ({ name }));
    const reg = await registerHostedServer({
      id: req.id,
      label: req.label?.trim() || fetched.defaultLabel,
      autostart: true,
      install: fetched.install,
      // R3: we installed it and we launch it, so the ABI is ours to promise.
      runtime: 'acabox-node',
      entry: finalEntry,
      env: { ...INSTALLED_RUN_ENV, ...(req.env ?? {}) },
      fileHashes,
      toolsAtApproval,
    });
    if (!reg.ok) {
      cleanupDirBestEffort(targetDir);
      return { ok: false, error: reg.error };
    }

    onLog('Installed. It stays off until you turn it on.');
    log.info(`[McpHost] Installed "${req.id}" from ${fetched.install.kind} — awaiting your review on the Servers page.`);
    return { ok: true, id: req.id, toolCount: toolsAtApproval.length, toolNames: probe.toolNames, install: fetched.install };
  } catch (err) {
    cleanupDirBestEffort(stagingDir);
    // The log pane keeps npm's/GitHub's own words; the returned error is the
    // one-sentence version. Both, not either — the raw tail is what makes
    // "Ask Claude to fix this" actionable, the sentence is what the user reads.
    const raw = (err as Error)?.message || String(err);
    const message = diagnoseInstall(err);
    if (raw && raw !== message) onLog(raw);
    onLog(`Failed: ${message}`);
    return { ok: false, error: message };
  }
}

interface Fetched {
  entryFile: string;
  install: HostedInstallSource;
  defaultLabel: string;
}

async function fetchFromNpm(
  stagingDir: string,
  source: Extract<InstallSourceRequest, { kind: 'npm' }>,
  onLog: LogSink,
): Promise<Fetched> {
  const pkg = source.pkg.trim();
  if (!pkg) throw new Error('No package name given.');
  // Resolve BEFORE installing so the record pins what actually landed rather
  // than what was asked for — `latest` and `^1.2.0` are not pins.
  const npmBin = await ensureNpmAvailable();
  const version = await resolveExactVersion(npmBin, pkg, source.version ?? 'latest', onLog);
  const result = await installNpmPackage(stagingDir, pkg, version, onLog);
  return {
    entryFile: result.entryFile,
    install: { kind: 'npm', pkg, version: result.version, integrity: result.integrity },
    defaultLabel: (pkg.split('/').pop() as string),
  };
}

async function fetchFromGithub(
  stagingDir: string,
  source: Extract<InstallSourceRequest, { kind: 'github' }>,
  onLog: LogSink,
): Promise<Fetched> {
  const target = parseGithubUrl(source.url);
  if (!target) throw new Error(`"${source.url}" is not a GitHub repository URL.`);

  onLog(`Resolving ${target.owner}/${target.repo}${target.ref ? `@${target.ref}` : ''}…`);
  // A pin recorded as a branch name is not a pin — resolve to the 40-char SHA
  // before a single byte is fetched, and record THAT.
  const sha = await resolveRef(target.owner, target.repo, target.ref);
  const subpath = source.subpath?.trim() || target.subpath || '';
  onLog(`Pinned to ${sha}`);

  await fetchSubtreeRaw({ ...target, sha, subpath }, stagingDir);

  // Order is load-bearing: links go before anything else reads the tree.
  const stripped = await stripSymlinks(stagingDir);
  if (stripped.length > 0) {
    onLog(`Removed ${stripped.length} symlink${stripped.length === 1 ? '' : 's'} from the download.`);
  }

  const scan = await scanTree(stagingDir);
  if (scan.fileCount > MAX_SERVER_SOURCE_FILES) {
    throw new Error(`That path holds ${scan.fileCount} files, past the ${MAX_SERVER_SOURCE_FILES}-file limit. Point at one server's directory rather than a whole repository.`);
  }
  if (scan.totalBytes > MAX_SERVER_SOURCE_BYTES) {
    throw new Error(`That path is ${Math.round(scan.totalBytes / 1024 / 1024)} MB, past the ${Math.round(MAX_SERVER_SOURCE_BYTES / 1024 / 1024)} MB limit.`);
  }
  onLog(`Downloaded ${scan.fileCount} files (${Math.round(scan.totalBytes / 1024)} KB).`);
  if (scan.execCount > 0) {
    // Disclosed, never hidden — the same stance `skillImporter` takes.
    onLog(`${scan.execCount} file${scan.execCount === 1 ? ' is' : 's are'} executable.`);
  }

  await installProjectDeps(stagingDir, onLog);

  const name = subpath ? (subpath.split('/').pop() as string) : target.repo;
  const entryFile = resolveEntryFile(stagingDir, name);
  return {
    entryFile,
    install: { kind: 'github', repo: `${target.owner}/${target.repo}`, ref: sha, subpath: subpath || undefined },
    defaultLabel: name,
  };
}

function cleanupDirBestEffort(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Exported for the id field's live validation in the add form. */
export function validateInstallId(id: string, existingIds: readonly string[]): { ok: boolean; error?: string } {
  const check = validateHostedServer(
    { id, entry: { command: process.execPath, args: ['x'] } },
    [...existingIds],
  );
  return { ok: check.ok, error: check.error };
}

/** Test seam — the installer writes into the real `<userData>/mcp-servers/`. */
export function __installStagingPrefixForTests(id: string): string {
  return path.join(path.dirname(hostedServerDir(id)), `${id}.installing-`);
}
