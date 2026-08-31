import type { HostedServerPush } from '../shared/hostedMcp';

export interface AgentConfig {
  port: number;
  claudeBinaryPath?: string;
  /**
   * User-configured MCP connectors (Settings → Connectors), already in the
   * SDK's McpServerConfig shape — http/sse `{type,url,headers?}` or stdio
   * `{type:'stdio',command,args?,env?}`. Built by
   * `shared/connectors.ts#buildMcpServers` in the host and handed to `query()`
   * alongside Acabox's own relay servers. Replaceable at runtime via
   * `POST /connectors`.
   */
  mcpServers: Record<string, Record<string, unknown>>;
  /**
   * Local hosted MCP servers `main/mcpHost` keeps running for the life of the
   * app (design: `docs/design/mcp-hosting.md`, Increment 4). A DELIBERATELY
   * SEPARATE field from `mcpServers` above, never merged into it: `POST
   * /connectors` replaces `mcpServers` wholesale, so sharing the field would
   * mean each route silently wipes the other's half the next time it runs.
   *
   * This is the raw `tools/list` inventory per server id — NOT a built SDK
   * relay server. Each live session builds its own `createSdkMcpServer`
   * wrapper from this (see `buildHostedMcpServers` in `index.ts`), because the
   * tool handler closure has to capture that session's own `SessionState` (its
   * `pendingMcpCalls` map, its SSE clients) exactly the way the built-in relay
   * servers already do — the same reason `mcpConnectors` is *not* stored
   * pre-built either.
   *
   * Replaceable at runtime via `POST /hosted`, pushed per server the instant
   * its readiness lands (R6) rather than batched — see that route's comment.
   */
  hostedServers?: Record<string, HostedServerPush>;
  anthropicApiKey: string;
  anthropicBaseURL?: string;
  model: string;
  /** Reasoning-effort level (SDK `query()` option): low|medium|high|xhigh|max. */
  effort?: string;
  systemPrompt: unknown;
  allowedTools: string[];
  /**
   * Store ids of the skills allowed onto the roster, from
   * `shared/skills.ts#buildSkillRuntimeConfig`. Passed straight through as the
   * SDK's `Options.skills`.
   *
   * This is the roster BUDGET ALLOCATOR, not a sandbox: an omitted skill keeps
   * its bytes and its `<workspace>/.claude/skills/<id>` symlink and is still
   * reachable by `Read`, it just stops costing roster characters. Omit the
   * field entirely (rather than sending `[]`) to mean "no SDK configuration,
   * load everything the CLI discovers" — `[]` would be an empty allowlist,
   * which is a very different thing.
   *
   * Replaceable at runtime via `POST /skills`; takes effect on the next session.
   */
  skills?: string[];
  settingSources: string[];
  soulMd?: string;
  docxGuidance?: string;
  workspaceDirectoriesGuidance?: string;
  /**
   * How to reach configured APIs through the host's loopback proxy
   * (`shared/apis.ts#buildApiGuidance`). Session-scoped rather than part of the
   * boot config: the host recomputes it per session so an API added mid-run
   * reaches the next chat.
   */
  apiGuidance?: string;
}

export interface SessionOverrides {
  additionalAllowedTools?: string[];
  soulMd?: string;
  hostGuidance?: string;
  workspaceDirectoriesGuidance?: string;
  apiGuidance?: string;
  /** Per-session model chosen in the chat UI (else the config default). */
  model?: string;
  /** Per-session reasoning-effort level chosen in the chat UI. */
  effort?: string;
}

export function filterMcpServers(
  servers: Record<string, unknown>,
  allowedTools: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).filter(([serverName]) =>
      allowedTools.some((t) => t.startsWith(`mcp__${serverName}__`)),
    ),
  );
}

export function mergeSessionConfig(config: AgentConfig, overrides?: SessionOverrides): AgentConfig {
  const sessionAllowedTools = overrides?.additionalAllowedTools?.length
    ? [...config.allowedTools, ...overrides.additionalAllowedTools]
    : config.allowedTools;

  return {
    ...config,
    allowedTools: sessionAllowedTools,
    model: overrides?.model ?? config.model,
    effort: overrides?.effort ?? config.effort,
    soulMd: overrides?.soulMd ?? config.soulMd,
    docxGuidance: overrides?.hostGuidance ?? config.docxGuidance,
    workspaceDirectoriesGuidance: overrides?.workspaceDirectoriesGuidance ?? config.workspaceDirectoriesGuidance,
    apiGuidance: overrides?.apiGuidance ?? config.apiGuidance,
  };
}
