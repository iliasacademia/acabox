/**
 * Persistence for user-configured MCP connectors.
 *
 * Stored as a `connectors` array in `cobuilding-settings.json` under userData
 * — deliberately outside the workspace, so the agent (which has Write + Bash
 * on the workspace) cannot provision itself a connector. See the header of
 * `shared/connectors.ts` for the reasoning.
 *
 * Secrets (bearer tokens in `headers`) are stored in plain text, matching how
 * `customAnthropicApiKey` is already stored in the same file. The UI says so
 * rather than implying protection that isn't there.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import {
  type ConnectorConfig,
  type ConnectorStatusReport,
  validateConnector,
} from '../shared/connectors';
import {
  decryptRecord,
  encryptRecord,
  encryptSecret,
  isEncrypted,
  isEncryptionAvailable,
  maskRecord,
} from './secretStore';

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(data: Record<string, unknown>): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Coerce a persisted entry into a well-formed ConnectorConfig. Rows written by
 * an older or hand-edited build shouldn't crash the read path, so anything
 * unusable returns null and is dropped from the list.
 */
function normalize(raw: unknown): ConnectorConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  const transport = r.transport === 'sse' || r.transport === 'stdio' ? r.transport : 'http';
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label : id,
    transport,
    url: typeof r.url === 'string' ? r.url : undefined,
    command: typeof r.command === 'string' ? r.command : undefined,
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : undefined,
    headers: isStringRecord(r.headers) ? r.headers : undefined,
    env: isStringRecord(r.env) ? r.env : undefined,
    // Absent means enabled: a connector the user added is on unless turned off.
    enabled: r.enabled !== false,
    catalogId: typeof r.catalogId === 'string' ? r.catalogId : undefined,
    alwaysLoad: r.alwaysLoad === true ? true : undefined,
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

/**
 * Connectors exactly as stored — auth values still encrypted. Internal; every
 * caller should pick one of the two accessors below instead.
 */
function readStoredConnectors(): ConnectorConfig[] {
  const raw = readSettings().connectors;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ConnectorConfig[] = [];
  for (const entry of raw) {
    const c = normalize(entry);
    // A duplicate id would silently shadow the earlier one inside the SDK's
    // server record; drop it here so the UI and the agent agree on the list.
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/**
 * Connectors for the UI, with every header/env VALUE blanked (keys kept).
 *
 * Secrets never cross the IPC boundary: Settings needs to know that an
 * `Authorization` header exists, not what it contains. A blank value coming
 * back on save means "keep the stored one" — see `upsertConnector`.
 */
export function listConnectors(): ConnectorConfig[] {
  return readStoredConnectors().map((c) => ({
    ...c,
    headers: maskRecord(c.headers),
    env: maskRecord(c.env),
  }));
}

/**
 * Connectors with real secrets, decrypted. Main-process only — this is what
 * gets turned into the agent's `mcpServers` config. Never return this over
 * IPC.
 */
export function listConnectorsWithSecrets(): ConnectorConfig[] {
  return readStoredConnectors().map((c) => ({
    ...c,
    headers: decryptRecord(c.headers),
    env: decryptRecord(c.env),
  }));
}

function persist(connectors: ConnectorConfig[]): void {
  const data = readSettings();
  data.connectors = connectors;
  writeSettings(data);
}

export interface ConnectorMutationResult {
  success: boolean;
  error?: string;
  connectors: ConnectorConfig[];
}

/**
 * Create or update a connector. `originalId` identifies the row being edited
 * (an edit may rename it); omit it to add.
 */
/**
 * Carry forward secrets the user didn't retype.
 *
 * The UI receives header/env values blanked, so an unedited form posts back
 * empty strings. Treat "key present, value empty, key existed before" as
 * "unchanged" and reuse the stored ciphertext. Dropping a header row is how
 * you delete one.
 *
 * `incoming === undefined` and `incoming === {}` are DIFFERENT questions and
 * must answer differently (audited defect, `docs/design/mcp-hosting.md`
 * Increment 3): `undefined` means the caller didn't submit a headers field at
 * all — nothing to compare, so keep whatever is stored. `{}` means the caller
 * submitted a real, empty set — every row was deleted — and that must persist
 * AS `{}`, not silently coerce back to "keep stored" the way an unconditional
 * "empty result → undefined" used to. The two used to collapse to the same
 * `undefined` return, which is what made a fully-cleared header list
 * indistinguishable from an untouched one on the next read. This alone is
 * only half the fix — `draftToConnector` must also stop omitting the
 * `headers` key when its row editor is empty, or an intentional clear can
 * never reach here as `{}` in the first place.
 */
function preserveUntouchedSecrets(
  incoming: Record<string, string> | undefined,
  stored: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (incoming === undefined) return stored;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === '' && stored && key in stored) {
      out[key] = stored[key];        // already encrypted at rest
    } else if (value !== '') {
      out[key] = encryptSecret(value);
    }
    // key present, value empty, no stored value → nothing to keep; drop it.
  }
  return out; // a real, explicit {} is a valid "cleared" answer — never coerced to undefined
}

