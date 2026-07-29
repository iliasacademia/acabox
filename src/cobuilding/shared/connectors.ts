/**
 * Connectors — user-configured MCP servers.
 *
 * One definition shared by the main process (persistence + config assembly),
 * the agent server (handing them to the Agent SDK), and the renderer (the
 * Settings UI), so the three can't drift.
 *
 * Why host-owned rather than a `.mcp.json` in the workspace:
 * the workspace root is the agent's cwd and it has Write + Bash there, so a
 * `.mcp.json` is agent-writable. An agent that can add an arbitrary remote MCP
 * server can exfiltrate the workspace, which closes the prompt-injection
 * trifecta on an app whose Bash is auto-approved. Connectors therefore live in
 * `cobuilding-settings.json` under userData, which the agent cannot reach.
 *
 * Note this does NOT disable `.mcp.json`: the agent config passes
 * `settingSources: ['project']`, which is required to load CLAUDE.md and also
 * loads a project `.mcp.json`. Dropping 'project' would cost the workspace
 * agent instructions, so instead `detectUnmanagedMcpJson` surfaces such a file
 * in the UI. Verified against the bundled SDK: with `settingSources:
 * ['project']` a project `.mcp.json` IS loaded, while `claude mcp add`'s
 * default (local) and `--scope user` writes are both ignored.
 */

/** Transports Acabox exposes. Mirrors the SDK's McpServerConfig union. */
export type ConnectorTransport = 'http' | 'sse' | 'stdio';

export interface ConnectorConfig {
  /**
   * Server name. Becomes the middle segment of every tool the server exposes
   * (`mcp__<id>__<tool>`), so it must survive that concatenation intact.
   */
  id: string;
  /** Human label for the UI. Falls back to `id` when blank. */
  label: string;
  transport: ConnectorTransport;
  /** http/sse only. */
  url?: string;
  /** stdio only. */
  command?: string;
  args?: string[];
  /** http/sse: request headers (bearer tokens etc.). stdio: use `env`. */
  headers?: Record<string, string>;
  /** stdio only: environment for the spawned process. */
  env?: Record<string, string>;
  /** Disabled connectors stay configured but are not handed to the agent. */
  enabled: boolean;
  /** Catalog entry this was created from, when it wasn't hand-rolled. */
  catalogId?: string;
  /**
   * Load every tool into the prompt instead of deferring them behind tool
   * search. Costs context on every turn; off by default.
   */
  alwaysLoad?: boolean;
}

/**
 * A known connector, offered as a one-click starting point. Adding a new
 * service to Acabox is an entry in CONNECTOR_CATALOG below and nothing else —
 * the UI, validation, and agent wiring are all generic.
 */
export interface CatalogEntry {
  catalogId: string;
  /** Default server id; the user can rename it if it collides. */
  id: string;
  label: string;
  /** One line, shown under the name in the picker. */
  description: string;
  transport: ConnectorTransport;
  url?: string;
  command?: string;
  args?: string[];
  /** How the service authenticates, so the UI can set expectations. */
  auth: 'oauth' | 'header' | 'none';
  /** Header the user must supply when `auth === 'header'`. */
  headerName?: string;
  /** Placeholder for that header's value. */
  headerPlaceholder?: string;
  /** Docs link, opened in the system browser. */
  docsUrl?: string;
  /** Extra caveat surfaced in the UI (plan requirements, host variants…). */
  note?: string;
}

/**
 * Known connectors. Purely data — extend this list to add a service.
 *
 * Only entries whose endpoint is publicly documented belong here; anything
 * else the user adds via "Custom". URLs are the vendor-documented MCP
 * endpoints and are not verified at build time — a wrong one surfaces as a
 * `failed` status in the UI rather than a silent no-op.
 */
