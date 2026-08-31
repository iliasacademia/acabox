import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import log from 'electron-log';
import { hashSkillFiles } from '../skillHash';
import { listConnectors } from '../connectorsStore';
import { WORKSPACE_DATA_DIR } from '../../shared/paths';
import { validateHostedServer } from '../../shared/hostedMcp';
import type { HostedMcpEntry, HostedToolDescriptor } from '../../shared/hostedMcp';
import {
  hostedServerDir,
  listHostedServers,
  getHostedServer,
  registerHostedServer,
  updateHostedServer,
  removeHostedServer,
  isEncryptionAvailable,
} from './store';
import { startServer, stopServer, probeServer } from './supervisor';

/**
 * Increment 5, host half (`docs/design/mcp-hosting.md`) — the ONE acquisition
 * path this module adds on top of the already-complete supervisor/store/
 * façade: a server Claude wrote into `<workspace>/.mcp-servers/<id>/`.
 *
 * The agent-facing half already shipped
 * (`src/cobuilding/skills/manage-mcp-server/`) and its `SKILL.md` is the spec
 * this module adopts, not the other way round: `manifest.json` is
 * `{id, label, description}`, the entry point is `index.mjs` BY CONVENTION —
 * the manifest never declares a command — and the directory name must equal
 * the manifest's own `id`.
 *
 * ============================================================================
 * THIS IS NOT AN MCP TOOL, AND MUST NEVER BECOME ONE.
 * ============================================================================
 * The agent writes files; this module (running boot- and IPC-triggered, in
 * the main process) notices them; the USER enables. There is no function here
 * an MCP relay could wrap to let the agent register or enable its own server
 * — `scanAndAdoptAuthoredServers` always lands a fresh record `enabled: false`
 * (via `registerHostedServer`'s own non-negotiable stance, not a check this
 * file adds), and `promoteAndEnableAuthoredServer` is reachable only from the
 * Servers page's IPC handlers in `main/index.ts`, which run on a user gesture.
 * If a future change is tempted to expose either of these as
 * `mcp__mcp-servers__*` tools so the agent can "finish the job itself" in the
 * same turn — don't. That is exactly the property `shared/connectors.ts`'s
 * header comment exists to protect: an agent that can grant itself a new
 * persistent capability is an agent that doesn't need the user's workspace
 * access to expand its own reach. Whether the agent gains a new capability is
 * a decision this codebase deliberately reserves for a human clicking a
 * button, the same shape as skill import (`skillStore.ts`) and for the same
 * reason.
 *
 * ============================================================================
 * PROMOTE-ON-ENABLE IS THE SECURITY MODEL, NOT A COPY STEP.
 * ============================================================================
 * The agent has Write + Bash on the workspace for the entire life of a chat,
 * so a server whose CODE is still the workspace copy is code the agent could
 * change after the user approved it — approval would be theatre. So enabling
 * an authored server does not flip a flag: it copies `.mcp-servers/<id>/` to
 * `<userData>/mcp-servers/<id>/` (via `store.ts`'s `hostedServerDir`, the same
 * namespace Increment 6 will use for npm/GitHub installs) and the record's
 * `entry` always points at THAT copy — never the workspace path. Editing the
 * workspace copy after approval does nothing until the user re-promotes,
 * exactly as `manage-mcp-server/SKILL.md` tells the agent to say.
 *
 * ============================================================================
 * WHY PROMOTION IS "REMOVE THEN RE-REGISTER", NOT AN UPDATE
 * ============================================================================
 * `shared/hostedMcp.ts` is frozen for this pass and `store.ts`/`supervisor.ts`
 * are treated as a fixed, already-complete API surface (per the increment's
 * own brief) — not touched here. Its two mutators for an EXISTING record,
 * `updateHostedServer` and `replaceHostedServerConfig`, deliberately do not
 * accept `fileHashes`/`toolsAtApproval` (see their own doc comments in
 * `store.ts`); only `registerHostedServer` — for a NEW record — does. Since
 * "record fileHashes at promotion" is required on EVERY promotion, not just
 * the first, this module removes the existing row and re-registers under the
 * same id, carrying forward everything the user had already set
 * (env/autostart/concurrency/enabledTools/readinessTimeoutMs). The one field
 * this loses is `createdAt` (it becomes "last promoted", not "first
 * adopted") — cosmetic, not a safety property. A per-id lock
 * (`withPromotionLock`) serializes this against a second concurrent
 * promotion of the SAME id (e.g. a double-click); it does not protect against
 * an unrelated concurrent store mutation landing in the gap between the
 * remove and the re-register, which is a narrow, accepted window given this
 * is a user-gestured action, not a hot path.
 *
 * ============================================================================
 * WHY AN AGENT-AUTHORED SERVER RUNS AS "ELECTRON AS NODE", NOT SYSTEM NODE
 * ============================================================================
 * `containerService.ts`'s own agent-server spawn (`process.execPath` +
 * `ELECTRON_RUN_AS_NODE=1`) is reused here rather than resolving a `node` on
 * PATH: it removes a dependency on the user having system Node installed at
 * all for something Acabox itself wrote and controls end to end, and it is
 * the exact launch shape Increment 6's own design note prescribes for
 * "servers Acabox installs and launches itself" ("`NODE_MODULE_VERSION` is a
 * constant we control"). `ELECTRON_RUN_AS_NODE` is deliberately absent from
 * `hostedEnv.ts`'s allowlist (nothing should inherit it from Acabox's own
 * environment) but is layered on explicitly here through the record's OWN
 * `env`, which `buildHostedEnv` always lets through regardless of the
 * allowlist — the same idiom the mcpHost smoke test and every existing
 * fixture-driven test in this subsystem already use.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The workspace root is a pure function of `userData` (`WorkspaceController
 * .getAgentControlledDir()` computes the identical path), so this module
 * needs no wiring/injection from `main/index.ts` to find it — reading it
 * directly here keeps this module's only allowed touch to that file scoped to
 * IPC handlers, per this increment's file territory.
 */
