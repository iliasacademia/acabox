/**
 * How long Acabox holds an agent session open so a connector OAuth handshake
 * can finish.
 *
 * WHY THIS EXISTS
 * ---------------
 * A remote MCP connector signs in with OAuth. `mcp__<id>__authenticate` starts
 * the flow and returns an authorization URL for the user to open in their
 * browser. Everything that flow needs to finish — the PKCE code verifier, the
 * state nonce, and the `http://127.0.0.1:<ephemeral>/callback` listener that
 * receives the redirect — lives ONLY in the memory of the Claude Code CLI
 * subprocess that ran the tool. None of it is written to disk, so no other
 * process and no later process can complete the handshake.
 *
 * That subprocess is owned by one agent-server session. Acabox used to destroy
 * that session the moment the turn ended — and returning the authorization URL
 * to the user IS what ends the turn. So the listener died seconds after the
 * link was printed, always before a human could click it. The browser redirect
 * got ERR_CONNECTION_REFUSED, and a manual paste into
 * `complete_authentication` hit a later subprocess whose flow map was empty and
 * answered "No OAuth flow is in progress" — regardless of how correct the code,
 * state and port were. The handshake was unwinnable by construction.
 *
 * The fix is to pin the session across the user's browser round-trip. This is
 * the length of that pin.
 *
 * WHY 5 MINUTES, EXACTLY
 * ----------------------
 * It is not a guess and it is not tunable-by-taste. The bundled CLI arms its
 * own hard ceiling on a pending flow when it starts one:
 *
 *   setTimeout((l,Q)=>{l(),Q(Error("Authentication timeout"))},300000,C,g)
 *
 * There is no configuration knob for it. Pinning for LESS would throw away a
 * flow the CLI still considers live; pinning for MORE would keep an
 * API-key-bearing subprocess alive past the point where it can accomplish
 * anything. Match it exactly.
 */
export const OAUTH_FLOW_WINDOW_MS = 300_000;

/**
 * Tools whose invocation means "an OAuth flow is now pending in this
 * subprocess, do not kill it". The SDK names connector auth tools
 * `mcp__<serverName>__authenticate`; `<serverName>` is a connector id, which
 * `shared/connectors.ts` validates to `[a-z0-9-]+`.
 *
 * Anchored on both ends so a mini-app or relay tool that merely ends in
 * "authenticate" cannot pin a session.
 */
export const MCP_AUTHENTICATE_TOOL = /^mcp__[a-z0-9-]+__authenticate$/;

/**
 * The paired tool that redeems the flow manually when the browser callback
 * could not reach the listener. Seeing its result is an early unpin signal —
 * the flow is either redeemed or dead, and either way the wait is over.
 */
export const MCP_COMPLETE_AUTH_TOOL = /^mcp__[a-z0-9-]+__complete_authentication$/;
