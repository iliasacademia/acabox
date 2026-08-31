import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import log from 'electron-log';
import { encryptSecret, decryptSecret, isEncryptionAvailable } from '../secretStore';
import { killTree, pidSignatureOf } from './processTree';
import {
  type HostedMcpRecord,
  type HostedInstallSource,
  type HostedMcpEntry,
  type HostedToolDescriptor,
  validateHostedServer,
} from '../../shared/hostedMcp';

/**
 * Sealed persistence for hosted MCP server configs
 * (`docs/design/mcp-hosting.md`, Increment 2 "Persistence" + the R5
 * annotation).
 *
 * File: `<userData>/mcp-servers/servers.json` — deliberately NOT
 * `cobuilding-settings.json`, which half a dozen call sites read-modify-write
 * with no locking. This file has exactly one owner: this module.
 *
 * Threat model: the workspace agent has auto-approved Bash and Write on the
 * workspace, which gives it shell-level read/write to anywhere on disk it can
 * reach, including userData — but NOT to Electron's `safeStorage`, which only
 * exists inside a running Electron main process, not from a shell. Sealing
 * the record array through `secretStore.encryptSecret` gets tamper-evidence
 * for free from that gap: an agent that hand-edits `servers.json` produces
 * bytes that fail to decrypt, and this module drops a record — or, when the
 * seal itself is what's broken, the whole store — rather than repairing or
 * partially trusting it. See `decodeRecords` below for exactly where that
 * line falls.
 *
 * Honesty about the Linux/no-keyring case: `isEncryptionAvailable()` can be
 * false, and `encryptSecret` then stores plaintext (`secretStore.ts:54`) —
 * the seal is decorative there, not a bug in this file. Re-exported so a
 * supervisor can refuse to autostart anything and say why, per the design.
 *
 * Why this hand-rolls its own read/write/lock instead of reusing
 * `manifestIO.ts` (which already does per-path serialized, atomic-rename JSON
 * IO, and which `jobRegistry.ts`'s own sibling module now shares code with):
 * `manifestIO#readManifest` deliberately collapses "file missing" and "file
 * unreadable/unparseable" into the same `null` — correct for a mini-app
 * manifest, where a missing file is the everyday case and there is nothing
 * useful to log about it either way. This module needs the opposite: missing
 * is silent and normal, but a file that EXISTS and fails to parse or decrypt
 * must log loudly, because that shape is what tampering looks like. Since
 * `updateManifest` performs its own internal read before ever handing this
 * module a value, there is no way to recover that distinction from inside its
 * callback — so the read (and the write-side locking) live here instead.
 */
export { isEncryptionAvailable };

const STORE_VERSION = 1;

function storePath(): string {
  return path.join(app.getPath('userData'), 'mcp-servers', 'servers.json');
}

/**
 * A hosted server's own directory — `<userData>/mcp-servers/<id>/` — used by
 * the supervisor as the default child-process `cwd` when a record's own
 * `entry.cwd` is absent (`HostedMcpEntry.cwd`'s own docstring already
 * promises this), and by future increments as the install target for npm/
 * GitHub-sourced servers. Exported from here rather than computed ad hoc
 * elsewhere, because this module is the one place that already owns the
 * `<userData>/mcp-servers/` namespace (see `storePath` above) — a second,
 * independently-written join of the same path components is how the two
 * eventually drift.
 */
export function hostedServerDir(id: string): string {
  return path.join(app.getPath('userData'), 'mcp-servers', id);
}

/**
 * Serializes every read-modify-write cycle against the store, the same
 * problem `manifestIO.ts`'s per-path queue solves for tool manifests: two
 * concurrent `registerHostedServer` calls must not both read "no collision"
 * and both write. A rejected turn is caught so one failure can't wedge every
 * later call behind it.
 */
let queue: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => T): Promise<T> {
  const run = queue.catch(() => undefined).then(fn);
  queue = run.catch(() => undefined);
  return run;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}

/** Minimal shape check for a record that survived decrypt + JSON.parse. Not
 *  the full `validateHostedServer` — that also checks id uniqueness against
 *  ITS OWN array, which is meaningless once the record is already in it. This
 *  is just "does this still look like a HostedMcpRecord", to catch a record
 *  left behind by a bug or by hand-editing that got past the seal itself.
 *
 *  `enabledTools` is checked when PRESENT (must be a string array — a
 *  tampered/malformed value here would otherwise reach `Array.prototype
 *  .includes` inside `isToolSelected` and throw on the write-gate's hot
 *  path); its ABSENCE is not an error, since `undefined` is this field's own
 *  valid "every tool" state (`shared/hostedMcp.ts`'s own doc comment). */