function workspaceRoot(): string {
  return path.join(app.getPath('userData'), WORKSPACE_DATA_DIR);
}

function workspaceAuthoredRoot(): string {
  return path.join(workspaceRoot(), '.mcp-servers');
}

const AUTHORED_RUN_ENV: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };

function authoredEntry(id: string): HostedMcpEntry {
  const dir = hostedServerDir(id);
  return { command: process.execPath, args: [path.join(dir, 'index.mjs')], cwd: dir };
}

// Duplicated rather than imported from `mcpHost/index.ts`'s identical
// `NO_ENCRYPTION_MESSAGE`: that module imports THIS one (to wire the scan
// into `startAll()` and to expose the façade functions below), so importing
// the other direction for one string would make the two files circularly
// dependent. One literal, kept in sync by eye, is cheaper than that.
const NO_ENCRYPTION_MESSAGE =
  'Hosted MCP servers are disabled on this machine: the OS keyring is not available, so server configs cannot be sealed at rest.';

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

interface AuthoredManifest {
  id: string;
  label: string;
  description: string;
}

type ManifestCheck =
  | { ok: true; manifest: AuthoredManifest }
  | { ok: false; reason: string };

/**
 * The skill's own contract (`manage-mcp-server/SKILL.md`, "The directory
 * contract"): `manifest.json` is `{id, label, description}`, the directory
 * name must equal `id`, and `index.mjs` must sit next to it. Every rejection
 * reason here is written to be shown verbatim to the user — the SKILL.md's
 * own "If something goes wrong" table tells the agent an id collision or a
 * mismatch is "the first thing to suspect", so the text needs to say which.
 */
function readManifestIfValid(dir: string, expectedId: string): ManifestCheck {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');
  } catch {
    return { ok: false, reason: 'No manifest.json in this directory.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `manifest.json is not valid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'manifest.json is not a JSON object.' };
  }

  const m = parsed as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id) {
    return { ok: false, reason: 'manifest.json has no "id".' };
  }
  if (typeof m.label !== 'string' || !m.label) {
    return { ok: false, reason: 'manifest.json has no "label".' };
  }
  if (m.id !== expectedId) {
    return {
      ok: false,
      reason: `The directory name ("${expectedId}") does not match manifest.json's "id" ("${m.id}") — they must match.`,
    };
  }

  let indexIsFile = false;
  try {
    indexIsFile = fs.statSync(path.join(dir, 'index.mjs')).isFile();
  } catch { /* absent */ }
  if (!indexIsFile) {
    return { ok: false, reason: 'No index.mjs next to manifest.json.' };
  }

  const description = typeof m.description === 'string' ? m.description : '';
  return { ok: true, manifest: { id: m.id, label: m.label, description } };
}

