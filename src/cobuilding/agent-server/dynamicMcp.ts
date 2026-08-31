/**
 * The three-way MCP dynamic-server merge — Acabox's own relays, the user's
 * connectors (Settings → Connectors), and Increment 4's local hosted servers
 * (`docs/design/mcp-hosting.md`) — and the one function allowed to call the
 * SDK's `setMcpServers` with the result.
 *
 * PULLED OUT OF `index.ts` INTO ITS OWN MODULE FOR ONE REASON: that file's
 * last statements run `startServer(loadConfig())` unconditionally, because
 * `dist/agent-server.js` is always launched as `node dist/agent-server.js`
 * (see CLAUDE.md's standalone-harness note) and never imported as a library.
 * Importing `index.ts` from a test would try to read a config file that
 * doesn't exist and bind a real port before a single assertion runs. This
 * module has no process-level statements — nothing but the three functions
 * below — so `agentServerHostedRelay.test.ts` can drive the real merge/push
 * logic directly with no seam beyond a stand-in `queryInstance`.
 *
 * `DynamicMcpSessionLike` is deliberately narrower than `index.ts`'s real
 * `SessionState` (which additionally carries `sseClients`, `pendingMcpCalls`,
 * `messageQueue`, an idle timer, …): everything below only ever reads the
 * four fields declared here, so `SessionState` satisfies this interface
 * structurally with no cast needed at either call site (`createSession`'s
 * `startQuery`, and the `/connectors`/`/hosted` route handlers).
 *
 * THE BUG THIS WHOLE MODULE EXISTS TO PREVENT, measured pre-Increment-4:
 * `setMcpServers({hex})` against a session already holding a relay server
 * returned `{added:['hex'], removed:['relaydemo']}` — sending only the
 * connectors silently disconnected the relay. `setMcpServers` REPLACES the
 * entire dynamic set; it does not merge with whatever it was called with
 * last. Increment 4 adds a THIRD half (hosted servers) that can be dropped
 * the exact same way, so `mergeDynamicMcpServers` is the one place all three
 * are combined, and `assertDynamicMcpComplete` self-checks its own output
 * every time it runs rather than trusting three lines of object-spread syntax
 * not to have been edited wrong later.
 */

export interface DynamicMcpSessionLike {
  sessionId: string;
  mcpRelayServers: Record<string, unknown>;
  mcpConnectors: Record<string, Record<string, unknown>>;
  mcpHosted: Record<string, unknown>;
  /**
   * The live SDK `Query` instance, or `null` between turns. Typed `unknown`
   * here rather than the SDK's `Query` type because every call below already
   * reaches through `as any`: `setMcpServers`/`mcpServerStatus`/
   * `toggleMcpServer` are not on the SDK's public `Query` type — they exist
   * only on the real runtime instance, measured against the shipped SDK when
   * `applyConnectorsToSession` (this function's pre-Increment-4 name) was
   * first written.
   */
  queryInstance: unknown;
}

/**
 * Guard against a future edit silently dropping one of the three MCP halves
 * from the object handed to `setMcpServers` / the `mcpServers` `query()`
 * option. In the style of `assertKnowledgeToolAllowed`
 * (`shared/agentAllowedTools.ts`) — written because the failure it catches is
 * otherwise invisible: `setMcpServers` REPLACES the whole dynamic set (see the
 * module comment above), so a merge that quietly drops, say,
 * `...state.mcpHosted` does not error, warn, or fail a tool call — it just
 * silently disconnects every hosted server for that session, and the only
 * symptom is the agent claiming a capability doesn't exist.
 *
 * Called at BOTH places the three-way merge is actually constructed
 * (`mergeDynamicMcpServers`, below — used by `index.ts`'s `startQuery()` for a
 * brand-new session and by `applyDynamicMcpToSession` for a live push) rather
 * than once at boot, because the bug this exists for is a code edit to the
 * merge itself, not a bad config value that a one-time check on `initialConfig`
 * could have caught.
 */
