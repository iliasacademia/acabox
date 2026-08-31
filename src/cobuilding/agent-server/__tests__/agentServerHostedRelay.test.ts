/**
 * Increment 4 (`docs/design/mcp-hosting.md`) added a THIRD half — hosted
 * servers — to a merge that already had a measured, real bug: `setMcpServers`
 * REPLACES the whole dynamic set, so a push that omits one half silently
 * disconnects it with no error anywhere. This drives
 * `applyDynamicMcpToSession`/`mergeDynamicMcpServers`/`assertDynamicMcpComplete`
 * — the REAL production functions, no reimplementation — from `../dynamicMcp`,
 * which exists specifically so this is possible: it has no process-level side
 * effects and can be imported directly. Covers all 8 relay×connector×hosted
 * presence combinations and asserts on the exact object handed to the
 * (stubbed) `setMcpServers` — the thing the design doc calls out as already
 * having burned this repo once.
 *
 * `dynamicMcp.ts` imports nothing from `electron`, `electron-log`, or the
 * Claude Agent SDK, so there is nothing to mock per house doctrine beyond the
 * one seam below: a hand-built stand-in for the SDK's live `Query` instance
 * (`setMcpServers`/`mcpServerStatus`/`toggleMcpServer` aren't on its public
 * type at all — see `DynamicMcpSessionLike`'s own comment for why it's typed
 * `unknown`).
 *
 * NOT covered here: `buildHostedMcpServers` (`../index`), the part that turns
 * a pushed `tools/list` inventory into a real in-process MCP server via
 * `jsonSchemaToZod` + the SDK's own `tool()`. `../index` imports
 * `@anthropic-ai/claude-agent-sdk`, which ships ESM-only (`sdk.mjs`, `"main":
 * "sdk.mjs"`, no CJS build) — measured here, not assumed: even a BARE
 * `import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'` in an
 * otherwise-empty test file fails Jest's transform with "Unexpected token",
 * regardless of which file does the importing or how it's structured. This is
 * a pre-existing, repo-wide constraint — `jest.config.js`'s
 * `transformIgnorePatterns` does not allow-list this package — not something
 * introduced by this change, and it is why the agent server has never had a
 * test importing `index.ts` before this one. `buildHostedMcpServers` was
 * instead verified with a real MCP `Client`/`InMemoryTransport` round trip run
 * through a standalone webpack-bundled harness (same technique as
 * `webpack.agent-server.config.js` itself), executed with plain `node` outside
 * Jest, then discarded — not committed, per this repo's convention of
 * verifying-and-recording rather than shipping throwaway harnesses.
 */
/** @jest-environment node */
import {
  applyDynamicMcpToSession,
  assertDynamicMcpComplete,
  mergeDynamicMcpServers,
  type DynamicMcpSessionLike,
} from '../dynamicMcp';

// ---------------------------------------------------------------------------
// Part 1 — the three-way merge and its push to setMcpServers
// ---------------------------------------------------------------------------

interface FakeQuery {
  setMcpServers: jest.Mock;
  mcpServerStatus: jest.Mock;
  toggleMcpServer: jest.Mock;
  calls: Array<Record<string, unknown>>;
}

function makeFakeQuery(mcpServerStatusNames: string[] = []): FakeQuery {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    setMcpServers: jest.fn(async (servers: Record<string, unknown>) => {
      calls.push(servers);
      return { added: Object.keys(servers), removed: [], errors: {} };
    }),
    mcpServerStatus: jest.fn(async () => mcpServerStatusNames.map((name) => ({ name }))),
    toggleMcpServer: jest.fn(async () => {}),
  };
}

function makeMinimalState(overrides: Partial<DynamicMcpSessionLike>): DynamicMcpSessionLike {
  return {
    sessionId: 'sess-test',
    mcpRelayServers: {},
    mcpConnectors: {},
    mcpHosted: {},
    queryInstance: null,
    ...overrides,
  };
}