/**
 * `description` has nowhere to live on `HostedMcpRecord` (frozen for this
 * pass — see the module comment), so it is read live from disk rather than
 * persisted. Reads the WORKSPACE copy first (freshest: per the skill's
 * "Editing an already-approved server" section, the agent may update the
 * wording after approval, and display text carries no security weight, so
 * there is no reason to wait for a re-promotion before showing it), falling
 * back to the PROMOTED copy so a description survives the user tidying up or
 * deleting the workspace source after approval.
 */
function readManifestDescriptionLoose(dir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const d = (parsed as Record<string, unknown>).description;
      if (typeof d === 'string' && d) return d;
    }
  } catch { /* missing/unreadable/malformed manifest — nothing to show */ }
  return undefined;
}

export function authoredDescription(id: string): string | undefined {
  return readManifestDescriptionLoose(path.join(workspaceAuthoredRoot(), id))
    ?? readManifestDescriptionLoose(hostedServerDir(id));
}

// ---------------------------------------------------------------------------
// The "known ids" ledger — what makes adoption idempotent AND non-resurrecting
// ---------------------------------------------------------------------------

const KNOWN_IDS_VERSION = 1;

function knownIdsFilePath(): string {
  return path.join(app.getPath('userData'), 'mcp-servers', 'authored-known-ids.json');
}

let knownIdsQueue: Promise<unknown> = Promise.resolve();
function withKnownIdsLock<T>(fn: () => T): Promise<T> {
  const run = knownIdsQueue.catch(() => undefined).then(fn);
  knownIdsQueue = run.catch(() => undefined);
  return run;
}

function readKnownIdsSync(): string[] {
  try {
    const raw = fs.readFileSync(knownIdsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.ids)) {
      return parsed.ids.filter((x: unknown): x is string => typeof x === 'string');
    }
  } catch { /* missing/unreadable — nothing adopted yet, same "absent is normal" stance store.ts takes */ }
  return [];
}

function writeKnownIdsSync(ids: string[]): void {
  const target = knownIdsFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: KNOWN_IDS_VERSION, ids }, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, target);
}

/**
 * Every id ever successfully adopted from `.mcp-servers/`, regardless of its
 * CURRENT state (awaiting review, approved, or removed). Not sealed — ids are
 * not secret — and deliberately separate from `store.ts`'s `servers.json`:
 * that file's row for an id disappears the moment the user removes it
 * (`removeHostedServer`), which is exactly the fact this ledger exists to
 * survive. Without it, a removed server whose workspace directory the user
 * (or the agent) never deleted would look brand new on the very next scan and
 * come back — the opposite of what clicking Remove means. The trade-off,
 * stated plainly: once an id is adopted it is claimed for good on this
 * install — a later, unrelated directory that happens to reuse the same id
 * will never be picked up. That mirrors skill import's own id-collision rule
 * ("refuse — never silently rename, never replace").
 *
 * A candidate that fails validation is NOT added here, on purpose: a
 * rejection is meant to be retried on the next scan once the agent (or user)
 * fixes it — `manage-mcp-server/SKILL.md`'s own troubleshooting table tells
 * the agent to "rename the directory and manifest.json's id together and try
 * again", which only works if a fixed candidate gets a second look.
 */
async function readKnownIds(): Promise<string[]> {
  return withKnownIdsLock(() => readKnownIdsSync());
}

async function addKnownId(id: string): Promise<void> {
  await withKnownIdsLock(() => {
    const ids = readKnownIdsSync();
    if (!ids.includes(id)) writeKnownIdsSync([...ids, id]);
  });
}

// ---------------------------------------------------------------------------
// Discovery → adoption
// ---------------------------------------------------------------------------

export interface AuthoredScanRejection {
  dir: string;
  reason: string;
}

export interface AuthoredScanResult {
  adopted: string[];
  rejected: AuthoredScanRejection[];
}

/** The reasons from the MOST RECENT scan — read by `listAuthoredInfo()` so
 *  the Servers page can show "N items could not be adopted: …" without the
 *  caller having to separately track the last `scanAndAdoptAuthoredServers()`
 *  return value itself (boot's own call site never keeps it). */
let lastScanRejections: AuthoredScanRejection[] = [];

let inflightScan: Promise<AuthoredScanResult> | null = null;

/**
 * Scan `<workspace>/.mcp-servers/*` and register each valid, not-yet-known
 * directory as a hosted record with `install: {kind: 'authored'}`. Single-
 * flight (mirrors `index.ts`'s `startAll` — R10's reasoning applies here too:
 * this is called from `startAll()`, which has more than one call site) and
 * idempotent by construction: a directory whose id is already in the known-
 * ids ledger is skipped outright, whether it is currently pending, approved,
 * or was removed by the user.
 */
