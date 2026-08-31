/**
 * The shared MCP-server vocabulary (design: `docs/design/mcp-hosting.md`,
 * Increment 3, "One vocabulary, seven words"). Two things this suite must
 * catch if they ever regress: `builtinServers()` silently drifting from
 * `BASE_AGENT_ALLOWED_TOOLS` (the source of truth `filterMcpServers` itself
 * reads), and "Unknown" ever becoming a reachable status word again.
 */
import {
  builtinServers,
  builtinServerLabel,
  connectorStatusToServerState,
  hostedRunStateToServerState,
  serverStateDotClass,
  serverStateLabel,
  SERVER_STATE_PRECEDENCE,
  type ServerState,
} from '../mcpServers';
import { BASE_AGENT_ALLOWED_TOOLS } from '../agentAllowedTools';
import { RESERVED_CONNECTOR_IDS, type ConnectorStatus } from '../connectors';
import type { HostedRunState } from '../hostedMcp';

describe('builtinServers', () => {
  it('returns exactly the relay names present in BASE_AGENT_ALLOWED_TOOLS, computed independently here', () => {
    // Computed straight from the allowlist rather than hand-copied, so a new
    // relay entry there fails THIS assertion instead of silently not showing
    // up in builtinServers().
    const expected = new Set<string>();
    for (const entry of BASE_AGENT_ALLOWED_TOOLS) {
      const match = /^mcp__([a-zA-Z0-9-]+)__/.exec(entry);
      if (match) expected.add(match[1]);
    }
    expect(expected.size).toBeGreaterThan(0); // sanity: the allowlist really has mcp__ entries

    const got = new Set(builtinServers().map((s) => s.id));
    expect(got).toEqual(expected);
  });

  it('every returned name is reserved (would shadow one of Acabox\'s own relays otherwise)', () => {
    for (const server of builtinServers()) {
      expect(RESERVED_CONNECTOR_IDS).toContain(server.id);
    }
  });

  it('groups every mcp__<server>__<tool> entry under its server, tool name intact', () => {
    const miniApps = builtinServers().find((s) => s.id === 'mini-apps');
    expect(miniApps).toBeDefined();
    expect(miniApps!.toolNames).toEqual(
      expect.arrayContaining(['open_mini_application', 'build_and_open_mini_application', 'list_published_servers', 'call_published_tool']),
    );
  });

  it('never returns an entry with zero tools', () => {
    for (const server of builtinServers()) {
      expect(server.toolNames.length).toBeGreaterThan(0);
    }
  });

  it('ignores non-mcp allowlist entries (Bash, Read, WebFetch, ...)', () => {
    const ids = builtinServers().map((s) => s.id);
    for (const bare of ['Bash', 'Read', 'Write', 'WebFetch', 'WebSearch', 'TodoWrite']) {
      expect(ids).not.toContain(bare);
    }
  });
});

describe('builtinServerLabel', () => {
  it('title-cases and de-hyphenates', () => {
    expect(builtinServerLabel('mini-apps')).toBe('Mini Apps');
    expect(builtinServerLabel('activity')).toBe('Activity');
  });
});

describe('serverStateLabel — the seven words', () => {
  it('is total over the ServerState union (every precedence entry maps to a label)', () => {
    expect(SERVER_STATE_PRECEDENCE.length).toBe(7);
    for (const state of SERVER_STATE_PRECEDENCE) {
      expect(typeof serverStateLabel(state)).toBe('string');
      expect(serverStateLabel(state).length).toBeGreaterThan(0);
    }
  });

  it('produces exactly these seven distinct words, runtime map-size checked', () => {
    const labels = new Set(SERVER_STATE_PRECEDENCE.map((s) => serverStateLabel(s)));
    expect(labels.size).toBe(7);
    expect(labels).toEqual(new Set([
      'Available', 'Starting', 'Stopped', 'Not checked', 'Off', 'Needs sign-in', 'Failed',
    ]));
  });

  it('never returns "Unknown" — that is describeStatus()\'s word, not this module\'s', () => {
    for (const state of SERVER_STATE_PRECEDENCE) {
      expect(serverStateLabel(state)).not.toBe('Unknown');
    }
  });

  it('serverStateDotClass reuses the existing ConnectorsSettings.css classes only', () => {
    const allowed = new Set([
      'connectorDot--ok', 'connectorDot--warn', 'connectorDot--error',
      'connectorDot--idle', 'connectorDot--pending',
    ]);
    for (const state of SERVER_STATE_PRECEDENCE) {
      expect(allowed.has(serverStateDotClass(state))).toBe(true);
    }
  });
});

describe('hostedRunStateToServerState', () => {
  const RUN_STATES: HostedRunState[] = ['stopped', 'starting', 'ready', 'restarting', 'failed', 'paused'];

  it('is Off whenever enabled is false, regardless of run state (Off outranks everything)', () => {
    for (const runState of RUN_STATES) {
      expect(hostedRunStateToServerState(false, runState)).toBe('off');
    }
  });

  it('maps every enabled run state to a distinct, sensible word', () => {
    expect(hostedRunStateToServerState(true, 'ready')).toBe('available');
    expect(hostedRunStateToServerState(true, 'starting')).toBe('starting');
    expect(hostedRunStateToServerState(true, 'restarting')).toBe('starting');
    expect(hostedRunStateToServerState(true, 'failed')).toBe('failed');
    expect(hostedRunStateToServerState(true, 'stopped')).toBe('stopped');
    expect(hostedRunStateToServerState(true, 'paused')).toBe('stopped');
  });
});

describe('connectorStatusToServerState', () => {
  it('is Off whenever enabled is false, regardless of the observed status', () => {
    const statuses: ConnectorStatus[] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'unknown'];
    for (const status of statuses) {
      expect(connectorStatusToServerState({ enabled: false, live: true, status })).toBe('off');
    }
  });

  it('maps each live, enabled status to its word', () => {
    expect(connectorStatusToServerState({ enabled: true, live: true, status: 'connected' })).toBe('available');
    expect(connectorStatusToServerState({ enabled: true, live: true, status: 'failed' })).toBe('failed');
    expect(connectorStatusToServerState({ enabled: true, live: true, status: 'needs-auth' })).toBe('needsSignIn');
    expect(connectorStatusToServerState({ enabled: true, live: true, status: 'pending' })).toBe('starting');
    expect(connectorStatusToServerState({ enabled: true, live: true, status: 'unknown' })).toBe('notChecked');
    expect(connectorStatusToServerState({ enabled: true, live: true, status: undefined })).toBe('notChecked');
  });

  it('demotes a cached "connected" report to notChecked when live is false', () => {
    expect(connectorStatusToServerState({ enabled: true, live: false, status: 'connected' })).toBe('notChecked');
  });

  it('does NOT demote failed/needsSignIn/starting when live is false — those are not stale-success claims', () => {
    expect(connectorStatusToServerState({ enabled: true, live: false, status: 'failed' })).toBe('failed');
    expect(connectorStatusToServerState({ enabled: true, live: false, status: 'needs-auth' })).toBe('needsSignIn');
    expect(connectorStatusToServerState({ enabled: true, live: false, status: 'pending' })).toBe('starting');
  });

  it('never produces the label "Unknown" for any input, including status undefined', () => {
    const statuses: (ConnectorStatus | undefined)[] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'unknown', undefined];
    for (const live of [true, false]) {
      for (const enabled of [true, false]) {
        for (const status of statuses) {
          const state: ServerState = connectorStatusToServerState({ enabled, live, status });
          expect(serverStateLabel(state)).not.toBe('Unknown');
        }
      }
    }
  });
});