/**
 * `hostedIds` — ids of currently-registered hosted MCP servers
 * (`docs/design/mcp-hosting.md`, Increment 4) — is caller-supplied rather
 * than read in here. Ids share ONE namespace with hosted servers (both
 * become the middle segment of `mcp__<id>__<tool>`), so a connector saved
 * under an id a hosted server already owns would silently shadow one of the
 * two in the SDK's merged `mcpServers` record — but `mcpHost.list()` is
 * async (a store read), and threading that through here would make this
 * function async for every caller, all of which is unnecessary: the one real
 * caller (`main/index.ts`'s `connectors:save` IPC handler) already awaits
 * other things and can fetch the list once, the same way it already resolves
 * `originalId`'s uniqueness scope itself via `others`.
 */
export function upsertConnector(
  connector: ConnectorConfig,
  originalId?: string,
  hostedIds: readonly string[] = [],
): ConnectorMutationResult {
  const stored = readStoredConnectors();
  const others = stored.filter((c) => c.id !== originalId);
  const validation = validateConnector(connector, [...others.map((c) => c.id), ...hostedIds]);
  if (!validation.ok) {
    return { success: false, error: validation.error, connectors: listConnectors() };
  }

  const previous = originalId ? stored.find((c) => c.id === originalId) : undefined;
  const toStore: ConnectorConfig = {
    ...connector,
    headers: preserveUntouchedSecrets(connector.headers, previous?.headers),
    env: preserveUntouchedSecrets(connector.env, previous?.env),
  };

  let next: ConnectorConfig[];
  if (previous) {
    // Replace in place so editing doesn't reorder the user's list.
    next = stored.map((c) => (c.id === originalId ? toStore : c));
  } else {
    next = [...stored, toStore];
  }
  persist(next);
  log.info(`[Connectors] Saved "${connector.id}" (${connector.transport}, enabled=${connector.enabled})`);
  return { success: true, connectors: listConnectors() };
}

export function removeConnector(id: string): ConnectorMutationResult {
  persist(readStoredConnectors().filter((c) => c.id !== id));
  log.info(`[Connectors] Removed "${id}"`);
  return { success: true, connectors: listConnectors() };
}

export function setConnectorEnabled(id: string, enabled: boolean): ConnectorMutationResult {
  const stored = readStoredConnectors();
  if (!stored.some((c) => c.id === id)) {
    return { success: false, error: `No connector named "${id}".`, connectors: listConnectors() };
  }
  // Persist the STORED rows (secrets still encrypted) — writing back a masked
  // list here would blank every header on the next toggle.
  persist(stored.map((c) => (c.id === id ? { ...c, enabled } : c)));
  log.info(`[Connectors] "${id}" ${enabled ? 'enabled' : 'disabled'}`);
  return { success: true, connectors: listConnectors() };
}

/**
 * Encrypt connector secrets written by a build that stored them in the clear.
 * Runs once at boot, after app.ready. No-op when there is nothing to do.
 */
export function migratePlaintextConnectorSecrets(): void {
  if (!isEncryptionAvailable()) return;
  const stored = readStoredConnectors();
  const needsWork = stored.some((c) =>
    Object.values(c.headers ?? {}).some((v) => v && !isEncrypted(v))
    || Object.values(c.env ?? {}).some((v) => v && !isEncrypted(v)));
  if (!needsWork) return;

  persist(stored.map((c) => ({
    ...c,
    headers: encryptRecord(c.headers),
    env: encryptRecord(c.env),
  })));
  log.info('[SecretStore] Encrypted stored connector secrets at rest.');
}

// ---------------------------------------------------------------------------
// Live status
// ---------------------------------------------------------------------------