export async function scanAndAdoptAuthoredServers(): Promise<AuthoredScanResult> {
  if (inflightScan) return inflightScan;
  inflightScan = scanAndAdoptAuthoredServersInner().finally(() => { inflightScan = null; });
  return inflightScan;
}

async function scanAndAdoptAuthoredServersInner(): Promise<AuthoredScanResult> {
  const root = workspaceAuthoredRoot();
  const result: AuthoredScanResult = { adopted: [], rejected: [] };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No `.mcp-servers` directory at all — the normal state for a workspace
    // Claude has never written a server into. Not an error, nothing to log.
    lastScanRejections = [];
    return result;
  }

  const known = new Set(await readKnownIds());

  for (const entry of entries) {
    // A symlinked directory reports `isDirectory() === false` on its own
    // Dirent (measured and relied on elsewhere in this codebase —
    // `skillHash.ts`'s tree walker notes the same thing) — this check is
    // what keeps a symlinked `.mcp-servers/<x>` out of consideration at all,
    // the same way the workspace-root reaper skips symlinks.
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (dirName.startsWith('.')) continue;
    if (known.has(dirName)) continue;

    const dirPath = path.join(root, dirName);
    const validation = readManifestIfValid(dirPath, dirName);
    if (!validation.ok) {
      result.rejected.push({ dir: dirName, reason: validation.reason });
      continue;
    }

    const id = validation.manifest.id;
    const existingHostedIds = (await listHostedServers()).map((r) => r.id);
    const connectorIds = listConnectors().map((c) => c.id);
    const idCheck = validateHostedServer(
      { id, entry: authoredEntry(id) },
      [...existingHostedIds, ...connectorIds],
    );
    if (!idCheck.ok) {
      result.rejected.push({ dir: dirName, reason: idCheck.error! });
      continue;
    }

    const registered = await registerHostedServer({
      id,
      label: validation.manifest.label,
      autostart: false,
      install: { kind: 'authored' },
      entry: authoredEntry(id),
      env: { ...AUTHORED_RUN_ENV },
    });
    if (!registered.ok) {
      // Store-level race (something else registered this id between the
      // check above and here) or a validation this file didn't anticipate —
      // `registerHostedServer` re-validates inside its own lock, so its
      // answer is authoritative. Not added to the known-ids ledger: same
      // "retry on the next scan" reasoning as any other rejection.
      result.rejected.push({ dir: dirName, reason: registered.error! });
      continue;
    }

    await addKnownId(id);
    result.adopted.push(id);
    log.info(`[McpHost] Adopted an agent-authored server from the workspace: "${id}" — awaiting your review on the Servers page.`);
  }

  for (const r of result.rejected) {
    log.warn(`[McpHost] Could not adopt ".mcp-servers/${r.dir}": ${r.reason}`);
  }
  lastScanRejections = result.rejected;
  return result;
}

// ---------------------------------------------------------------------------
// Drift — "N changes in the workspace since you approved"
// ---------------------------------------------------------------------------

/**
 * Files that differ between the workspace source and the `fileHashes`
 * recorded at the last (re-)promotion. `undefined` — never `0` — for a record
 * that has not been promoted yet: there is no baseline to diff against, the
 * same "undefined for no baseline" rule `skillStore.ts`'s `isModified` uses
 * for a custom skill with no pristine counterpart.
 *
 * Deliberately NOT folded into `mcpHost.list()` / `McpHostListEntry` — that
 * function backs the live `mcpServers:changed` broadcast, which fires on
 * every supervisor status transition, INCLUDING a ready server's routine
 * ping (every 30s by default). Hashing a tree on every one of those pushes is
 * exactly the "re-hash the whole tree on every render" trap this increment's
 * brief calls out by name. Callers reach this through `listAuthoredInfo()`
 * below, which the Servers page calls on its own, much coarser cadence
 * (mount, after a mutation, or a manual "check" click) instead of on every
 * store broadcast.
 */