describe('applyDynamicMcpToSession — all 8 relay × connector × hosted presence combinations', () => {
  const RELAYS = { activity: { type: 'sdk', marker: 'relay' } };
  const CONNECTORS = { hex: { type: 'http', marker: 'connector' } };
  const HOSTED = { filesystem: { type: 'sdk', marker: 'hosted' } };

  const combinations: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ];

  it.each(combinations)(
    'relays=%s connectors=%s hosted=%s — every present half\'s key(s) reach setMcpServers, and nothing else does',
    async (hasRelays, hasConnectors, hasHosted) => {
      const relays = hasRelays ? { ...RELAYS } : {};
      const connectors = hasConnectors ? { ...CONNECTORS } : {};
      const hosted = hasHosted ? { ...HOSTED } : {};

      const query = makeFakeQuery();
      const state = makeMinimalState({ mcpRelayServers: relays, queryInstance: query });

      const result = await applyDynamicMcpToSession(state, { connectors, hosted });

      expect(query.setMcpServers).toHaveBeenCalledTimes(1);
      const passed = query.calls[0];

      for (const id of Object.keys(relays)) expect(passed).toHaveProperty(id, relays[id as keyof typeof relays]);
      for (const id of Object.keys(connectors)) expect(passed).toHaveProperty(id, connectors[id as keyof typeof connectors]);
      for (const id of Object.keys(hosted)) expect(passed).toHaveProperty(id, hosted[id as keyof typeof hosted]);

      // Not just "present" — EXACTLY the union of the three halves, nothing
      // extra and nothing missing on either side.
      const expectedKeys = [...Object.keys(relays), ...Object.keys(connectors), ...Object.keys(hosted)].sort();
      expect(Object.keys(passed).sort()).toEqual(expectedKeys);

      // The state itself was updated to the new halves (for the next turn's
      // startQuery(), which reads state.mcpConnectors/mcpHosted directly).
      expect(state.mcpConnectors).toBe(connectors);
      expect(state.mcpHosted).toBe(hosted);

      expect(result).not.toBeNull();
      expect(result!.added.sort()).toEqual(expectedKeys);
    },
  );

  it('updating only ONE half leaves the other half\'s current value untouched and still included', async () => {
    const query = makeFakeQuery();
    const state = makeMinimalState({
      mcpRelayServers: { activity: {} },
      mcpConnectors: { hex: {} },
      mcpHosted: { filesystem: {} },
      queryInstance: query,
    });

    // Only hosted changes; connectors is omitted from the update entirely.
    await applyDynamicMcpToSession(state, { hosted: { git: {} } });

    const passed = query.calls[0];
    expect(passed).toHaveProperty('activity'); // relay, always included
    expect(passed).toHaveProperty('hex'); // connector, untouched by this call
    expect(passed).toHaveProperty('git'); // the new hosted set
    expect(passed).not.toHaveProperty('filesystem'); // the old hosted set is gone
    expect(state.mcpConnectors).toEqual({ hex: {} }); // unchanged
  });

  it('with no live queryInstance, the state is updated but setMcpServers is never called (next turn reads it fresh)', async () => {
    const state = makeMinimalState({ queryInstance: null });
    const result = await applyDynamicMcpToSession(state, { connectors: { hex: {} }, hosted: { filesystem: {} } });
    expect(result).toBeNull();
    expect(state.mcpConnectors).toEqual({ hex: {} });
    expect(state.mcpHosted).toEqual({ filesystem: {} });
  });
});

describe('applyDynamicMcpToSession — lingering-server backstop, extended to hosted', () => {
  it('force-disables a dropped HOSTED id that setMcpServers silently left behind (measured SDK quirk)', async () => {
    const query = makeFakeQuery(['oldHosted']); // still present per mcpServerStatus()
    const state = makeMinimalState({ mcpHosted: { oldHosted: {} }, queryInstance: query });

    await applyDynamicMcpToSession(state, { hosted: {} }); // dropped entirely

    expect(query.toggleMcpServer).toHaveBeenCalledWith('oldHosted', false);
  });

  it('does not force-disable a name that is a relay, even if it was also (defensively) a dropped id', async () => {
    const query = makeFakeQuery(['sharedName']);
    const state = makeMinimalState({
      mcpRelayServers: { sharedName: {} },
      mcpHosted: { sharedName: {} },
      queryInstance: query,
    });

    await applyDynamicMcpToSession(state, { hosted: {} });

    expect(query.toggleMcpServer).not.toHaveBeenCalled();
  });

  it('does not force-disable a hosted id that mcpServerStatus() no longer reports (already gone)', async () => {
    const query = makeFakeQuery([]); // status reports nothing lingering
    const state = makeMinimalState({ mcpHosted: { oldHosted: {} }, queryInstance: query });

    await applyDynamicMcpToSession(state, { hosted: {} });

    expect(query.toggleMcpServer).not.toHaveBeenCalled();
  });

  it('a connector still gets the same backstop treatment as before (no regression from generalizing it)', async () => {
    const query = makeFakeQuery(['oldConnector']);
    const state = makeMinimalState({ mcpConnectors: { oldConnector: {} }, queryInstance: query });

    await applyDynamicMcpToSession(state, { connectors: {} });

    expect(query.toggleMcpServer).toHaveBeenCalledWith('oldConnector', false);
  });
});

describe('assertDynamicMcpComplete — the regression guard for a future dropped half', () => {
  it('throws, naming the half, when a hosted id is missing from the merged object', () => {
    expect(() => assertDynamicMcpComplete({ relayA: {} }, { relayA: {} }, {}, { hostedC: {} }))
      .toThrow(/"hostedC" \(hosted\)/);
  });

  it('throws, naming the half, when a connector id is missing', () => {
    expect(() => assertDynamicMcpComplete({}, {}, { connB: {} }, {}))
      .toThrow(/"connB" \(connectors\)/);
  });

  it('throws, naming the half, when a relay id is missing', () => {
    expect(() => assertDynamicMcpComplete({}, { relayA: {} }, {}, {}))
      .toThrow(/"relayA" \(relays\)/);
  });

  it('lists every missing id across multiple halves in one message', () => {
    expect(() => assertDynamicMcpComplete({}, { relayA: {} }, { connB: {} }, { hostedC: {} }))
      .toThrow(/"relayA" \(relays\).*"connB" \(connectors\).*"hostedC" \(hosted\)/s);
  });

  it('does not throw when the merged object contains every key', () => {
    expect(() => assertDynamicMcpComplete(
      { relayA: 1, connB: 2, hostedC: 3 },
      { relayA: 1 },
      { connB: 2 },
      { hostedC: 3 },
    )).not.toThrow();
  });
});

describe('mergeDynamicMcpServers', () => {
  it('spreads all three halves and is exactly what a correct setMcpServers call must receive', () => {
    const state = makeMinimalState({
      mcpRelayServers: { relayA: 1 },
      mcpConnectors: { connB: { marker: 2 } },
      mcpHosted: { hostedC: 3 },
    });
    expect(mergeDynamicMcpServers(state)).toEqual({ relayA: 1, connB: { marker: 2 }, hostedC: 3 });
  });
});