function isPlausibleRecord(value: unknown): value is HostedMcpRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.enabled === 'boolean' &&
    typeof r.entry === 'object' && r.entry !== null &&
    typeof (r.entry as Record<string, unknown>).command === 'string' &&
    (r.enabledTools === undefined || isStringArray(r.enabledTools))
  );
}

/**
 * Decode the records sealed inside one read of the manifest file.
 *
 * The whole array is sealed as ONE ciphertext (see the module comment), so
 * decryption is all-or-nothing: a tampered or corrupted `sealed` value cannot
 * be partially recovered, and this function does not try to — a decrypt or
 * parse failure drops EVERY record and logs loudly, rather than guessing
 * which bytes might still be trustworthy. That is a coarser grain than "a
 * record that fails to decrypt is dropped" reads in isolation, and it is
 * coarser on purpose: there is no way to decrypt one array element without
 * decrypting the whole envelope.
 *
 * A record that individually fails the shape check AFTER a successful
 * decrypt+parse (e.g. written by a future version with fields this one
 * doesn't understand, or by a bug) IS dropped one at a time — at that point
 * the seal itself was never in question, so there is no reason to distrust
 * its neighbours too.
 *
 * `manifest` is `{}` when the file is missing entirely (the normal, silent
 * "nothing registered yet" state — `readStoreFileSync` below is what makes
 * that distinct from a file that exists but doesn't parse) or when it exists
 * and is literally `{}` (harmless; not a shape tampering could produce
 * usefully, so not worth a log line either).
 */
function decodeRecords(manifest: Record<string, unknown>): HostedMcpRecord[] {
  if (Object.keys(manifest).length === 0) return [];

  const sealed = manifest.sealed;
  if (typeof sealed !== 'string') {
    log.error('[McpHostStore] servers.json has no "sealed" field — treating the store as empty rather than guessing at its shape.');
    return [];
  }

  const json = decryptSecret(sealed);
  if (!json) {
    // decryptSecret already logged the underlying cause.
    log.error('[McpHostStore] Could not decrypt servers.json. Every hosted server record is being treated as gone, not partially trusted — if this was not deliberate, the file was corrupted or tampered with.');
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    log.error(`[McpHostStore] Decrypted servers.json did not parse as JSON: ${(err as Error).message}. Treating the store as empty.`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.error('[McpHostStore] Decrypted servers.json was not an array. Treating the store as empty.');
    return [];
  }

  return parsed.filter((entry) => {
    const ok = isPlausibleRecord(entry);
    if (!ok) {
      log.error(`[McpHostStore] Dropping a record that does not look like a hosted server config: ${JSON.stringify(entry).slice(0, 200)}`);
    }
    return ok;
  });
}

function encodeRecords(records: HostedMcpRecord[]): Record<string, unknown> {
  return { v: STORE_VERSION, sealed: encryptSecret(JSON.stringify(records)) };
}

/**
 * Read the raw store file. Missing is silent and normal (`{}`, matching what
 * a brand-new install looks like); a file that EXISTS but is not valid JSON
 * is loudly logged and ALSO treated as `{}` — the two look identical to
 * `decodeRecords`, which is exactly the point: either way there is nothing
 * safe to load, but only the second case is worth telling anyone about.
 */
function readStoreFileSync(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath(), 'utf-8');
  } catch {
    return {}; // missing — a fresh install, or nothing registered yet
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    log.error('[McpHostStore] servers.json did not contain a JSON object. Treating the store as empty.');
    return {};
  } catch (err) {
    log.error(`[McpHostStore] servers.json exists but is not valid JSON: ${(err as Error).message}. Treating the store as empty rather than guessing at its shape.`);
    return {};
  }
}

/** Atomic write: temp file + rename, so a reader never observes a half-written file. */
function writeStoreFileSync(records: HostedMcpRecord[]): void {
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(encodeRecords(records), null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, target);
}