export async function computeAuthoredDrift(id: string): Promise<number | undefined> {
  const record = await getHostedServer(id);
  if (!record || record.install.kind !== 'authored' || !record.fileHashes) return undefined;

  // `hashSkillFiles`/`readSkillTree` never throw for a missing directory —
  // every `readdirSync` in the walker is internally caught and treated as an
  // empty subtree — so a workspace source the user deleted after approving
  // reads as "every previously-tracked file is now a change", which is an
  // honest (if blunt) way to say "the source is gone", not a crash.
  const current = hashSkillFiles(path.join(workspaceAuthoredRoot(), id));

  const baseline = record.fileHashes;
  const changed = new Set<string>();
  for (const [rel, hash] of Object.entries(baseline)) {
    if (current[rel] !== hash) changed.add(rel);
  }
  for (const rel of Object.keys(current)) {
    if (!(rel in baseline)) changed.add(rel);
  }
  return changed.size;
}

export interface AuthoredServerInfo {
  id: string;
  description?: string;
  /** `undefined` = never promoted (nothing to diff against); otherwise the
   *  file-drift count — `0` is a real, distinct "promoted, no drift" state. */
  driftCount?: number;
}

export interface AuthoredListResult {
  servers: AuthoredServerInfo[];
  rejected: AuthoredScanRejection[];
}

/** Everything the "Authored by Claude" section needs beyond the generic
 *  hosted-row pipeline (`mcpHost.list()`): the manifest's own description
 *  text and the drift count, neither of which belongs on the hot list()
 *  path — see `computeAuthoredDrift`'s comment. */
export async function listAuthoredInfo(): Promise<AuthoredListResult> {
  const records = (await listHostedServers()).filter((r) => r.install.kind === 'authored');
  const servers: AuthoredServerInfo[] = [];
  for (const r of records) {
    servers.push({
      id: r.id,
      description: authoredDescription(r.id),
      driftCount: await computeAuthoredDrift(r.id),
    });
  }
  return { servers, rejected: lastScanRejections };
}

// ---------------------------------------------------------------------------
// Promote-on-enable
// ---------------------------------------------------------------------------

export interface PromoteAuthoredServerResult {
  ok: boolean;
  error?: string;
  toolCount?: number;
}

function cleanupDirBestEffort(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * `fs.cpSync` options mirror `skillStore.ts`'s own `copyTree`: `recursive`
 * for the obvious reason, `preserveTimestamps` so a re-promote of unchanged
 * files doesn't manufacture spurious mtime churn, `verbatimSymlinks` so a
 * relative link inside the tree isn't silently rewritten against its new
 * location (which would change its bytes and therefore its hash), and the
 * EINTR retry because a signal during a large recursive copy aborts `cpSync`
 * — inherited from a real failure `skills.ts` hit first. Authored-server
 * trees are tiny (a handful of files) compared to a skill's, but the copy
 * primitive costs nothing extra to make robust the same way.
 */
function copyDirRetrying(src: string, dest: string, maxRetries = 5): void {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, force: true });
      return;
    } catch (err: any) {
      if (err && err.code === 'EINTR' && attempt < maxRetries) continue;
      throw err;
    }
  }
}

const promotionLocks = new Map<string, Promise<unknown>>();
function withPromotionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prior = promotionLocks.get(id) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(fn);
  promotionLocks.set(id, run.catch(() => undefined));
  return run;
}

/**
 * Promote `.mcp-servers/<id>/` into `<userData>/mcp-servers/<id>/` and run
 * THAT copy — the security model this whole file exists for (see the module
 * comment). Used identically for the FIRST approval ("Review & enable") and
 * every later re-promotion ("N changes … Review") — there is no reason for
 * the two to be different operations, since both mean the same thing: "make
 * the running copy match what's in the workspace right now, and (re)start
 * it."
 *
 * Order of operations, and why: copy to a STAGING dir → hash the staged copy
 * (not the workspace source — the baseline that matters is what will
 * actually run) → probe the staged copy (never the live promoted dir, so a
 * currently-running previous promotion is undisturbed while the candidate is
 * validated) → only on success, stop whatever is currently running → swap
 * the staged copy into place (old copy moved aside, never deleted first,
 * mirroring `selfUpdater.ts`'s bundle swap — a failure between the two
 * renames must not leave nothing installed) → persist + enable + start.
 * A failure at any point before the swap leaves the previously-approved copy
 * (if any) completely untouched and still running.
 */
export async function promoteAndEnableAuthoredServer(id: string): Promise<PromoteAuthoredServerResult> {
  return withPromotionLock(id, () => promoteAndEnableAuthoredServerInner(id));
}

