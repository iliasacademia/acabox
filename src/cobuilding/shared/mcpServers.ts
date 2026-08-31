/**
 * MCP servers — the one vocabulary shared by main and renderer for the
 * Servers page (design: `docs/design/mcp-hosting.md`, Increment 3, "One
 * vocabulary, seven words"). Modelled on
 * `renderer/components/command-desk/toolStatusDisplay.ts`, which centralises
 * the tool vocabulary "so the home grid, the rail and the tool tab bar can't
 * drift apart the way RUNNING/SLEEPING did" — the same drift risk exists here
 * across three genuinely different lifecycles (a spawned local process, a
 * remote SDK connection, a mini-app's iframe registration), so there is
 * exactly one place that says what a state is called and what dot it gets.
 *
 * This module is types + pure derivation only. No I/O, no Electron, no React
 * — `main/mcpHost/`, `main/connectorsStore.ts` and `main/miniAppMcpRegistry.ts`
 * own the live data; `renderer/mcpServerStore.ts` owns merging it into rows.
 */

import { BASE_AGENT_ALLOWED_TOOLS } from './agentAllowedTools';
import type { ConnectorStatus } from './connectors';
import type { HostedInstallSource, HostedRunState } from './hostedMcp';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * Four genuinely different lifecycles rendered through one row shape:
 *  - `hosted`  — a local stdio process Acabox spawns and supervises.
 *  - `remote`  — a user-configured connector, spawned/owned by the per-turn
 *                CLI subprocess (Settings → Connectors).
 *  - `miniapp` — a tool's own published MCP server, live only while its
 *                iframe is registered.
 *  - `builtin` — one of Acabox's own relay servers, always present.
 */
export type ServerKind = 'hosted' | 'remote' | 'miniapp' | 'builtin';

// ---------------------------------------------------------------------------
// The seven words
// ---------------------------------------------------------------------------

export type ServerState =
  | 'available'
  | 'starting'
  | 'stopped'
  | 'notChecked'
  | 'off'
  | 'needsSignIn'
  | 'failed';

/**
 * Highest-precedence first. Used wherever two signals about the same row
 * disagree — e.g. a connector that is both disabled AND reports `needs-auth`
 * from a stale observation is `off`, not `needsSignIn`. Doubles as the
 * canonical list of every `ServerState` for exhaustiveness checks: its length
 * (7) is the whole union.
 */
export const SERVER_STATE_PRECEDENCE: readonly ServerState[] = [
  'off',
  'failed',
  'needsSignIn',
  'starting',
  'available',
  'stopped',
  'notChecked',
];

const SERVER_STATE_LABELS: Record<ServerState, string> = {
  available: 'Available',
  starting: 'Starting',
  stopped: 'Stopped',
  notChecked: 'Not checked',
  off: 'Off',
  needsSignIn: 'Needs sign-in',
  failed: 'Failed',
};

/**
 * The exact word shown on the status line. Total over `ServerState` by
 * construction (a `Record` literal missing a key fails `tsc`) — there is no
 * default branch, and deliberately no `'unknown'` entry: `describeStatus()`
 * in `shared/connectors.ts` returns "Unknown" for an unrecognised connector
 * status, and this module's whole point is that the Servers page never says
 * that. Where the old UI said "Unknown", the answer here is `notChecked` →
 * "Not checked".
 */
export function serverStateLabel(state: ServerState): string {
  return SERVER_STATE_LABELS[state];
}

/**
 * Five colors for seven words, by design: `stopped`/`notChecked`/`off` all
 * read as "nothing is happening, and that's expected" (idle grey);
 * `needsSignIn` gets the warn (non-pulsing) yellow that `--pending`'s pulsing
 * yellow was otherwise using alone. No new class is invented — these are the
 * existing `.connectorDot--*` tones from `ConnectorsSettings.css` (`:33-45`).
 *
 * The TONE is the single source; `serverStateDotClass()` derives the CSS
 * class name from it rather than the other way round, so a caller that needs
 * the bare tone word (`KnowledgeRow`'s `dot?: {tone}` prop, reused by the
 * Servers page — `docs/design/mcp-hosting.md`, Increment 3) has a real
 * function to call instead of string-splitting a class name.
 */
export type ServerStateDotTone = 'ok' | 'warn' | 'error' | 'idle' | 'pending';

const SERVER_STATE_DOT_TONES: Record<ServerState, ServerStateDotTone> = {
  available: 'ok',
  starting: 'pending',
  stopped: 'idle',
  notChecked: 'idle',
  off: 'idle',
  needsSignIn: 'warn',
  failed: 'error',
};

export function serverStateDotTone(state: ServerState): ServerStateDotTone {
  return SERVER_STATE_DOT_TONES[state];
}

export function serverStateDotClass(state: ServerState): string {
  return `connectorDot--${SERVER_STATE_DOT_TONES[state]}`;
}

// ---------------------------------------------------------------------------
// Kind-specific derivation — precedence applied once, here, per kind
// ---------------------------------------------------------------------------

/**
 * Map a hosted server's persisted `enabled` flag + live `HostedRunState` to
 * the shared vocabulary. `enabled === false` always wins (Off outranks
 * everything) regardless of what the supervisor last observed — an off
 * server that crashed while being turned off is still "Off", not "Failed".
 */
export function hostedRunStateToServerState(enabled: boolean, runState: HostedRunState): ServerState {
  if (!enabled) return 'off';
  switch (runState) {
    case 'failed': return 'failed';
    case 'starting':
    case 'restarting': return 'starting';
    case 'ready': return 'available';
    case 'stopped':
    case 'paused':
    default: return 'stopped';
  }
}

