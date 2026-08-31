import { useSyncExternalStore } from 'react';
import {
  builtinServerRow,
  builtinServers,
  connectorStatusToServerState,
  hostedRunStateToServerState,
  type ServerRowModel,
} from '../shared/mcpServers';
import type { HostedInstallSource, HostedRunState } from '../shared/hostedMcp';
import type { ConnectorStatus, ConnectorStatusReport } from '../shared/connectors';

/**
 * Live MCP-server rows, merged from three independently-pushed feeds (design:
 * `docs/design/mcp-hosting.md`, Increment 3 — "Live status — pattern A,
 * mandatory"). Modelled line-for-line on `renderer/toolStatusStore.ts`: a
 * plain module store behind `useSyncExternalStore`, written by `applyX`
 * functions a caller feeds from `window.*API.list()` + `onChanged()`, with a
 * diffing `republish()` so a chatty producer (`connectors:statusChanged`
 * fires on every session `init`) doesn't repaint every subscriber on every
 * push.
 *
 * This module owns no subscription of its own — wiring `applyHostedServers`
 * etc. up to the real `window.mcpServersAPI` / `window.connectorsAPI` /
 * `window.miniAppMcpAPI` happens once, at the app shell, exactly where
 * `toolStatusStore`'s `applyHostJobs` is wired in `renderer/index.tsx`. That
 * wiring is a later pass; this module only has to be correct once fed.
 *
 * The one thing this store must never do is throw. `Rail` and `StatusBar`
 * will read it directly (`useServerRows`/`useServerCounts`), so a bad row
 * from a hand-edited file taking `computeSnapshot()` down would take the
 * whole shell down with it — the same reasoning that makes
 * `connectorsStore.normalize` drop a bad connector rather than crash the read
 * path. Every writer therefore normalizes its input defensively and drops
 * anything unusable; `computeSnapshot()` additionally guards each row build
 * so a bug in one kind's derivation can't blank the other three.
 */

// ---------------------------------------------------------------------------
// Input shapes — deliberately NOT imported from main-process modules, so this
// file (bundled into the renderer) has no dependency on Electron/main code.
// These mirror `main/mcpHost/index.ts`'s `McpHostListEntry`, the connector
// list/status IPC shapes, and `main/miniAppMcpRegistry.ts`'s `MiniAppMcpServer`.
// ---------------------------------------------------------------------------

export interface HostedServerInput {
  id: string;
  label: string;
  enabled: boolean;
  autostart: boolean;
  install: HostedInstallSource;
  command: string;
  args: string[];
  cwd?: string;
  envKeys: string[];
  state: HostedRunState;
  pid?: number;
  startedAt?: number;
  error?: string;
  toolCount?: number;
  restartCount?: number;
}

export interface ConnectorConfigInput {
  id: string;
  label: string;
  enabled: boolean;
  transport?: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
}

export interface ConnectorStatusInput {
  reports: ConnectorStatusReport[];
  observedAt: number | null;
  live: boolean;
}

export interface MiniAppServerInput {
  serverName: string;
  dirName: string;
  toolCount: number;
}

// ---------------------------------------------------------------------------
// Defensive normalization — mirrors connectorsStore.normalize's "drop what
// doesn't parse, never throw" posture, applied on the renderer side of the
// same IPC boundary.
// ---------------------------------------------------------------------------

const HOSTED_RUN_STATES = new Set<string>(['stopped', 'starting', 'ready', 'restarting', 'failed', 'paused']);
const CONNECTOR_STATUSES = new Set<string>(['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'unknown']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function normalizeHostedServer(raw: unknown): HostedServerInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  const state: HostedRunState = HOSTED_RUN_STATES.has(r.state as string) ? (r.state as HostedRunState) : 'stopped';
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label : id,
    enabled: r.enabled === true,
    autostart: r.autostart === true,
    install: (r.install as HostedInstallSource) ?? { kind: 'custom' },
    command: typeof r.command === 'string' ? r.command : '',
    args: isStringArray(r.args) ? r.args : [],
    cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
    envKeys: isStringArray(r.envKeys) ? r.envKeys : [],
    state,
    pid: typeof r.pid === 'number' ? r.pid : undefined,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
    toolCount: typeof r.toolCount === 'number' ? r.toolCount : undefined,
    restartCount: typeof r.restartCount === 'number' ? r.restartCount : undefined,
  };
}

function normalizeConnectorConfig(raw: unknown): ConnectorConfigInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label : id,
    enabled: r.enabled !== false,
    transport: r.transport === 'sse' || r.transport === 'stdio' ? r.transport : 'http',
    url: typeof r.url === 'string' ? r.url : undefined,
    command: typeof r.command === 'string' ? r.command : undefined,
    args: isStringArray(r.args) ? r.args : undefined,
  };
}