async function promoteAndEnableAuthoredServerInner(id: string): Promise<PromoteAuthoredServerResult> {
  if (!isEncryptionAvailable()) return { ok: false, error: NO_ENCRYPTION_MESSAGE };

  const record = await getHostedServer(id);
  if (!record) return { ok: false, error: `No agent-authored server named "${id}".` };
  if (record.install.kind !== 'authored') {
    return { ok: false, error: `"${id}" was not written by Claude — there is nothing to promote.` };
  }

  const sourceDir = path.join(workspaceAuthoredRoot(), id);
  let sourceIsDir = false;
  try {
    sourceIsDir = fs.statSync(sourceDir).isDirectory();
  } catch { /* absent */ }
  if (!sourceIsDir) {
    return { ok: false, error: `The workspace no longer has ".mcp-servers/${id}/" — nothing to promote.` };
  }

  // Re-validate at PROMOTION time, not just at adoption: the agent has Write
  // on the workspace for as long as this record exists, so the manifest may
  // have drifted since adoption (e.g. its own "id" field edited to something
  // else — the directory name stays authoritative).
  const validation = readManifestIfValid(sourceDir, id);
  if (!validation.ok) return { ok: false, error: validation.reason };

  const targetDir = hostedServerDir(id);
  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stagingDir = path.join(parentDir, `${id}.staging-${randomUUID()}`);
  const backupDir = path.join(parentDir, `${id}.previous-${randomUUID()}`);

  try {
    copyDirRetrying(sourceDir, stagingDir);
  } catch (err) {
    cleanupDirBestEffort(stagingDir);
    return { ok: false, error: `Could not copy the workspace files: ${(err as Error).message}` };
  }

  let fileHashes: Record<string, string>;
  try {
    fileHashes = hashSkillFiles(stagingDir);
  } catch (err) {
    cleanupDirBestEffort(stagingDir);
    return { ok: false, error: `Could not read the copied files: ${(err as Error).message}` };
  }

  const probe = await probeServer({
    command: process.execPath,
    args: [path.join(stagingDir, 'index.mjs')],
    cwd: stagingDir,
    env: { ...AUTHORED_RUN_ENV },
  });
  if (!probe.ok) {
    cleanupDirBestEffort(stagingDir);
    return { ok: false, error: probe.error ?? 'The server did not answer initialize/tools-list.' };
  }

  // Stop whatever is currently running for this id BEFORE the swap below —
  // a safe no-op if nothing has ever been started (first-time approval); see
  // `supervisor.stopServer`'s own "no handle, return" branch.
  await stopServer(id, { finalState: 'stopped' }).catch(() => { /* best effort */ });

  try {
    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
    fs.renameSync(stagingDir, targetDir);
  } catch (err) {
    if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
      try { fs.renameSync(backupDir, targetDir); } catch { /* best-effort roll-back */ }
    }
    cleanupDirBestEffort(stagingDir);
    return { ok: false, error: `Could not install the new copy: ${(err as Error).message}` };
  }
  cleanupDirBestEffort(backupDir);

  const toolsAtApproval: HostedToolDescriptor[] = probe.toolNames.map((name) => ({ name }));

  // No update path exists for `fileHashes`/`toolsAtApproval` on an EXISTING
  // record — see the module comment's "WHY PROMOTION IS REMOVE-THEN-RE-
  // REGISTER" section. Carry forward everything the user had already set.
  const preserved = record;
  await removeHostedServer(id);
  const reReg = await registerHostedServer({
    id,
    label: preserved.label,
    autostart: true,
    install: { kind: 'authored' },
    entry: authoredEntry(id),
    env: preserved.env,
    concurrency: preserved.concurrency,
    readinessTimeoutMs: preserved.readinessTimeoutMs,
    fileHashes,
    toolsAtApproval,
    enabledTools: preserved.enabledTools,
  });
  if (!reReg.ok) {
    return { ok: false, error: `The files promoted cleanly, but the server's saved config could not be updated: ${reReg.error}` };
  }
  await updateHostedServer(id, { enabled: true });

  const fresh = await getHostedServer(id);
  if (fresh) startServer(fresh);

  return { ok: true, toolCount: toolsAtApproval.length };
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Test seam — production code never calls this. Resets in-memory state only;
 *  a test still owns clearing whatever it wrote to the real temp userData dir. */
export function __resetAuthoredStateForTests(): void {
  lastScanRejections = [];
  inflightScan = null;
  knownIdsQueue = Promise.resolve();
  promotionLocks.clear();
}