export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    catalogId: 'hex',
    id: 'hex',
    label: 'Hex',
    description: 'Query Hex projects and run Threads agents against your data.',
    transport: 'http',
    url: 'https://app.hex.tech/mcp',
    auth: 'oauth',
    docsUrl: 'https://learn.hex.tech/docs/api-integrations/mcp-server',
    note: 'Single-tenant/EU/HIPAA orgs use a different host (eu.hex.tech, hc.hex.tech, your-company.hex.tech). Needs a Team or Enterprise plan and the Explorer role or higher.',
  },
  {
    catalogId: 'sentry',
    id: 'sentry',
    label: 'Sentry',
    description: 'Read issues, events, and stack traces from Sentry.',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  {
    catalogId: 'notion',
    id: 'notion',
    label: 'Notion',
    description: 'Search and read Notion pages and databases.',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  {
    catalogId: 'linear',
    id: 'linear',
    label: 'Linear',
    description: 'Read and file Linear issues and projects.',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    catalogId: 'github',
    id: 'github',
    label: 'GitHub',
    description: 'Repositories, issues, and pull requests.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'oauth',
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
];

/**
 * Valid server id. The SDK builds tool names as `mcp__<id>__<tool>`, so an id
 * containing `__` would make the tool name ambiguous to split, and one with
 * spaces or dots breaks the allow-list patterns.
 */
export const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export const CONNECTOR_ID_RULE =
  'Use letters, numbers, and hyphens only, starting with a letter or number.';

/** Reserved names: Acabox's own relay servers. A clash would shadow them. */
export const RESERVED_CONNECTOR_IDS = [
  'activity',
  'notification',
  'reaction',
  'mini-apps',
  'workspace',
];

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate one connector in isolation. `existingIds` are the ids of the OTHER
 * configured connectors, for the uniqueness check.
 */
export function validateConnector(
  connector: Partial<ConnectorConfig>,
  existingIds: string[] = [],
): ValidationResult {
  const id = (connector.id ?? '').trim();
  if (!id) return { ok: false, error: 'Name is required.' };
  if (!CONNECTOR_ID_PATTERN.test(id)) {
    return { ok: false, error: `Invalid name "${id}". ${CONNECTOR_ID_RULE}` };
  }
  if (RESERVED_CONNECTOR_IDS.includes(id)) {
    return { ok: false, error: `"${id}" is reserved by Acabox. Pick another name.` };
  }
  if (existingIds.includes(id)) {
    return { ok: false, error: `A connector named "${id}" already exists.` };
  }

  const transport = connector.transport;
  if (transport !== 'http' && transport !== 'sse' && transport !== 'stdio') {
    return { ok: false, error: 'Pick a transport.' };
  }

  if (transport === 'stdio') {
    if (!(connector.command ?? '').trim()) {
      return { ok: false, error: 'Command is required for a local (stdio) server.' };
    }
    return { ok: true };
  }

  const url = (connector.url ?? '').trim();
  if (!url) return { ok: false, error: 'URL is required.' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `"${url}" is not a valid URL.` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'URL must start with https:// or http://.' };
  }
  // Plain http leaks the token and the traffic. Allowed for loopback (local
  // dev servers), refused for anything remote.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      error: 'Remote servers must use https:// — http:// is only allowed for localhost.',
    };
  }
  return { ok: true };
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/** Drop blank keys/values so an empty UI row never reaches the SDK. */
function compactRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    const key = k.trim();
    if (key && v !== undefined && v !== null && `${v}`.length > 0) out[key] = `${v}`;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Convert one connector to the SDK's McpServerConfig shape. Typed loosely
 * (the SDK's union lives in the agent-server bundle) but shaped exactly.
 */
export function toMcpServerConfig(connector: ConnectorConfig): Record<string, unknown> {
  const alwaysLoad = connector.alwaysLoad ? { alwaysLoad: true } : {};
  if (connector.transport === 'stdio') {
    return {
      type: 'stdio',
      command: connector.command,
      ...(connector.args?.length ? { args: connector.args } : {}),
      ...(compactRecord(connector.env) ? { env: compactRecord(connector.env) } : {}),
      ...alwaysLoad,
    };
  }
  return {
    type: connector.transport,
    url: connector.url,
    ...(compactRecord(connector.headers) ? { headers: compactRecord(connector.headers) } : {}),
    ...alwaysLoad,
  };
}

/**
 * Build the `mcpServers` record for every ENABLED connector. Invalid entries
 * are skipped rather than thrown on: a bad row saved by an older build must
 * not take the whole agent down.
 */
export function buildMcpServers(connectors: ConnectorConfig[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of connectors) {
    if (!c.enabled) continue;
    if (!validateConnector(c, Object.keys(out)).ok) continue;
    out[c.id] = toMcpServerConfig(c);
  }
  return out;
}

/**
 * Auto-approve patterns for enabled connectors. `mcp__<id>` covers every tool
 * on that server.
 *
 * Note `allowedTools` is an auto-approve list, not a restriction — the SDK's
 * restriction option is `tools`, which this app never sets. Measured against
 * the bundled SDK, an MCP tool that is absent from this list still executes,
 * because nothing in Acabox supplies a `canUseTool` handler. These entries are
 * therefore correctness-and-future-proofing (they'd matter the moment a
 * permission handler is added), not the thing that makes connectors work.
 */
export function connectorAllowedTools(connectors: ConnectorConfig[]): string[] {
  return connectors.filter((c) => c.enabled).map((c) => `mcp__${c.id}`);
}

/**
 * Swap the connector half of an existing `allowedTools` list for a new one,
 * leaving every non-connector entry in place and in order.
 *
 * Connectors can be added, edited and removed while the agent server is
 * running, and `mcp__<id>` is what auto-approves a connector's tools. The two
 * have to move together — updating `mcpServers` while leaving `allowedTools`
 * frozen at its boot value meant a connector added later was never on the
 * list. (Survivable only because this app supplies no `canUseTool` handler, so
 * an unlisted MCP tool still runs; it becomes a hard failure the day one is
 * added.)
 *
 * Shared rather than duplicated because two places have to agree exactly: the
 * agent server updating its live `currentConfig`, and the host updating the
 * config it would replay if the agent server crashed and restarted. If those
 * two ever computed the list differently, a crash would silently change which
 * tools are auto-approved.
 *
 * `nextIds` is intended to be the KEYS of the SDK-shaped server record rather
 * than the raw connector list — `buildMcpServers` additionally drops rows that
 * fail validation, and approving a server that was never supplied is wrong.
 */
export function replaceConnectorAllowedTools(
  allowedTools: readonly string[],
  priorIds: readonly string[],
  nextIds: readonly string[],
): string[] {
  const prior = new Set(priorIds.map((id) => `mcp__${id}`));
  const next = nextIds.map((id) => `mcp__${id}`);
  const nextSet = new Set(next);
  return [
    // Keep survivors in their original position; only genuinely new ids are
    // appended. Order is cosmetic to the SDK but keeps diffs and logs stable.
    ...allowedTools.filter((t) => !prior.has(t) || nextSet.has(t)),
    ...next.filter((t) => !allowedTools.includes(t)),
  ];
}

/** Stable display name. */
export function connectorDisplayName(connector: ConnectorConfig): string {
  return connector.label?.trim() || connector.id;
}

/** What the user is pointed at: the endpoint or the command line. */
export function connectorTarget(connector: ConnectorConfig): string {
  if (connector.transport === 'stdio') {
    return [connector.command, ...(connector.args ?? [])].filter(Boolean).join(' ');
  }
  return connector.url ?? '';
}

/** Connection state reported by the SDK for a configured server. */
export type ConnectorStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled'
  | 'unknown';

export interface ConnectorStatusReport {
  name: string;
  status: ConnectorStatus;
  error?: string;
  toolCount?: number;
  /** Where the server came from — 'dynamic' for ours, 'project' for .mcp.json. */
  scope?: string;
}

/** Human-readable status, used by the UI and by log lines. */
export function describeStatus(status: ConnectorStatus): string {
  switch (status) {
    case 'connected': return 'Connected';
    case 'needs-auth': return 'Needs authentication';
    case 'failed': return 'Failed';
    case 'pending': return 'Connecting…';
    case 'disabled': return 'Disabled';
    default: return 'Unknown';
  }
}
