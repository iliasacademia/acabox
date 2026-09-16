import log from 'electron-log';
import * as fs from 'fs';
import * as supervisor from './supervisor';
import * as authored from './authored';
import * as installer from './installer';
import {
  listHostedServers,
  getHostedServer,
  updateHostedServer,
  registerHostedServer,
  replaceHostedServerConfig,
  removeHostedServer,
  reconcileOrphans,
  isEncryptionAvailable,
  hostedServerDir,
} from './store';
import { validateHostedServer, isToolSelected } from '../../shared/hostedMcp';
import type {
  HostedInstallSource,
  HostedMcpEntry,
  HostedMcpRecord,
  HostedRunState,
  HostedServerPush,
  HostedToolDescriptor,
} from '../../shared/hostedMcp';
import { listConnectors } from '../connectorsStore';

export type { ProbeInput, ProbeResult } from './supervisor';
export type {
  AuthoredScanRejection,
  AuthoredScanResult,
  AuthoredServerInfo,
  AuthoredListResult,
  PromoteAuthoredServerResult,
} from './authored';

/**
 * The singleton façade for hosted MCP servers (design:
 * `docs/design/mcp-hosting.md`, Increment 2 — the module table's `index.ts`
 * row: `startAll/start/pause/stop/restart/remove/list/inventory/invoke/
 * onInventoryChanged/shutdown`, and nothing else). This is the ONLY module
 * downstream code (a future IPC layer, `AgentInfrastructureController`)
 * should import from `mcpHost/` — `supervisor.ts` and `store.ts` are its
 * implementation, not a second public surface.
 *
 * Division of labour, made explicit because it is easy to blur: this module
 * reads/writes the PERSISTED record (`store.ts`) and decides WHETHER a
 * runtime action should happen; `supervisor.ts` decides HOW to spawn, keep
 * healthy, and tear down a process once told to. Registration
 * (`store.registerHostedServer`) is deliberately NOT re-exported here — the
 * design's façade signature list does not include it, a freshly-registered
 * server is always `enabled: false` so there is nothing for a runtime
 * façade to do about it yet, and a future Increment 3/5/6 caller reaches
 * `store.ts` directly for that, exactly as `store.ts`'s own header already
 * documents.
 *
 * **Deliberately does NOT register anything in `jobRegistry`.** Its
 * `running` jobs are never pruned and `activeJobs()` drives the quit
 * dialog — a long-lived hosted server counted there would prompt "N pieces
 * of work are still running" on every single quit. `mcpHostIndex.test.ts`
 * pins this with a real running server and a real `activeJobs()` call.
 *
 * **Increment 5 addendum:** the signature list above predates agent-authored
 * servers. `scanAuthoredServers`/`listAuthoredInfo`/`approveAuthoredServer`
 * near the bottom of this file ARE the exception to "registration is not
 * re-exported here" — an authored server's registration is driven by a
 * filesystem scan rather than a form submit, so unlike the Advanced form's
 * `save()` there is no caller outside this subsystem that could reasonably
 * own it. All three are thin wrappers over `./authored`, which is where the
 * actual design (promote-on-enable, the "not an MCP tool" boundary) lives.
 */

export interface McpHostListEntry {
  id: string;
  label: string;
  /** Whether this server may run at all — the persisted `enabled` flag. */
  enabled: boolean;
  /** Whether `startAll()` spawns it at boot. */
  autostart: boolean;
  install: HostedInstallSource;
  concurrency: number;
  /** Resolved command + argv. Never `env` — see the module comment on `list()`. */
  command: string;
  args: string[];
  cwd?: string;
  /** Env var NAMES only — the detail panel's "env keys, values masked". A key
   *  name (`API_TOKEN`) is not itself a secret; the value never crosses IPC. */
  envKeys: string[];
  /**
   * Increment 7's write gate. `undefined` means every tool is selected (the
   * default — see `shared/hostedMcp.ts`'s `HostedMcpRecord.enabledTools` doc
   * comment); an empty array means none. Safe to send over IPC as-is — a
   * tool NAME is not a secret the way `env` is, so this needs no masking.
   */
  enabledTools?: string[];
  state: HostedRunState;
  pid?: number;
  startedAt?: number;
  error?: string;
  toolCount?: number;
  restartCount?: number;
}

