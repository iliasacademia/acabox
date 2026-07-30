/**
 * The one definition of what the agent may run without being asked.
 *
 * Two places have to agree on this array exactly: `AgentInfrastructureController.start()`,
 * which builds the config the agent server boots with, and `containerService`'s
 * stored restart config, which is what gets replayed if the agent server dies.
 * When those two disagreed over the connector entries, a crash silently changed
 * which tools were auto-approved and nothing anywhere surfaced it —
 * `replaceConnectorAllowedTools` exists because of that bug. This module is the
 * same lesson applied to the whole list rather than one slice of it.
 *
 * WHAT THIS LIST IS NOT. It is auto-approve, not a restriction. The SDK's
 * restriction option is `tools`, which this app never sets, so an unlisted tool
 * still runs — it just falls to the default permission path, and there is no
 * `canUseTool` handler anywhere in Acabox to answer it. Entries here make the
 * approval deliberate rather than accidental.
 *
 * WHY BARE `Skill` IS ABSENT. Since Acabox passes `Options.skills`, the SDK
 * unions `Skill(<id>)` into `--allowedTools` for each entry itself (verified in
 * the shipped `sdk.mjs`: `O$.map(u$ => \`Skill(${u$})\`)`, appended to the
 * caller's `allowedTools`). Leaving a bare `Skill` here would re-approve every
 * skill the allowlist just filtered out — silently, since the filter's whole
 * purpose is the roster budget rather than safety. The SDK's own doc comment
 * says it outright: "you do not need to add 'Skill' to allowedTools yourself
 * when using this option."
 */

/**
 * The findings-ledger write-back tool.
 *
 * Named as a constant because it is load-bearing twice over: it is what
 * `filterMcpServers` looks for before it will attach the `knowledge` relay
 * server at all, and it is what the boot assertion below checks.
 */
export const KNOWLEDGE_RECORD_FINDING_TOOL = 'mcp__knowledge__record_finding';

/**
 * Everything auto-approved regardless of the user's configuration.
 *
 * Order is cosmetic to the SDK but keeps logs and the crash-restart diff
 * stable, which is the only way a divergence is ever noticed by eye.
 */
export const BASE_AGENT_ALLOWED_TOOLS: readonly string[] = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent',
  // WebSearch finds pages; WebFetch reads them. Several skills
  // (database-lookup, reaction) instruct the agent to call WebFetch
  // directly, so it has to be auto-approved here.
  'WebSearch', 'WebFetch', 'TodoWrite',
  'EnterPlanMode', 'ExitPlanMode',
  'mcp__activity__query_activity',
  KNOWLEDGE_RECORD_FINDING_TOOL,
  // Settings → APIs. The proxy itself is reached over plain HTTP from Bash;
  // this tool is how the agent reads live detail about what is configured,
  // which the session guidance block deliberately keeps short.
  'mcp__apis__list_apis',
  'mcp__mini-apps__open_mini_application',
  'mcp__mini-apps__build_and_open_mini_application',
  'mcp__mini-apps__list_published_servers',
  'mcp__mini-apps__call_published_tool',
  'mcp__notification__show_notification',
  'mcp__reaction__create_reaction_thread',
  'mcp__workspace__get_scanned_files',
  'mcp__workspace__get_research_profile',
];

/**
 * Build the resolved `allowedTools` for a boot.
 *
 * `connectorTools` is `connectorAllowedTools(connectors)` — one `mcp__<id>`
 * entry per enabled connector. They go last so that
 * `replaceConnectorAllowedTools(build([]), [], ids)` produces a byte-identical
 * array; a jest case pins that equality, because it is the property that lets
 * the crash-restart path recompute the list without consulting this module.
 */
export function buildAgentAllowedTools(connectorTools: readonly string[] = []): string[] {
  const resolved = [...BASE_AGENT_ALLOWED_TOOLS, ...connectorTools];
  assertKnowledgeToolAllowed(resolved);
  return resolved;
}

/**
 * Boot assertion, in the style of the `IDLE_EVICTION_MS` vs OAuth-pin-window
 * check in the agent server.
 *
 * `filterMcpServers` (`agent-server/sessionConfig.ts`) DROPS any relay server
 * with no matching `mcp__<name>__*` entry in `allowedTools`. So dropping this
 * one line does not produce an error, a warning, or a failed tool call — the
 * `knowledge` server is simply never attached, `record_finding` does not exist
 * as far as the model is concerned, and every discovery goes back to being lost.
 * There is no observable symptom short of noticing, weeks later, that the ledger
 * never grew. Fail at boot instead.
 */
export function assertKnowledgeToolAllowed(allowedTools: readonly string[]): void {
  if (allowedTools.includes(KNOWLEDGE_RECORD_FINDING_TOOL)) return;
  throw new Error(
    `${KNOWLEDGE_RECORD_FINDING_TOOL} is missing from allowedTools. `
    + 'filterMcpServers drops any relay server with no matching mcp__<name>__* entry, so the '
    + 'knowledge relay would silently not be attached and findings write-back would stop with '
    + 'no error the user could ever see.',
  );
}