/**
 * Read every record. Empty on a missing, unreadable, or corrupt store — see
 * `readStoreFileSync` / `decodeRecords`. A plain read does not need the write
 * lock: `writeStoreFileSync`'s rename is atomic, so a read racing a write
 * always sees either the fully-old or fully-new file, never a torn one.
 */
export async function listHostedServers(): Promise<HostedMcpRecord[]> {
  return decodeRecords(readStoreFileSync());
}

export async function getHostedServer(id: string): Promise<HostedMcpRecord | undefined> {
  const all = await listHostedServers();
  return all.find((r) => r.id === id);
}

/**
 * One read-modify-write cycle against the sealed store, serialized via
 * `withStoreLock` and written atomically. `mutate` runs synchronously against
 * the already-decoded, already-decrypted array — the same shape
 * `skillStore.ts`'s `updateSkillsState` uses, and for the same reason:
 * validation has to happen INSIDE the exclusive window, or two concurrent
 * calls with the same id can both see "no collision" and both write.
 */
async function mutateRecords<T>(
  mutate: (records: HostedMcpRecord[]) => { records: HostedMcpRecord[]; result: T },
): Promise<T> {
  return withStoreLock(() => {
    const current = decodeRecords(readStoreFileSync());
    const { records, result } = mutate(current);
    writeStoreFileSync(records);
    return result;
  });
}

/**
 * What a caller supplies to register a new hosted server. Deliberately has NO
 * `enabled` field — see `registerHostedServer` below, which mirrors
 * `skillStore.ts`'s `ImportRegistration` (~:1126) for the identical reason.
 */
export interface HostedServerRegistration {
  id: string;
  label: string;
  autostart?: boolean;
  install: HostedInstallSource;
  entry: HostedMcpEntry;
  env?: Record<string, string>;
  concurrency?: number;
  readinessTimeoutMs?: number;
  fileHashes?: Record<string, string>;
  toolsAtApproval?: HostedToolDescriptor[];
  /**
   * Increment 7's write gate. Absent (the common case — nothing here sets it
   * today) lands the record with `enabledTools` absent too, i.e. "every
   * tool" (`shared/hostedMcp.ts`'s own doc comment) — there is no migration
   * concern here since a brand-new record has no prior state to preserve.
   * Accepted at registration for a future caller that wants to install a
   * server pre-narrowed (e.g. a catalog entry with a curated subset) without
   * a second write immediately after.
   */
  enabledTools?: string[];
}

export type RegisterHostedServerResult =
  | { ok: true; record: HostedMcpRecord }
  | { ok: false; error: string };

/**
 * Register a new hosted server. Always lands `enabled: false` — not a
 * caller's decision, and there is no field on `HostedServerRegistration` a
 * caller could set to change that. Copied verbatim from
 * `skillStore.ts#registerImportedSkill` (~:1243) and for the identical
 * reasoning stated there: whether the agent gains a new capability is not a
 * decision this function gets to make on the user's behalf, so a freshly
 * registered/imported/authored server always arrives off and the user turns
 * it on.
 */
export async function registerHostedServer(
  reg: HostedServerRegistration,
): Promise<RegisterHostedServerResult> {
  return mutateRecords<RegisterHostedServerResult>((existing) => {
    const check = validateHostedServer(
      { id: reg.id, entry: reg.entry, concurrency: reg.concurrency },
      existing.map((r) => r.id),
    );
    if (!check.ok) {
      return { records: existing, result: { ok: false, error: check.error! } };
    }

    const record: HostedMcpRecord = {
      id: reg.id,
      label: reg.label,
      enabled: false, // not negotiable — see the function comment
      autostart: reg.autostart ?? false,
      install: reg.install,
      entry: reg.entry,
      env: reg.env ?? {},
      concurrency: reg.concurrency ?? 1,
      readinessTimeoutMs: reg.readinessTimeoutMs,
      fileHashes: reg.fileHashes,
      toolsAtApproval: reg.toolsAtApproval,
      enabledTools: reg.enabledTools,
      createdAt: new Date().toISOString(),
    };
    return { records: [...existing, record], result: { ok: true, record } };
  });
}