export interface McpHostActionResult {
  ok: boolean;
  error?: string;
}

const NO_ENCRYPTION_MESSAGE =
  'Hosted MCP servers are disabled on this machine: the OS keyring is not available, so server configs cannot be sealed at rest.';

function maskRecord(record: HostedMcpRecord): McpHostListEntry {
  const status = supervisor.getStatus(record.id);
  return {
    id: record.id,
    label: record.label,
    enabled: record.enabled,
    autostart: record.autostart,
    install: record.install,
    concurrency: record.concurrency,
    command: record.entry.command,
    args: record.entry.args,
    cwd: record.entry.cwd,
    envKeys: Object.keys(record.env ?? {}),
    enabledTools: record.enabledTools,
    // No live supervisor status yet (never started this session) — derive a
    // resting label from the persisted flags rather than claiming `stopped`
    // for a server that is actually `enabled: false`.
    state: status?.state ?? (record.enabled ? 'stopped' : 'paused'),
    pid: status?.pid,
    startedAt: status?.startedAt,
    error: status?.error,
    toolCount: status?.toolCount,
    restartCount: status?.restartCount,
  };
}

// ---------------------------------------------------------------------------
// startAll — single-flight (R10), never throws (same contract as apiProxy.start())
// ---------------------------------------------------------------------------

let inflightStartAll: Promise<void> | null = null;
let lastStartAllError: string | null = null;

/** The reason the most recent `startAll()` did not spawn everything it should have — `null` when nothing is wrong. Surfaced for a future Settings/Servers page; never thrown. */
export function lastStartAllErrorMessage(): string | null {
  return lastStartAllError;
}

/**
 * Spawn every enabled+autostart server. Single-flight: `AgentInfrastructureController.start()`
 * has two call sites (a renderer reload re-enters it), so a second concurrent
 * call returns the SAME in-flight promise rather than issuing a second
 * reconcile+spawn wave — the `ensurePythonVenv` pattern
 * (`pythonSetup.ts:131-144`).
 *
 * Does not block boot: every spawn is issued via `supervisor.startServer`,
 * which is itself synchronous and fire-and-forget — this function's own
 * awaited work is two store reads (records + orphan reconciliation), not
 * any server's readiness. Never throws; a failure is recorded in
 * `lastStartAllErrorMessage()` and logged.
 */
export async function startAll(): Promise<void> {
  if (inflightStartAll) return inflightStartAll;
  inflightStartAll = startAllInner().finally(() => { inflightStartAll = null; });
  return inflightStartAll;
}

async function startAllInner(): Promise<void> {
  if (!isEncryptionAvailable()) {
    lastStartAllError = NO_ENCRYPTION_MESSAGE;
    log.warn(`[McpHost] ${lastStartAllError} Refusing to autostart anything.`);
    return;
  }
  lastStartAllError = null;

  // Increment 5 (docs/design/mcp-hosting.md): adopt any agent-authored server
  // waiting in `<workspace>/.mcp-servers/`. Runs before the orphan reconcile
  // and spawn loop below on purpose — an authored server just adopted this
  // boot is always `enabled: false` (`registerHostedServer`'s own stance), so
  // it has nothing to reconcile or spawn yet, but a rejection here should not
  // be allowed to block real, already-approved servers from starting.
  try {
    const scan = await authored.scanAndAdoptAuthoredServers();
    for (const id of scan.adopted) emitRecordChange(id);
    if (scan.adopted.length > 0 || scan.rejected.length > 0) {
      log.info(`[McpHost] Authored-server scan: adopted ${scan.adopted.length}, rejected ${scan.rejected.length}.`);
    }
  } catch (err) {
    log.warn(`[McpHost] Authored-server scan failed: ${(err as Error).message}`);
    // Deliberately continue — same reasoning as the orphan-reconcile catch
    // below: a scan failure must not also block every already-approved
    // server from starting.
  }

  try {
    const { killed, spared } = await reconcileOrphans();
    if (killed > 0 || spared > 0) {
      log.info(`[McpHost] Boot reconcile: reaped ${killed} orphaned process(es), spared ${spared} (pid reused by something else).`);
    }
  } catch (err) {
    lastStartAllError = `Orphan reconciliation failed: ${(err as Error).message}`;
    log.warn(`[McpHost] ${lastStartAllError}`);
    // Deliberately continue to the spawn pass below — a reconcile failure
    // (e.g. `ps`/`pgrep` unavailable) should not also block every server
    // from starting; the two failures are independent.
  }

  try {
    const records = await listHostedServers();
    for (const record of records) {
      if (record.enabled && record.autostart) {
        supervisor.startServer(record);
      }
    }
  } catch (err) {
    lastStartAllError = `Could not read hosted server configs: ${(err as Error).message}`;
    log.error(`[McpHost] ${lastStartAllError}`);
  }
}

