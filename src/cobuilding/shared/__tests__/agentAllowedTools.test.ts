import {
  BASE_AGENT_ALLOWED_TOOLS,
  KNOWLEDGE_RECORD_FINDING_TOOL,
  assertKnowledgeToolAllowed,
  buildAgentAllowedTools,
} from '../agentAllowedTools';
import { connectorAllowedTools, replaceConnectorAllowedTools } from '../connectors';
import type { ConnectorConfig } from '../connectors';

const connectors: ConnectorConfig[] = [
  { id: 'hex', label: 'Hex', transport: 'http', url: 'https://mcp.hex.tech/mcp', enabled: true },
  { id: 'sentry', label: 'Sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp', enabled: true },
  { id: 'off', label: 'Off', transport: 'http', url: 'https://example.com/mcp', enabled: false },
];

describe('buildAgentAllowedTools', () => {
  it('agrees exactly with the crash-restart recompute', () => {
    // THE POINT OF THIS FILE. `AgentInfrastructureController.start()` builds the
    // list from scratch; `containerService.rememberAgentConnectors` rebuilds it
    // from the stored config with `replaceConnectorAllowedTools` when a
    // connector changes, and that stored config is what a crash-restart
    // replays. When those two disagreed, an agent-server crash silently
    // changed which tools were auto-approved and nothing surfaced it.
    const connectorTools = connectorAllowedTools(connectors);
    const built = buildAgentAllowedTools(connectorTools);
    const recomputed = replaceConnectorAllowedTools(
      buildAgentAllowedTools([]),
      [],
      connectors.filter((c) => c.enabled).map((c) => c.id),
    );
    expect(built).toEqual(recomputed);
  });

  it('survives a connector being swapped out, still matching a fresh build', () => {
    const before = buildAgentAllowedTools(connectorAllowedTools(connectors));
    const after = replaceConnectorAllowedTools(before, ['hex', 'sentry'], ['notion']);
    const fresh = buildAgentAllowedTools(
      connectorAllowedTools([{ id: 'notion', label: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true }]),
    );
    expect(after).toEqual(fresh);
  });

  it('does not carry a bare Skill entry', () => {
    // With `Options.skills` passed, the SDK unions `Skill(<id>)` per entry into
    // --allowedTools itself. A bare `Skill` would re-approve every skill the
    // allowlist just filtered out — silently, since the filter is the roster
    // budget allocator rather than a safety gate.
    expect(buildAgentAllowedTools()).not.toContain('Skill');
    expect(buildAgentAllowedTools().some((t) => t.startsWith('Skill('))).toBe(false);
  });

  it('includes the knowledge write-back tool', () => {
    expect(buildAgentAllowedTools()).toContain(KNOWLEDGE_RECORD_FINDING_TOOL);
  });

  it('has one entry per relay server the agent server registers', () => {
    // filterMcpServers attaches a relay only if some `mcp__<name>__*` entry is
    // present. A relay with no entry is dropped with no error anywhere.
    for (const relay of ['activity', 'notification', 'reaction', 'mini-apps', 'workspace', 'knowledge']) {
      expect(BASE_AGENT_ALLOWED_TOOLS.some((t) => t.startsWith(`mcp__${relay}__`))).toBe(true);
    }
  });
});

describe('assertKnowledgeToolAllowed', () => {
  it('throws when the entry is missing, naming the consequence', () => {
    const stripped = buildAgentAllowedTools().filter((t) => t !== KNOWLEDGE_RECORD_FINDING_TOOL);
    expect(() => assertKnowledgeToolAllowed(stripped)).toThrow(/filterMcpServers/);
  });

  it('accepts the real list', () => {
    expect(() => assertKnowledgeToolAllowed(buildAgentAllowedTools(connectorAllowedTools(connectors)))).not.toThrow();
  });
});