function normalizeConnectorStatusReport(raw: unknown): ConnectorStatusReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return null;
  const status: ConnectorStatus = CONNECTOR_STATUSES.has(r.status as string) ? (r.status as ConnectorStatus) : 'unknown';
  return {
    name,
    status,
    error: typeof r.error === 'string' ? r.error : undefined,
    toolCount: typeof r.toolCount === 'number' ? r.toolCount : undefined,
    scope: typeof r.scope === 'string' ? r.scope : undefined,
  };
}

function normalizeConnectorStatus(raw: unknown): ConnectorStatusInput {
  const r = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const reports = Array.isArray(r.reports)
    ? r.reports.map(normalizeConnectorStatusReport).filter((x): x is ConnectorStatusReport => x !== null)
    : [];
  return {
    reports,
    observedAt: typeof r.observedAt === 'number' ? r.observedAt : null,
    live: r.live === true,
  };
}

function normalizeMiniAppServer(raw: unknown): MiniAppServerInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const serverName = typeof r.serverName === 'string' ? r.serverName.trim() : '';
  const dirName = typeof r.dirName === 'string' ? r.dirName.trim() : '';
  if (!serverName || !dirName) return null;
  const toolCount = Array.isArray(r.tools) ? r.tools.length
    : (typeof r.toolCount === 'number' ? r.toolCount : 0);
  return { serverName, dirName, toolCount };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let hostedServers = new Map<string, HostedServerInput>();
let connectorConfigs = new Map<string, ConnectorConfigInput>();
let connectorStatus: ConnectorStatusInput = { reports: [], observedAt: null, live: false };
let miniAppServers = new Map<string, MiniAppServerInput>();

/** Full hosted-server snapshot, as `window.mcpServersAPI.list()` /
 *  `.onChanged()` deliver it. Replaces the whole set. */
export function applyHostedServers(list: readonly unknown[]): void {
  const next = new Map<string, HostedServerInput>();
  for (const raw of list) {
    const server = normalizeHostedServer(raw);
    if (server) next.set(server.id, server);
  }
  hostedServers = next;
  republish();
}

/** Configured connectors, as `window.connectorsAPI.list()` delivers them
 *  (the `.connectors` field). Replaces the whole set. */
export function applyConnectorConfigs(list: readonly unknown[]): void {
  const next = new Map<string, ConnectorConfigInput>();
  for (const raw of list) {
    const config = normalizeConnectorConfig(raw);
    if (config) next.set(config.id, config);
  }
  connectorConfigs = next;
  republish();
}

/** Observed connector status, as `window.connectorsAPI.getStatus()` /
 *  `.onStatusChanged()` deliver it. `live: false` demotes every cached
 *  `'connected'` report to `notChecked` — done inside `computeSnapshot()`,
 *  not here, so there is exactly one place that applies the rule. */
export function applyConnectorStatus(status: unknown): void {
  connectorStatus = normalizeConnectorStatus(status);
  republish();
}

/** Published mini-app servers, as `window.miniAppMcpAPI.list()` /
 *  `.onChanged()` deliver them. Replaces the whole set — a server dropping
 *  out of the list (iframe unloaded) removes its row with no ghost left
 *  behind, because it is simply absent from `next`. */