// ---------------------------------------------------------------------------
// Per-server actions
// ---------------------------------------------------------------------------

/**
 * Turn a server on: make it enabled, then spawn it. The exact inverse of
 * `pause`, and the action the detail panel's "Turn on" performs.
 *
 * This used to refuse a disabled record with `"<id>" is off. Turn it on
 * first.` — self-contradictory advice, because NOTHING in the app could set
 * `enabled: true` except `approveAuthoredServer`. A server added through the
 * Advanced form, which `registerHostedServer` writes `enabled: false` as a
 * non-negotiable literal, was therefore permanently off: the button that
 * should have turned it on told the user to turn it on. Pre-existing (zero
 * `enabled: true` sites here before Increment 6), and reachable for the first
 * time now that installing a server is a normal thing to do.
 *
 * Enabling is still never implicit: it happens only on this explicit,
 * user-gestured call. Nothing about install, adoption or boot flips it.
 */
export async function start(id: string): Promise<McpHostActionResult> {
  if (!isEncryptionAvailable()) return { ok: false, error: NO_ENCRYPTION_MESSAGE };
  const record = await getHostedServer(id);
  if (!record) return { ok: false, error: `No hosted server named "${id}".` };
  if (!record.enabled) {
    const ok = await updateHostedServer(id, { enabled: true });
    if (!ok) return { ok: false, error: `"${id}" was removed by someone else already.` };
  }
  // Re-read so the supervisor spawns from the record as it now stands, not
  // the pre-enable snapshot.
  const fresh = await getHostedServer(id);
  if (!fresh) return { ok: false, error: `"${id}" was removed by someone else already.` };
  supervisor.startServer(fresh);
  emitRecordChange(id);
  return { ok: true };
}

/** Turns the server off persistently (`enabled: false`) AND stops the running process, if any. Reads "Off" in the Increment 3 vocabulary. */
export async function pause(id: string, opts: { graceMs?: number } = {}): Promise<McpHostActionResult> {
  const record = await getHostedServer(id);
  if (!record) return { ok: false, error: `No hosted server named "${id}".` };
  await updateHostedServer(id, { enabled: false });
  await supervisor.pauseServer(id, opts);
  return { ok: true };
}

/** Stops the running process WITHOUT disabling it — the server stays enabled and eligible for `start`/`restart`, it just is not running right now. */
export async function stop(id: string, opts: { graceMs?: number } = {}): Promise<McpHostActionResult> {
  const record = await getHostedServer(id);
  if (!record) return { ok: false, error: `No hosted server named "${id}".` };
  await supervisor.stopServer(id, { ...opts, finalState: 'stopped' });
  return { ok: true };
}

/** The explicit "try again" the design's backoff policy waits for once a server reaches `failed`. Resets the backoff counter and respawns unconditionally. */
export async function restart(id: string): Promise<McpHostActionResult> {
  if (!isEncryptionAvailable()) return { ok: false, error: NO_ENCRYPTION_MESSAGE };
  const record = await getHostedServer(id);
  if (!record) return { ok: false, error: `No hosted server named "${id}".` };
  if (!record.enabled) return { ok: false, error: `"${id}" is off. Turn it on first.` };
  supervisor.restartServer(record);
  return { ok: true };
}

/**
 * Stop (if running) and delete this server's config permanently.
 *
 * Disk reclamation for an installed (npm/GitHub) server's own tree is
 * Increment 6/R13 territory — no such tree exists yet in this pass (every
 * record here is `install.kind === 'custom'`), so there is nothing for this
 * function to reclaim beyond the config row itself. Whoever adds Increment
 * 6 should extend this, not add a second removal path.
 */
