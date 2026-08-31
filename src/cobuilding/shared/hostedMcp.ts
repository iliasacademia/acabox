/**
 * Hosted MCP servers — local stdio servers Acabox spawns and keeps running
 * for the life of the app, rather than one per chat turn (design:
 * `docs/design/mcp-hosting.md`, Increment 2 and the R5 annotation).
 *
 * Types + validation only. No I/O — `main/mcpHost/store.ts` owns persistence,
 * `main/mcpHost/hostedEnv.ts` owns the spawned child's environment.
 *
 * **Ids share ONE namespace with connectors** (`shared/connectors.ts`). Both
 * end up as the middle segment of an SDK tool name (`mcp__<id>__<tool>`) and
 * both are handed to `setMcpServers` together (Increment 4), so a hosted id
 * colliding with a connector id — or with one of Acabox's own relay names —
 * would silently shadow one of them. `validateHostedServer` therefore reuses
 * `CONNECTOR_ID_PATTERN` and `RESERVED_CONNECTOR_IDS` rather than defining a
 * second set that could drift from the first.
 */
import { CONNECTOR_ID_PATTERN, CONNECTOR_ID_RULE, RESERVED_CONNECTOR_IDS } from './connectors';

/**
 * How a hosted server's code was acquired. Drives what a detail panel shows
 * and, for `npm`/`github`, what a future update check re-resolves.
 */
export type HostedInstallSource =
  /** Freeform command typed behind Advanced (Increment 3's escape hatch). */
  | { kind: 'custom' }
  /** A `shared/mcpCatalog.ts` entry (Increment 3a). */
  | { kind: 'catalog'; catalogId: string }
  /** Installed from npm (Increment 6a). Version is pinned, never a range —
   *  "a pin recorded as a branch name is not a pin" applies here too. */
  | { kind: 'npm'; pkg: string; version: string; integrity?: string }
  /** Installed from a GitHub repo (Increment 6b), SHA-pinned. */
  | { kind: 'github'; repo: string; ref: string; subpath?: string }
  /** Written by Claude into the workspace and promoted by the user (Increment 5). */
  | { kind: 'authored' };

/**
 * What Acabox actually executes. Resolved once — at install/approval time —
 * and never re-derived from `install` at spawn, so a moved binary or an
 * uninstalled dependency fails loudly at spawn instead of silently
 * re-resolving to something else.
 */
export interface HostedMcpEntry {
  /** Absolute path, or a bare command name resolved via the spawn-time PATH. */
  command: string;
  args: string[];
  /** Working directory for the child. Defaults to the server's own userData dir when absent. */
  cwd?: string;
}

/** One tool as advertised by `tools/list` — the shape `POST /hosted` forwards to the agent server (Increment 4). */
export interface HostedToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * The `POST /hosted` wire payload (Increment 4) — the one contract between
 * `main/mcpHost` and the agent server.
 *
 * **Full replacement, never a delta.** The body always carries the complete
 * set of servers that are ready *right now*, exactly as `POST /connectors`
 * does. R6 asks for a push at the moment each server's readiness lands, and
 * that is the caller's cadence — but each of those pushes still sends the
 * whole live set. A delta protocol would need the two sides to agree on an
 * ordering across an HTTP hop that has no ordering guarantee, and the failure
 * would be a silently missing tool rather than an error.
 *
 * A server that is `starting`, `failed` or `stopped` is simply ABSENT from the
 * map. There is no state field here on purpose: the agent server has no use
 * for a server it cannot call, and giving it one invites a relay registered
 * against a dead child.
 */
export interface HostedMcpPushPayload {
  hosted: Record<string, HostedServerPush>;
}

export interface HostedServerPush {
  /** Display label; falls back to the id when absent. */
  label?: string;
  /** Live `tools/list` output — the inventory read from the running child. */
  tools: HostedToolDescriptor[];
}

/**
 * A hosted server's persisted configuration. Lives sealed in
 * `<userData>/mcp-servers/servers.json` (`main/mcpHost/store.ts`) — never in
 * `cobuilding-settings.json`, which half a dozen call sites read-modify-write
 * with no locking.
 */