/**
 * Map a remote connector's config + observed status to the shared
 * vocabulary. `live` is the demotion switch: a cached `'connected'` report
 * from a session that no longer exists must read as `notChecked`, never as a
 * stale `available` — this is the fix for the audited "cached green Connected
 * on a server that provably is not live" defect. Applying it here, inside the
 * one function every connector row goes through, is what keeps it a single
 * decision rather than a check repeated (and eventually forgotten) at each
 * call site.
 */
export function connectorStatusToServerState(params: {
  enabled: boolean;
  live: boolean;
  status?: ConnectorStatus;
}): ServerState {
  if (!params.enabled) return 'off';
  switch (params.status) {
    case 'failed': return 'failed';
    case 'needs-auth': return 'needsSignIn';
    case 'pending': return 'starting';
    case 'connected': return params.live ? 'available' : 'notChecked';
    case 'disabled': return 'off';
    case 'unknown':
    default: return 'notChecked';
  }
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/**
 * The one rule that keeps the vocabulary honest: the status line carries
 * only the shared word (`state`, rendered via `serverStateLabel`/
 * `serverStateDotClass`) plus an optional plain-language `error` — never a
 * kind-specific fact. Everything else (pid, uptime, URL, publishing tool,
 * argv, install provenance) lives in `meta`, which is itself a discriminated
 * union keyed on `kind` so `READY · pid 41823` can never be typed next to
 * `Connected` — there is no field that could hold both.
 */
export interface HostedRowMeta {
  kind: 'hosted';
  command: string;
  args: string[];
  cwd?: string;
  /** Env var NAMES only — never values. */
  envKeys: string[];
  pid?: number;
  startedAt?: number;
  restartCount?: number;
  toolCount?: number;
  autostart: boolean;
  install: HostedInstallSource;
}

export interface RemoteRowMeta {
  kind: 'remote';
  url?: string;
  command?: string;
  args?: string[];
  /** 'dynamic' for a server Acabox supplied, 'project' for `.mcp.json`. */
  scope?: string;
  toolCount?: number;
  /** Whether a chat session currently exists to observe this connector. */
  live: boolean;
  observedAt: number | null;
}

export interface MiniAppRowMeta {
  kind: 'miniapp';
  /** The mini-app that published this server — "publishing tool". */
  dirName: string;
  toolCount: number;
}

export interface BuiltinRowMeta {
  kind: 'builtin';
  toolNames: string[];
}

export type ServerRowMeta = HostedRowMeta | RemoteRowMeta | MiniAppRowMeta | BuiltinRowMeta;

export interface ServerRowModel {
  id: string;
  kind: ServerKind;
  label: string;
  state: ServerState;
  /** Set only when `state === 'failed'`, plain-language, from `diagnose.ts`
   *  (hosted) or the SDK's own report (remote). Never present otherwise. */
  error?: string;
  meta: ServerRowMeta;
}

// ---------------------------------------------------------------------------
// Built-in relays — derived, never a second hardcoded list
// ---------------------------------------------------------------------------

export interface BuiltinServerInfo {
  id: string;
  toolNames: string[];
}

/**
 * `mcp__<server>__<tool>` split on the FIRST `__` after the `mcp__` prefix.
 * Safe because a server id can contain hyphens but never an underscore
 * (`CONNECTOR_ID_PATTERN` in `shared/connectors.ts` is `[a-zA-Z0-9][a-zA-Z0-9-]*`)
 * while every tool name here uses underscores between words — so the first
 * `__` boundary in the remainder is unambiguously the server/tool split, even
 * for `mini-apps` (hyphenated id, underscored tool: `open_mini_application`).
 */
const BUILTIN_TOOL_PATTERN = /^mcp__([a-zA-Z0-9-]+)__(.+)$/;

/**
 * Derive the built-in relay servers from `BASE_AGENT_ALLOWED_TOOLS`
 * (`shared/agentAllowedTools.ts:43-64`) rather than hardcoding a second list:
 * `filterMcpServers` drops any relay with no matching allowlist entry, so
 * that constant IS authoritative for which relays actually get attached.
 */
export function builtinServers(): BuiltinServerInfo[] {
  const byServer = new Map<string, string[]>();
  for (const entry of BASE_AGENT_ALLOWED_TOOLS) {
    const match = BUILTIN_TOOL_PATTERN.exec(entry);
    if (!match) continue;
    const [, server, tool] = match;
    let tools = byServer.get(server);
    if (!tools) {
      tools = [];
      byServer.set(server, tools);
    }
    tools.push(tool);
  }
  return [...byServer.entries()].map(([id, toolNames]) => ({ id, toolNames }));
}

/**
 * "mini-apps" -> "Mini Apps". Cosmetic only — no catalog entry backs these.
 *
 * `ACRONYMS` exists because plain title-casing renders the `apis` relay as
 * "Apis", which reads as a word rather than an initialism. Keyed on the whole
 * segment, so it cannot accidentally shout a substring of a longer name.
 */
const ACRONYMS: Record<string, string> = { apis: 'APIs', api: 'API', mcp: 'MCP' };

export function builtinServerLabel(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Convenience: a built-in relay's row, always `available` — it is attached
 *  unconditionally whenever the agent boots, so there is nothing to check. */
export function builtinServerRow(info: BuiltinServerInfo): ServerRowModel {
  return {
    id: info.id,
    kind: 'builtin',
    label: builtinServerLabel(info.id),
    state: 'available',
    meta: { kind: 'builtin', toolNames: info.toolNames },
  };
}