/**
 * Patch a subset of a hosted server's own settings — `enabled`/`autostart`
 * (the façade's `pause`/`start`/`stop` operate on these), the two runtime
 * tuning knobs a user could plausibly change from a future detail panel
 * (`concurrency`, `readinessTimeoutMs`), and `enabledTools` (Increment 7's
 * write gate — `main/mcpHost/index.ts`'s `setEnabledTools()` façade). Deliberately
 * NOT a generic "patch with anything" function: `id`, `entry`, `install`,
 * `env`, `fileHashes` and `toolsAtApproval` all have their own reasons to be
 * written only by `registerHostedServer` or a future re-approval flow, and a
 * generic patch would make it too easy to bypass those.
 *
 * `enabledTools: undefined` in the patch object IS a meaningful write, not a
 * no-op — it means "clear back to every tool". `{ ...r, ...patch }` spreads
 * an explicit `undefined` value over whatever `r.enabledTools` held, which is
 * exactly what a caller that only ever passes `{ enabled: false }` etc. never
 * triggers (that patch object simply has no `enabledTools` key at all, so the
 * spread leaves `r.enabledTools` alone) — the two are different at the
 * object-literal level, not just in what they mean.
 *
 * Returns `false` (no-op, no write) when the id does not exist, rather than
 * throwing — mirrors `getHostedServer`'s "absent is a normal answer" stance.
 */
export async function updateHostedServer(
  id: string,
  patch: Partial<Pick<HostedMcpRecord, 'enabled' | 'autostart' | 'concurrency' | 'readinessTimeoutMs' | 'enabledTools'>>,
): Promise<boolean> {
  return mutateRecords<boolean>((existing) => {
    if (!existing.some((r) => r.id === id)) return { records: existing, result: false };
    return {
      records: existing.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      result: true,
    };
  });
}

/**
 * Full config replace for an EXISTING record — the Servers page's edit path
 * (design: `docs/design/mcp-hosting.md`, Increment 3). Deliberately separate
 * from `updateHostedServer`, whose own comment reserves `entry`/`env` for
 * this function rather than the generic patch: `id`, `install`, `createdAt`
 * and the R5 pid bookkeeping are left untouched, everything a user can
 * actually edit through the Advanced form is replaced wholesale. Callers are
 * responsible for validation (id/command shape) and for merging `env` before
 * calling this — the façade's `save()` does both, the same division `store.ts`
 * already draws between "validate + decide" (its callers) and "read-modify-
 * write" (this file).
 *
 * Returns `false` when the id does not exist, matching `updateHostedServer`'s
 * own "absent is a normal answer" stance.
 *
 * `enabledTools` is deliberately NOT a field of `patch` below, and that is
 * not an oversight: `{ ...existing[idx], ...patch }` spreads the FULL prior
 * record first, so whatever `enabledTools` selection the user made earlier
 * (via `setEnabledTools`, the per-tool checkboxes) survives an Advanced-form
 * edit of the command/args/env untouched. Increment 7's selection is written
 * ONLY through `updateHostedServer`'s dedicated patch — folding it into this
 * function's `envUpdates`/`envDeletes`-style diff would conflate two
 * independent editing surfaces (the tool-selection checkboxes vs. the
 * command/env form) that should be free to change without touching each
 * other.
 */
export async function replaceHostedServerConfig(
  id: string,
  patch: {
    label: string;
    entry: HostedMcpEntry;
    env: Record<string, string>;
    autostart: boolean;
    concurrency?: number;
  },
): Promise<boolean> {
  return mutateRecords<boolean>((existing) => {
    const idx = existing.findIndex((r) => r.id === id);
    if (idx === -1) return { records: existing, result: false };
    const updated: HostedMcpRecord = {
      ...existing[idx],
      label: patch.label,
      entry: patch.entry,
      env: patch.env,
      autostart: patch.autostart,
      concurrency: patch.concurrency ?? existing[idx].concurrency,
    };
    const records = existing.slice();
    records[idx] = updated;
    return { records, result: true };
  });
}

/**
 * Remove a hosted server's config permanently. The caller (the façade in
 * `index.ts`) is responsible for stopping the live process FIRST — this
 * function only ever touches the store, never a running child, the same
 * division of labour `recordSpawn`/`clearSpawn` already draw.
 *
 * Returns `false` when the id was already absent, so a caller can tell
 * "removed" apart from "there was nothing to remove" without a separate
 * existence check racing this call.
 */
export async function removeHostedServer(id: string): Promise<boolean> {
  return mutateRecords<boolean>((existing) => {
    if (!existing.some((r) => r.id === id)) return { records: existing, result: false };
    return { records: existing.filter((r) => r.id !== id), result: true };
  });
}