export interface HostedMcpRecord {
  /** Shares a namespace with connector ids — see the module comment. */
  id: string;
  label: string;
  /**
   * Whether this server is handed to the agent at all — the same meaning as
   * `ConnectorConfig.enabled`. A freshly registered/imported/authored server
   * is always written `false` by `registerHostedServer`, which takes no field
   * a caller could use to override that — see its own comment for why.
   */
  enabled: boolean;
  /**
   * Whether `startAll()` spawns this server at boot. An enabled server with
   * `autostart: false` stays `paused` until the user starts it by hand — a
   * separate axis from `enabled`, which governs whether it may ever run at
   * all.
   */
  autostart: boolean;
  install: HostedInstallSource;
  entry: HostedMcpEntry;
  /**
   * This record's own env vars, layered on top of the allowlist last by
   * `buildHostedEnv`. Plaintext once `store.ts` has unsealed the record — the
   * whole record array is sealed as ONE ciphertext, so there is no second,
   * per-value encryption layer to apply or to strip here.
   */
  env: Record<string, string>;
  /**
   * Bounded FIFO concurrency for this server's call queue. Defaults to 1 —
   * not a regression from today's per-turn-subprocess model, where per-caller
   * concurrency is already 1 (see the design doc's Increment 2 note).
   */
  concurrency: number;
  /**
   * Per-record override of the supervisor's readiness deadline (`initialize`
   * + `tools/list` returning). Absent means the supervisor's own default
   * (20s). The supervisor clamps this to a hard ceiling (60s) rather than
   * trusting it verbatim — a slow-starting server is exactly the kind of
   * thing a user would crank up without limit if nothing stopped them, and an
   * unbounded readiness wait is indistinguishable from a hang.
   */
  readinessTimeoutMs?: number;
  /**
   * Per-file sha256 of the installed/authored tree, taken at the moment the
   * user approved it — `skillStore.ts`'s `baseline` idea, applied to a hosted
   * server's own files, so a later "N changes since you approved" can be
   * computed without re-reading every byte on every render.
   */
  fileHashes?: Record<string, string>;
  /**
   * The tool inventory read back at the moment the user approved this server —
   * NOT the live inventory. Diffing the two lets the UI flag that a server's
   * surface changed since approval, the same supply-chain question skills ask
   * with `baseline`/`upstreamBlobs`.
   */
  toolsAtApproval?: HostedToolDescriptor[];
  /**
   * Increment 7's write gate (`docs/design/mcp-hosting.md`, the
   * DECISION (2026-08-13) block superseding R15): which of this server's
   * tools Claude may call. **There is no `allowWrites` boolean** — a tool
   * cannot be honestly classified read-vs-write from an untrusted server
   * (name heuristics fail on `run_query`/`execute`/`fetch`, and a
   * self-declared `readOnly: true` is the attacker's own claim), so the only
   * classification anyone here is entitled to make is the user's own choice
   * of which tools to allow.
   *
   * `undefined` means **every tool** — the default for every existing record
   * (no migration needed) and for a freshly registered one, matching what a
   * user who added and started a server plainly intended. An **empty array**
   * means none, and is a real, distinct state from absent — collapsing the
   * two is exactly the bug the decision block calls out by name. Never
   * normalize one into the other; use `isToolSelected` below to read this
   * field rather than checking truthiness directly (`![].length` and
   * `!undefined` both read `true` in JS, which is precisely the trap).
   */
  enabledTools?: string[];
  /**
   * R5's orphan story: the pid this server was last spawned as, and its
   * start-time signature, persisted at spawn and cleared at a clean stop. A
   * record still carrying these at boot means the process may have survived a
   * crash/SIGKILL — see `main/mcpHost/store.ts`'s `reconcileOrphans`.
   */
  lastPid?: number;
  lastPidSignature?: string;
  createdAt: string;
}

/**
 * Runtime lifecycle state a supervisor reports for one server. NOT persisted —
 * recomputed fresh every time Acabox runs; there is nothing here for a boot
 * to inherit.
 */
export type HostedRunState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed'
  | 'paused';

/** Live snapshot of one hosted server, as surfaced to the UI and the agent-reach layer. */
export interface HostedStatus {
  id: string;
  state: HostedRunState;
  pid?: number;
  startedAt?: number;
  /** Set only when `state === 'failed'`. Plain-language, from `diagnose.ts`. */
  error?: string;
  toolCount?: number;
  restartCount?: number;
}

export interface HostedValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate one hosted server record in isolation, modelled on
 * `validateConnector`. `existingIds` is caller-supplied on purpose: Increment
 * 4 passes the union of connector ids and other hosted ids so the two
 * namespaces stay one, exactly as `validateConnector`'s own `existingIds`
 * parameter does for connectors.
 */
export function validateHostedServer(
  record: Partial<Pick<HostedMcpRecord, 'id' | 'entry' | 'concurrency'>>,
  existingIds: string[] = [],
): HostedValidationResult {
  const id = (record.id ?? '').trim();
  if (!id) return { ok: false, error: 'Name is required.' };
  if (!CONNECTOR_ID_PATTERN.test(id)) {
    return { ok: false, error: `Invalid name "${id}". ${CONNECTOR_ID_RULE}` };
  }
  if (RESERVED_CONNECTOR_IDS.includes(id)) {
    return { ok: false, error: `"${id}" is reserved by Acabox. Pick another name.` };
  }
  if (existingIds.includes(id)) {
    return { ok: false, error: `A server named "${id}" already exists.` };
  }

  const command = (record.entry?.command ?? '').trim();
  if (!command) return { ok: false, error: 'A command to run is required.' };

  if (record.concurrency !== undefined) {
    if (!Number.isInteger(record.concurrency) || record.concurrency < 1) {
      return { ok: false, error: 'Concurrency must be a positive whole number.' };
    }
  }

  return { ok: true };
}

/**
 * The ONE predicate both of Increment 7's enforcement layers call, so they
 * cannot drift into disagreeing about what "selected" means:
 *
 *  - Layer 1, the optimisation: `main/mcpHost/index.ts`'s
 *    `readyServersForAgent()` filters the `POST /hosted` push with this, so
 *    an unselected tool is never registered with the CLI and its JSON Schema
 *    costs no context.
 *  - Layer 2, the actual boundary: `main/agentSession.ts`'s `handleMcpRelay`
 *    re-checks with this BEFORE forwarding to `mcpHost.invoke()`. Layer 1
 *    alone cannot be the boundary — narrowing a selection mid-session leaves
 *    the CLI holding a relay registered from the earlier, wider push, so the
 *    host at call time is the only place that can refuse with certainty.
 *
 * `undefined` reads as "every tool" (see `HostedMcpRecord.enabledTools`'s own
 * doc comment for why); an empty array reads as none. Both must be checked
 * with this function, never with a truthiness shortcut — `!enabledTools` and
 * `!enabledTools.length` both evaluate to `true` in JS, which is exactly how
 * "absent" and "empty" get silently collapsed into each other.
 */
export function isToolSelected(enabledTools: string[] | undefined, toolName: string): boolean {
  if (enabledTools === undefined) return true;
  return enabledTools.includes(toolName);
}