export async function remove(id: string, opts: { graceMs?: number } = {}): Promise<McpHostActionResult> {
  const record = await getHostedServer(id);
  if (!record) return { ok: false, error: `No hosted server named "${id}".` };
  await supervisor.forgetServer(id, opts);
  const removed = await removeHostedServer(id);
  // Same silence as adoption, in the other direction: a server that was never
  // started has no handle, so `forgetServer` fires no status change and the
  // row it just deleted would sit on the Servers page until a reload. Measured
  // 2026-09-01 alongside the adoption case.
  if (removed) {
    emitRecordChange(id);
    reclaimHostedServerDir(id);
  }
  return { ok: removed, error: removed ? undefined : `"${id}" was removed by someone else already.` };
}

/**
 * Delete the promoted copy a removed server was running from.
 *
 * Removing a server used to drop only its record, leaving
 * `<userData>/mcp-servers/<id>/` on disk forever. Two consequences, and the
 * second is the one that bites: an npm-installed server carries its own
 * `node_modules` (tens of MB), and re-adopting the SAME id later would promote
 * a fresh copy on top of a stale tree rather than into a clean directory. This
 * repo already carries one unpruned-accumulation bug on record
 * (`workspace-file-backups/`); this is not going to be the second.
 *
 * Deliberately `rm`, not trash: this tree is a COPY the host made at approve
 * time. The user's own artifact is the agent-written source in
 * `<workspace>/.mcp-servers/<id>/`, which is untouched — removing a server here
 * is not meant to destroy the code Claude wrote, only to stop hosting it.
 *
 * Never throws: the record is already gone, so failing here would report a
 * failed removal that in fact succeeded.
 */