/**
 * Last MCP server status the agent actually reported, captured from the SDK's
 * `system`/`init` event and from explicit status queries. Real observed state,
 * never a guess — a connector with no entry renders as "unknown" rather than
 * as a fabricated "connected".
 */
let lastStatus: ConnectorStatusReport[] = [];
let lastStatusAt: number | null = null;

/**
 * Whether a chat session currently exists to have observed `lastStatus` at
 * all. This is the fix for the audited "cached green Connected on a server
 * that provably is not live" defect: `lastStatus`/`lastStatusAt` are
 * deliberately NOT cleared when a session ends (the facts are still true —
 * the server WAS connected, at that time), only demoted. `recordLiveStatus`
 * sets this true; `recordConnectorLiveness(false)` is the demotion.
 */
let live = false;

export interface ConnectorLiveStatus {
  reports: ConnectorStatusReport[];
  observedAt: number | null;
  live: boolean;
}

/**
 * Live listener set, mirroring the `Set<callback>` + `emit()` pattern already
 * used by `jobRegistry.ts` and `buildHealth.ts` — the Servers page (design:
 * `docs/design/mcp-hosting.md`, Increment 3) needs to push status the moment
 * it changes rather than have every surface poll `connectors:getStatus`.
 */
const statusListeners = new Set<(status: ConnectorLiveStatus) => void>();

function emitStatus(): void {
  const status = getConnectorStatus();
  for (const l of statusListeners) {
    try { l(status); } catch (err) { log.warn(`[Connectors] status listener threw: ${(err as Error).message}`); }
  }
}

/** Called on every SDK `system`/`init` event (`agentSession.ts`) — a session
 *  exists and just told us the truth, so this both records the facts AND
 *  marks the connector set live. */
export function recordConnectorStatus(reports: ConnectorStatusReport[]): void {
  lastStatus = reports;
  lastStatusAt = Date.now();
  live = true;
  emitStatus();
}

/**
 * Explicitly mark whether a session exists to observe connector status right
 * now. Called with `false` from `sessionRegistry.destroyEntry` once the last
 * registered session is gone, so the UI's dots go grey the moment there is
 * nobody left to have observed them — without polling. `lastStatus`/
 * `lastStatusAt` are left untouched: a demoted row still shows what was last
 * observed and when, just relabelled "Not checked" instead of a stale
 * "Connected".
 */
export function recordConnectorLiveness(nowLive: boolean): void {
  if (live === nowLive) return; // no-op transition — nothing for a subscriber to react to
  live = nowLive;
  emitStatus();
}

export function getConnectorStatus(): ConnectorLiveStatus {
  return { reports: lastStatus, observedAt: lastStatusAt, live };
}

/** Subscribe to every connector-status change (push, not poll). Returns an
 *  unsubscribe function, exactly like `jobRegistry.subscribe`. */
export function subscribeConnectorStatus(cb: (status: ConnectorLiveStatus) => void): () => void {
  statusListeners.add(cb);
  return () => { statusListeners.delete(cb); };
}

// ---------------------------------------------------------------------------
// Unmanaged .mcp.json
// ---------------------------------------------------------------------------

export interface UnmanagedMcpJson {
  path: string;
  serverNames: string[];
}

/**
 * Detect a `.mcp.json` at the workspace root.
 *
 * The agent config passes `settingSources: ['project']` — required to load
 * CLAUDE.md — which also makes the SDK read a project `.mcp.json`. Since the
 * workspace is the agent's cwd and it can write there, such a file is a
 * connector Acabox didn't sanction. Surface it in Settings so it is visible
 * and removable instead of invisible.
 *
 * Returns null when there is no file, or when it declares no servers.
 */
export function detectUnmanagedMcpJson(workspacePath: string): UnmanagedMcpJson | null {
  const filePath = path.join(workspacePath, '.mcp.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return null;
    const serverNames = Object.keys(servers);
    if (!serverNames.length) return null;
    return { path: filePath, serverNames };
  } catch {
    // Missing (the normal case) or unparseable — nothing to report either way.
    return null;
  }
}

/** Delete an unmanaged `.mcp.json`. Used by the "Remove" action in Settings. */
export function removeUnmanagedMcpJson(workspacePath: string): { success: boolean; error?: string } {
  const filePath = path.join(workspacePath, '.mcp.json');
  try {
    fs.unlinkSync(filePath);
    log.info(`[Connectors] Removed unmanaged ${filePath}`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Already gone is the outcome the caller wanted.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { success: true };
    return { success: false, error: message };
  }
}