export function assertDynamicMcpComplete(
  merged: Record<string, unknown>,
  relays: Record<string, unknown>,
  connectors: Record<string, unknown>,
  hosted: Record<string, unknown>,
): void {
  const missing: string[] = [];
  for (const [half, servers] of [['relays', relays], ['connectors', connectors], ['hosted', hosted]] as const) {
    for (const id of Object.keys(servers)) {
      if (!(id in merged)) missing.push(`"${id}" (${half})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Dynamic MCP merge is missing ${missing.join(', ')} from the object about to be passed to `
      + 'setMcpServers/query(). setMcpServers REPLACES the whole dynamic set, so a merge that drops '
      + 'a half disconnects it with no error the user or the model would ever see — see '
      + 'mergeDynamicMcpServers and applyDynamicMcpToSession.',
    );
  }
}

/**
 * The one place the three MCP halves are combined into what `setMcpServers`/
 * `query()`'s `mcpServers` option actually receives. There is exactly one
 * merge implementation to get right, and it self-checks via
 * `assertDynamicMcpComplete` every time it runs rather than trusting the
 * object-spread syntax not to have been edited wrong.
 */
export function mergeDynamicMcpServers(state: DynamicMcpSessionLike): Record<string, unknown> {
  const merged = {
    ...state.mcpRelayServers,
    ...state.mcpConnectors,
    ...state.mcpHosted,
  };
  assertDynamicMcpComplete(merged, state.mcpRelayServers, state.mcpConnectors, state.mcpHosted);
  return merged;
}

/**
 * Push a new connector set and/or a new hosted-server set into one live
 * session. Renamed from `applyConnectorsToSession` when Increment 4
 * (`docs/design/mcp-hosting.md`) added the third half — flagged in the design
 * as the riskiest single edit in the plan, because the bug in the module
 * comment above already had two ways to fire and this gives it a third.
 *
 * `update.connectors` / `update.hosted` are each optional so a caller can
 * update just one half without disturbing the other's current value —
 * `POST /connectors` only ever touches connectors, `POST /hosted` only ever
 * touches hosted, and whichever field isn't passed simply keeps whatever
 * `state.mcpConnectors`/`state.mcpHosted` already held. Regardless of which
 * half(s) changed, `mergeDynamicMcpServers` always sends all three — that is
 * the whole reason both functions exist; do not call `setMcpServers` directly
 * anywhere else.
 */
export async function applyDynamicMcpToSession(
  state: DynamicMcpSessionLike,
  update: { connectors?: Record<string, Record<string, unknown>>; hosted?: Record<string, unknown> },
): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> } | null> {
  // Ids that were present in a half BEFORE this call, for exactly the
  // half(s) being replaced. A half that isn't part of this update keeps its
  // current members, which must NOT be treated as "dropped" below — only the
  // half(s) actually being swapped can have lost a member.
  const droppedCandidates: string[] = [];
  const changedHalves: string[] = [];

  if (update.connectors) {
    droppedCandidates.push(...Object.keys(state.mcpConnectors));
    state.mcpConnectors = update.connectors;
    changedHalves.push('connectors');
  }
  if (update.hosted) {
    droppedCandidates.push(...Object.keys(state.mcpHosted));
    state.mcpHosted = update.hosted;
    changedHalves.push('hosted');
  }

  // No live query (session created but idle, or between turns after a
  // close): the next startQuery() reads state.mcpConnectors/mcpHosted
  // directly via mergeDynamicMcpServers, so we're already done.
  const q = state.queryInstance;
  if (!q || typeof (q as any).setMcpServers !== 'function') return null;

  const result = await (q as any).setMcpServers(mergeDynamicMcpServers(state));

  // setMcpServers does not always drop a server it wasn't given. Measured
  // against the bundled SDK: a server supplied in the original `mcpServers`
  // option that never got past `needs-auth` survives `setMcpServers({})` with
  // `removed: []` and stays in mcpServerStatus(). (One that was itself ADDED
  // by a previous setMcpServers call removes cleanly, as does a connected
  // one — it is specifically the option-passed, never-connected case.)
  //
  // `toggleMcpServer(name, false)` does move it to `disabled`, so use that as
  // the backstop — for names WE previously supplied in either the connector
  // or the hosted half, and NEVER a relay server, and NEVER a `.mcp.json`
  // server the user set up themselves. A dropped hosted id gets exactly the
  // same treatment as a dropped connector: the id namespace is shared
  // (`shared/hostedMcp.ts`), and this backstop doesn't need to know which of
  // the two families a lingering name came from.
  const stillExpected = new Set([...Object.keys(state.mcpConnectors), ...Object.keys(state.mcpHosted)]);
  const dropped = droppedCandidates.filter((name) => !stillExpected.has(name) && !(name in state.mcpRelayServers));
  if (dropped.length && typeof (q as any).toggleMcpServer === 'function') {
    let present: Set<string>;
    try {
      const status = await (q as any).mcpServerStatus();
      present = new Set((status ?? []).map((s: any) => s?.name));
    } catch {
      present = new Set(dropped); // can't tell — try them all
    }
    for (const name of dropped) {
      if (!present.has(name)) continue;
      try {
        await (q as any).toggleMcpServer(name, false);
        result.removed = [...(result.removed ?? []), name];
        console.log(`[AgentServer] Force-disabled lingering server "${name}" on ${state.sessionId}`);
      } catch (err) {
        console.warn(`[AgentServer] Could not disable "${name}" on ${state.sessionId}:`, err);
      }
    }
  }

  console.log(
    `[AgentServer] Dynamic MCP (${changedHalves.join('+') || 'none'}) applied to ${state.sessionId}: `
    + `added=[${result?.added ?? []}] removed=[${result?.removed ?? []}] `
    + `errors=${JSON.stringify(result?.errors ?? {})}`,
  );
  return result;
}