function reclaimHostedServerDir(id: string): void {
  const dir = hostedServerDir(id);
  try {
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    log.info(`[McpHost] Reclaimed the running copy of "${id}" from disk.`);
  } catch (err) {
    log.warn(`[McpHost] Could not delete the running copy of "${id}" at ${dir}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Save — the Advanced add/edit form (Increment 3)
// ---------------------------------------------------------------------------

/**
 * What the Advanced form posts. `env` arrives as a diff — `envUpdates`/
 * `envDeletes` — never a full replacement: the form only ever shows EXISTING
 * keys with masked (blank) password inputs, the same "blank means keep the
 * stored value" convention `connectorsStore`'s header rows use, applied here
 * to a hosted server's own env. A brand-new server has no stored env to
 * diff against, so `envUpdates` alone becomes its whole env.
 */
export interface HostedServerDraft {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  envUpdates: Record<string, string>;
  envDeletes: string[];
  autostart: boolean;
  concurrency?: number;
}

/** `updates` win over `existing`; `deletes` then remove keys — same shape as
 *  `connectorsStore`'s untouched-secret merge, minus the encryption (a hosted
 *  server's own `env` is not individually secret-sealed — the whole record
 *  array is sealed as one ciphertext by `store.ts`). */
function mergeEnvPatch(
  existing: Record<string, string>,
  updates: Record<string, string>,
  deletes: readonly string[],
): Record<string, string> {
  const next = { ...existing, ...updates };
  for (const key of deletes) delete next[key];
  return next;
}

/**
 * Create or update a hosted server's config. Registers (always landing
 * `enabled: false`, per `registerHostedServer`'s own non-negotiable stance)
 * when `draft.id` is new; otherwise replaces the existing record's editable
 * fields via `replaceHostedServerConfig`, leaving `enabled`/`install`/
 * `createdAt`/the R5 pid bookkeeping untouched. Does not itself start
 * anything — the row's own Start action does that (and, for a freshly
 * registered Off server, enables it first; see `main/index.ts`'s
 * `mcpServers:start` handler).
 */
export async function save(draft: HostedServerDraft): Promise<McpHostActionResult> {
  const id = draft.id.trim();
  if (!id) return { ok: false, error: 'Name is required.' };
  const command = draft.command.trim();
  const entry: HostedMcpEntry = { command, args: draft.args, cwd: draft.cwd?.trim() || undefined };

  const existing = await getHostedServer(id);
  const otherHostedIds = (await listHostedServers())
    .filter((r) => r.id !== id)
    .map((r) => r.id);
  // Ids share ONE namespace with connectors (`shared/hostedMcp.ts`'s module
  // comment) — both become the middle segment of `mcp__<id>__<tool>`. Without
  // this, saving a hosted server under an id a connector already owns would
  // silently shadow one of the two in the SDK's merged `mcpServers` record.
  // `listConnectors()` is the masked accessor — only ids are needed here, so
  // there is no reason to touch decrypted secrets for this check.
  const connectorIds = listConnectors().map((c) => c.id);
  const check = validateHostedServer({ id, entry, concurrency: draft.concurrency }, [...otherHostedIds, ...connectorIds]);
  if (!check.ok) return { ok: false, error: check.error };

  if (!existing) {
    const result = await registerHostedServer({
      id,
      label: draft.label.trim() || id,
      autostart: draft.autostart,
      install: { kind: 'custom' },
      entry,
      env: mergeEnvPatch({}, draft.envUpdates, draft.envDeletes),
      concurrency: draft.concurrency,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  const nextEnv = mergeEnvPatch(existing.env, draft.envUpdates, draft.envDeletes);
  const ok = await replaceHostedServerConfig(id, {
    label: draft.label.trim() || id,
    entry,
    env: nextEnv,
    autostart: draft.autostart,
    concurrency: draft.concurrency,
  });
  return ok ? { ok: true } : { ok: false, error: `"${id}" was removed by someone else already.` };
}

// ---------------------------------------------------------------------------
// Test — the Advanced form's probe run (Increment 3)
// ---------------------------------------------------------------------------

export interface HostedServerTestRequest {
  /** Present only when probing an in-progress edit of an existing server —
   *  its stored env is the merge base for `envUpdates`/`envDeletes`. */
  id?: string;
  command: string;
  args: string[];
  cwd?: string;
  envUpdates: Record<string, string>;
  envDeletes: string[];
}

/**
 * Spawn, complete `initialize` + `tools/list`, kill, report. NEVER registers
 * or persists anything — see `supervisor.probeServer`'s own comment for why
 * this reuses the supervisor's `intent: 'probe'` path rather than a second
 * spawn implementation.
 */
export async function test(request: HostedServerTestRequest): Promise<supervisor.ProbeResult> {
  let baseEnv: Record<string, string> = {};
  if (request.id) {
    const existing = await getHostedServer(request.id);
    if (existing) baseEnv = existing.env;
  }
  const env = mergeEnvPatch(baseEnv, request.envUpdates, request.envDeletes);
  return supervisor.probeServer({
    command: request.command.trim(),
    args: request.args,
    cwd: request.cwd?.trim() || undefined,
    env,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every configured server, persisted fields joined with live runtime status.
 * MASKED for IPC: never `env` (a decrypted secret would otherwise cross the
 * boundary), only the resolved `command`/`args`/`cwd` — the same "keys, not
 * values" posture `connectorsStore.listConnectors()` already established
 * for connector headers.
 */
export async function list(): Promise<McpHostListEntry[]> {
  const records = await listHostedServers();
  return records.map(maskRecord);
}

/**
 * Does this host manage `id` right now, running or not? Synchronous and
 * allocation-cheap on purpose — this sits on the **hot path** of every hosted
 * tool call (`agentSession.handleMcpRelay`), where `list()` must not be used:
 * that one goes through `listHostedServers()`, which is a synchronous disk
 * read plus a `safeStorage` decrypt of the sealed store, on the main thread,
 * and paying that per tool call would put a blocking decrypt inside a loop the
 * model controls.
 *
 * Answered from the SUPERVISOR's handle map, not the store, and the two differ
 * in a way that is correct here rather than merely convenient: this returns
 * false for a configured server that has never been started this run, because
 * `handles` only gains an entry at first start. That is exactly right for the
 * relay — a server that has never been ready was never in a `POST /hosted`
 * payload, so the CLI has no relay registered for it and the model cannot name
 * it in the first place. The case the relay genuinely has to catch is a server
 * that WAS ready and has since stopped or crashed, and that one keeps its
 * handle: `handles.delete()` runs only in `forgetServer`, i.e. on removal.
 */
export function isHosted(id: string): boolean {
  return supervisor.getStatus(id) !== undefined;
}

/**
 * Every id this host has a live handle for, running or not. Same
 * supervisor-backed, synchronous, disk-free source as `isHosted()` and with
 * the same caveat — a server never started this run is absent — which is
 * again correct for both current callers: a server that never started cannot
 * have had a tool called on it.
 */
export function hostedIds(): string[] {
  return supervisor.listStatuses().map((s) => s.id);
}

/** The tool inventory as of the server's last successful readiness. `undefined` if it has never been ready this session — "never read" is a real, distinct state from "read, and empty". */
export function inventory(id: string): HostedToolDescriptor[] | undefined {
  return supervisor.getTools(id);
}

/**
 * The live `POST /hosted` payload (design: `docs/design/mcp-hosting.md`,
 * Increment 4) — every server whose supervisor state is `ready` RIGHT NOW,
 * keyed by id. A server that is `starting`, `restarting`, `failed`,
 * `stopped` or `paused` is simply absent, exactly as `shared/hostedMcp.ts`'s
 * `HostedMcpPushPayload` doc comment specifies — there is no state field on
 * the wire for the agent server to misinterpret.
 *
 * Always a FRESH read of `listHostedServers()`/`supervisor.getStatus()`/
 * `supervisor.getTools()` — never a cached copy — because the whole reason
 * `containerService.onAgentServerRestarted` exists (Increment 4's mandatory
 * guard #2) is that a server which is `failed` at the exact moment of an
 * agent-server restart must not be re-registered with the fresh CLI relay
 * just because an earlier snapshot said `ready`.
 *
 * **Increment 7's write gate, Layer 1 — the optimisation, not the boundary.**
 * Each server's tool list is filtered through `isToolSelected` before it goes
 * on the wire: an unselected tool is never registered with the CLI, so it
 * does not exist as far as the model is concerned and its JSON Schema costs
 * no context (R7's budget mitigation, same control). This is NOT what makes
 * an unselected tool un-callable — a selection narrowed mid-session leaves
 * the CLI holding a relay registered from an earlier, wider push until the
 * next `POST /hosted`, so `main/agentSession.ts`'s `handleMcpRelay` re-checks
 * the SAME predicate again, at call time, as Layer 2 — see that module for
 * why filtering here alone would not be a real boundary. A server with every
 * tool deselected (`enabledTools: []`) still appears in this map with
 * `tools: []` if it is otherwise `ready` — presence here tracks liveness, not
 * "has anything to offer".
 */
export async function readyServersForAgent(): Promise<Record<string, HostedServerPush>> {
  const records = await listHostedServers();
  const push: Record<string, HostedServerPush> = {};
  for (const record of records) {
    const status = supervisor.getStatus(record.id);
    if (status?.state !== 'ready') continue;
    const tools = supervisor.getTools(record.id);
    // Readiness landed but the tool snapshot isn't there yet (or raced away
    // by a restart between these two reads) — skip rather than push a guess;
    // the next status change will trigger another read that gets it right.
    if (!tools) continue;
    const selected = tools.filter((t) => isToolSelected(record.enabledTools, t.name));
    push[record.id] = { label: record.label, tools: selected };
  }
  return push;
}

/**
 * Increment 7's write gate, Layer 2 — the actual boundary. Is `toolName`
 * currently selected on hosted server `id`? This is what
 * `main/agentSession.ts`'s `handleMcpRelay` calls BEFORE forwarding to
 * `invoke()`, so it must answer from the supervisor's LIVE in-memory record
 * (`supervisor.getEnabledTools`), never from `listHostedServers()` — the same
 * hazard `isHosted()`'s own comment documents one function up: unsealing the
 * store on every hosted tool call would put a blocking `safeStorage` decrypt
 * inside a loop the model controls — the exact hazard `agentSessionMcpRelay
 * .test.ts`'s pre-existing "does not unseal the store on the hot path of an
 * already-started server" test counts decrypts to pin, and which this
 * function's own tests extend to prove the write-gate check adds no new one.
 */
export function isToolEnabled(id: string, toolName: string): boolean {
  return isToolSelected(supervisor.getEnabledTools(id), toolName);
}

/**
 * Set which tools Claude may call on hosted server `id` (design:
 * `docs/design/mcp-hosting.md`, Increment 7's DECISION block — there is no
 * `allowWrites` boolean; per-tool selection IS the write gate). `undefined`
 * clears back to "every tool"; `[]` selects none — the two are written and
 * read distinctly all the way through, never collapsed (`isToolSelected`).
 *
 * A dedicated action rather than folded into `save()`'s `HostedServerDraft`:
 * that form is a full command/args/env/autostart replace, submitted as one
 * draft object built from form state — routing a single checkbox toggle
 * through it would force the caller to always carry the rest of that state
 * along just to flip one tool's selection, with a stale-form snapshot as the
 * failure mode (an open Advanced-form edit could silently stomp a selection
 * change made from the detail panel's checkboxes, or vice versa). Mirrors the
 * shape of the other small, dedicated per-server mutations already here
 * (`pause`/`stop`/`restart`) rather than the bigger form-shaped `save()`.
 *
 * Persists via `store.ts`'s `updateHostedServer` (the same "patch a named
 * subset of settings" path those mutations use), then refreshes the LIVE
 * in-memory record via `supervisor.updateEnabledTools` so Layer 1's next
 * `readyServersForAgent()` read reflects the change immediately — without
 * waiting for a restart, since a tool-selection edit is config-only and the
 * child process itself is untouched. That call also fires the supervisor's
 * own `notify()`, which is the SAME `onInventoryChanged` subscription
 * `AgentInfrastructureController`'s constructor already wires to
 * `scheduleHostedPush()` (and `main/index.ts` wires to the Servers page's
 * live broadcast) — reusing it here, rather than adding a second
 * notification path, is the point.
 */
export async function setEnabledTools(id: string, enabledTools: string[] | undefined): Promise<McpHostActionResult> {
  const record = await getHostedServer(id);
  if (!record) return { ok: false, error: `No hosted server named "${id}".` };
  const ok = await updateHostedServer(id, { enabledTools });
  if (!ok) return { ok: false, error: `"${id}" was removed by someone else already.` };
  supervisor.updateEnabledTools(id, enabledTools);
  return { ok: true };
}

/** The stderr ring buffer's current tail — for the detail panel's log view. Empty string for an id with no handle (never started) or nothing written yet, never `undefined`; there is no secret in a server's own diagnostic output that would need masking the way `env` does. */
export function stderrTail(id: string): string {
  return supervisor.getStderrTail(id);
}

/** Call one tool on one hosted server, through its bounded per-server queue. */
export async function invoke(id: string, toolName: string, args?: Record<string, unknown>): Promise<unknown> {
  return supervisor.invoke(id, toolName, args);
}

/**
 * Subscribe to every status change across every server. The callback
 * receives just the id — callers re-read `list()`/`inventory()` themselves,
 * which keeps this a single primitive rather than duplicating the shape of
 * `HostedStatus` a second time here.
 */
export function onInventoryChanged(cb: (id: string) => void): () => void {
  const offStatus = supervisor.onStatusChange((status) => cb(status.id));
  recordChangeListeners.add(cb);
  return () => { offStatus(); recordChangeListeners.delete(cb); };
}

/**
 * Record-level changes that produce NO supervisor status transition.
 *
 * `supervisor.onStatusChange` only fires for a server that has a live handle —
 * it is a *process* event. A record that is merely adopted or registered has
 * never been started, so it has no handle and emits nothing, and every
 * subscriber (the Servers page broadcast in `main/index.ts`, the hosted push in
 * `AgentInfrastructureController`) stayed silent.
 *
 * Measured 2026-09-01: the agent wrote `.mcp-servers/dna-toolkit/`, a scan
 * adopted it, `servers.json` gained the record — and the Servers page still
 * read "No servers yet" until the app was restarted. Adoption is exactly the
 * moment a user is told to go and look, so it is the worst possible moment to
 * be silent. Folded into `onInventoryChanged` rather than shipped as a second
 * subscription, for the same reason `setEnabledTools` reuses it: one
 * notification primitive, so a caller cannot subscribe to half the truth.
 */
const recordChangeListeners = new Set<(id: string) => void>();

function emitRecordChange(id: string): void {
  for (const cb of [...recordChangeListeners]) {
    try { cb(id); } catch (err) { log.warn(`[McpHost] record-change listener threw: ${(err as Error).message}`); }
  }
}

/** Stop every running server. For the app's own quit path (Increment 1's `will-quit`) — awaited there with the hard watchdog R14 describes; this function itself has no timeout of its own beyond `killTree`'s grace window. */
export async function shutdown(opts: { graceMs?: number } = {}): Promise<void> {
  await supervisor.shutdownAll(opts);
}

// ---------------------------------------------------------------------------
// Increment 5 — agent-authored servers (`authored.ts`). Thin wrappers only;
// see that module's header for the design (promote-on-enable, the "not an
// MCP tool" boundary, why adoption is idempotent and never resurrects a
// removed server).
// ---------------------------------------------------------------------------

/**
 * Re-scan `<workspace>/.mcp-servers/` for servers Claude has written since
 * the last scan. Already runs once per `startAll()` (i.e. once per boot); this
 * is also exposed so the Servers page can trigger it on demand — e.g. right
 * after a chat where the agent said it wrote one — without waiting for a
 * restart. Idempotent either way: `authored.ts`'s known-ids ledger makes a
 * repeat call over the same directory a no-op.
 */
// ---------------------------------------------------------------------------
// Increment 6 — install from npm / GitHub (`installer.ts`)
// ---------------------------------------------------------------------------

/**
 * Install a server and register it DISABLED, streaming progress lines to
 * every subscriber of `onInstallLog`.
 *
 * Fans the log out here rather than taking a callback through IPC, for the
 * same reason the Servers page does not poll: the renderer cannot be handed a
 * function, and an install is long enough that showing nothing until it ends
 * would be indistinguishable from a hang. Announces the new record through
 * `emitRecordChange` on success, because a freshly installed server has never
 * been started and so produces no supervisor status event — exactly the
 * silence that made an adopted server invisible until a restart.
 */
export async function installServer(req: installer.InstallRequest): Promise<installer.InstallResult> {
  const result = await installer.installHostedServer({
    ...req,
    onLog: (line) => {
      req.onLog?.(line);
      emitInstallLog(req.id, line);
    },
  });
  if (result.ok) emitRecordChange(result.id);
  return result;
}

const installLogListeners = new Set<(id: string, line: string) => void>();

/** Subscribe to installer output. Returns its own unsubscribe. */
export function onInstallLog(cb: (id: string, line: string) => void): () => void {
  installLogListeners.add(cb);
  return () => { installLogListeners.delete(cb); };
}

function emitInstallLog(id: string, line: string): void {
  for (const cb of [...installLogListeners]) {
    try { cb(id, line); } catch (err) { log.warn(`[McpHost] install-log listener threw: ${(err as Error).message}`); }
  }
}

export async function scanAuthoredServers(): Promise<authored.AuthoredScanResult> {
  const result = await authored.scanAndAdoptAuthoredServers();
  // Adoption creates a record with no process, so nothing else would announce
  // it — see `emitRecordChange`.
  for (const id of result.adopted) emitRecordChange(id);
  return result;
}

/**
 * Everything the "Authored by Claude" section needs beyond the generic
 * `list()` snapshot: each authored server's manifest description and its
 * file-drift count since the last (re-)promotion. Deliberately a separate
 * read from `list()` — see `authored.ts`'s `computeAuthoredDrift` for why
 * folding this into the live-broadcast `list()` path would re-hash a tree on
 * every status ping.
 */
export async function listAuthoredInfo(): Promise<authored.AuthoredListResult> {
  return authored.listAuthoredInfo();
}

/**
 * Promote `.mcp-servers/<id>/` into Acabox's own app-data area and run that
 * copy — the ONLY way an authored server's `enabled` flag ever becomes true
 * (see `authored.ts`'s module comment for why this is the security model, not
 * a formality). Used identically for the first approval and every later
 * re-promotion after a "N changes … Review" prompt.
 */
export async function approveAuthoredServer(id: string): Promise<authored.PromoteAuthoredServerResult> {
  return authored.promoteAndEnableAuthoredServer(id);
}
