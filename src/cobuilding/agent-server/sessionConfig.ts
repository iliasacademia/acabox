export interface AgentConfig {
  port: number;
  claudeBinaryPath: string;
  mcpServers: Record<string, { type: 'http'; url: string }>;
  anthropicApiKey: string;
  anthropicBaseURL?: string;
  model: string;
  systemPrompt: unknown;
  allowedTools: string[];
  settingSources: string[];
  soulMd?: string;
  docxGuidance?: string;
}

export interface SessionOverrides {
  additionalAllowedTools?: string[];
  soulMd?: string;
  hostGuidance?: string;
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
    soulMd: overrides?.soulMd ?? config.soulMd,
    docxGuidance: overrides?.hostGuidance ?? config.docxGuidance,
  };
}