/**
 * Called by the supervisor right after a successful spawn (R5): persists the
 * pid and its start-time signature so a LATER boot — after a crash or
 * SIGKILL, which skips every clean-shutdown path — can tell a survivor of
 * THIS spawn apart from an unrelated process that later reused the same pid.
 */
export async function recordSpawn(id: string, pid: number, signature: string): Promise<void> {
  await mutateRecords((existing) => ({
    records: existing.map((r) => (r.id === id ? { ...r, lastPid: pid, lastPidSignature: signature } : r)),
    result: undefined,
  }));
}

/** Called by the supervisor on a clean stop, so a later boot does not go looking for a process that was deliberately shut down. */
export async function clearSpawn(id: string): Promise<void> {
  await mutateRecords((existing) => ({
    records: existing.map((r) => (r.id === id ? { ...r, lastPid: undefined, lastPidSignature: undefined } : r)),
    result: undefined,
  }));
}

/** Matches jobRegistry's existing SIGTERM→SIGKILL window (R14 cites the same figure: ~3s graceful). Orphan reaping is not latency-sensitive — nobody is waiting on a spinner for it — so there is no reason to run it any tighter than the window Acabox already uses elsewhere for the same decision. */
const ORPHAN_KILL_GRACE_MS = 3000;

export interface ReconcileOrphansResult {
  killed: number;
  spared: number;
}

/**
 * R5 — the orphan story. A clean stop clears `{lastPid, lastPidSignature}`
 * (`clearSpawn`); it is untouched by a SIGKILL, a main-process crash, or the
 * Debug hard reset's `app.relaunch()`. So a record still carrying a pid at
 * boot means one of two things: a genuine survivor of an unclean shutdown, or
 * — because pids are reused — an unrelated process that now happens to hold
 * that number. `pidSignatureOf` (the process's start time) tells the two
 * apart: a match means kill the tree before spawning a fresh copy; a mismatch
 * means leave it alone, because it was never ours to act on.
 *
 * This is a DIFFERENT guard from the one inside `killTree` itself.
 * `killTree`'s own check protects the few hundred milliseconds between its
 * SIGTERM and SIGKILL passes, within a single call. This one protects across
 * an entire app restart — a gap of anywhere from seconds to weeks — which is
 * why it needs the value persisted to disk rather than just held in memory.
 *
 * Either way, once a pid has been checked, its bookkeeping is cleared: a
 * killed process's pid is now free (nothing more to check), and a
 * mismatched one was already determined to be unrelated (checking it again
 * next boot would be a coin flip that can only be wrong, never useful).
 */
export async function reconcileOrphans(): Promise<ReconcileOrphansResult> {
  const snapshot = await listHostedServers();
  const stale = snapshot.filter((r) => r.lastPid != null && !!r.lastPidSignature);
  if (stale.length === 0) return { killed: 0, spared: 0 };

  let killed = 0;
  let spared = 0;
  // What each id's pid/signature were AT THE MOMENT we decided its fate, so
  // the clearing pass below can refuse to blow away a newer spawn that raced
  // in between this read and that write (e.g. `recordSpawn` for a fresh start
  // triggered by something other than boot reconciliation). Boot-time is the
  // only caller today, so this is belt-and-suspenders rather than a live bug.
  const processed = new Map<string, { pid: number; signature: string }>();

  for (const record of stale) {
    const pid = record.lastPid!;
    const signature = record.lastPidSignature!;
    const liveSignature = pidSignatureOf(pid);
    if (liveSignature && liveSignature === signature) {
      await killTree(pid, { graceMs: ORPHAN_KILL_GRACE_MS });
      log.warn(`[McpHostStore] Reaped an orphaned hosted server process left behind by an unclean shutdown (id="${record.id}", pid=${pid}).`);
      killed++;
    } else {
      spared++;
    }
    processed.set(record.id, { pid, signature });
  }

  await mutateRecords((existing) => ({
    records: existing.map((r) => {
      const p = processed.get(r.id);
      const stillSame = p && r.lastPid === p.pid && r.lastPidSignature === p.signature;
      return stillSame ? { ...r, lastPid: undefined, lastPidSignature: undefined } : r;
    }),
    result: undefined,
  }));

  return { killed, spared };
}