export function applyMiniAppServers(list: readonly unknown[]): void {
  const next = new Map<string, MiniAppServerInput>();
  for (const raw of list) {
    const server = normalizeMiniAppServer(raw);
    if (server) next.set(server.serverName, server);
  }
  miniAppServers = next;
  republish();
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function buildHostedRow(s: HostedServerInput): ServerRowModel {
  const state = hostedRunStateToServerState(s.enabled, s.state);
  return {
    id: s.id,
    kind: 'hosted',
    label: s.label,
    state,
    error: state === 'failed' ? s.error : undefined,
    meta: {
      kind: 'hosted',
      command: s.command,
      args: s.args,
      cwd: s.cwd,
      envKeys: s.envKeys,
      pid: s.pid,
      startedAt: s.startedAt,
      restartCount: s.restartCount,
      toolCount: s.toolCount,
      autostart: s.autostart,
      install: s.install,
    },
  };
}

function buildConnectorRow(
  c: ConnectorConfigInput,
  report: ConnectorStatusReport | undefined,
  status: ConnectorStatusInput,
): ServerRowModel {
  const state = connectorStatusToServerState({ enabled: c.enabled, live: status.live, status: report?.status });
  return {
    id: c.id,
    kind: 'remote',
    label: c.label,
    state,
    error: state === 'failed' ? report?.error : undefined,
    meta: {
      kind: 'remote',
      url: c.url,
      command: c.command,
      args: c.args,
      scope: report?.scope,
      toolCount: report?.toolCount,
      live: status.live,
      observedAt: status.observedAt,
    },
  };
}

function buildMiniAppRow(m: MiniAppServerInput): ServerRowModel {
  return {
    id: m.serverName,
    kind: 'miniapp',
    label: m.serverName,
    state: 'available',
    meta: { kind: 'miniapp', dirName: m.dirName, toolCount: m.toolCount },
  };
}

/**
 * Merge the four feeds into rows. Never throws: each row is built inside its
 * own try/catch so a bug touching one kind can't blank the other three, and
 * every writer above has already dropped malformed input before it gets
 * here — this is a second, cheap line of defence, not the only one.
 */
function computeSnapshot(): ServerRowModel[] {
  const rows: ServerRowModel[] = [];

  for (const s of hostedServers.values()) {
    try {
      rows.push(buildHostedRow(s));
    } catch (err) {
      console.error('[McpServerStore] Dropping malformed hosted row:', err);
    }
  }

  const statusByName = new Map(connectorStatus.reports.map((r) => [r.name, r] as const));
  for (const c of connectorConfigs.values()) {
    try {
      rows.push(buildConnectorRow(c, statusByName.get(c.id), connectorStatus));
    } catch (err) {
      console.error('[McpServerStore] Dropping malformed connector row:', err);
    }
  }

  for (const m of miniAppServers.values()) {
    try {
      rows.push(buildMiniAppRow(m));
    } catch (err) {
      console.error('[McpServerStore] Dropping malformed mini-app row:', err);
    }
  }

  for (const b of builtinServers()) {
    try {
      rows.push(builtinServerRow(b));
    } catch (err) {
      console.error('[McpServerStore] Dropping malformed built-in row:', err);
    }
  }

  return rows;
}

function sameMeta(a: ServerRowModel['meta'], b: ServerRowModel['meta']): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameRow(a: ServerRowModel, b: ServerRowModel): boolean {
  return a.id === b.id
    && a.kind === b.kind
    && a.label === b.label
    && a.state === b.state
    && a.error === b.error
    && sameMeta(a.meta, b.meta);
}

function sameSnapshot(a: ServerRowModel[], b: ServerRowModel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameRow(a[i], b[i])) return false;
  }
  return true;
}

let snapshot: ServerRowModel[] = [];
const listeners = new Set<() => void>();

/**
 * Recompute and publish, but only notify subscribers when something
 * observably changed. `connectors:statusChanged` fires on every session
 * `init` — without this diff, every one of those repaints the rail, the
 * status bar and the page for no reason (`toolStatusStore.ts:110-124`'s
 * `republish` is the precedent this copies).
 */
function republish(): void {
  const next = computeSnapshot();
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): ServerRowModel[] {
  return snapshot;
}

/** Stable identity between changes — this IS `useSyncExternalStore`'s snapshot. */
export function getServerSnapshot(): ServerRowModel[] {
  return snapshot;
}

export function useServerRows(): ServerRowModel[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export interface ServerCounts {
  total: number;
  /** Rows worth surfacing as trouble — failed or needing sign-in. Off and
   *  Stopped/Not checked are expected resting states, not "down". */
  down: number;
  /**
   * Rows mid-handshake right now (`initialize` + `tools/list` in flight for a
   * hosted server, or a connector's `pending` status). Unlike `down` this is
   * a NORMAL, expected transient — but R6 (`docs/design/mcp-hosting.md`,
   * Increment 4) calls it out as the one place a transient count IS worth
   * surfacing: while a server is starting, its tools genuinely do not exist
   * yet, and a user who asks for them in that window deserves the StatusBar
   * telling them why rather than a Claude that just says it can't.
   */
  starting: number;
}

function countByState(rows: readonly ServerRowModel[], states: ReadonlySet<ServerRowModel['state']>): number {
  let n = 0;
  for (const row of rows) {
    if (states.has(row.state)) n += 1;
  }
  return n;
}

const DOWN_STATES = new Set<ServerRowModel['state']>(['failed', 'needsSignIn']);
const STARTING_STATES = new Set<ServerRowModel['state']>(['starting']);

export function useServerCounts(): ServerCounts {
  const rows = useServerRows();
  return {
    total: rows.length,
    down: countByState(rows, DOWN_STATES),
    starting: countByState(rows, STARTING_STATES),
  };
}

/**
 * Test seam: drop all state. Does not touch `listeners` — matches
 * `toolStatusStore.__resetToolStatusStore`, which leaves the subscription
 * mechanism (owned by React's mount/unmount cycle) alone.
 *
 * Unlike that precedent, `snapshot` is recomputed immediately rather than set
 * to an empty array: the built-in relays are unconditionally present (they
 * don't depend on any of the four feeds), so "reset" means "back to the
 * nothing-configured baseline", not "back to zero rows".
 */
export function __resetMcpServerStore(): void {
  hostedServers = new Map();
  connectorConfigs = new Map();
  connectorStatus = { reports: [], observedAt: null, live: false };
  miniAppServers = new Map();
  snapshot = computeSnapshot();
}
