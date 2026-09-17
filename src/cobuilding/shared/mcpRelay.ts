/**
 * Context handed to a host MCP relay handler alongside its arguments.
 *
 * The relay protocol carries a server name, a tool name and the model's
 * arguments, and nothing about WHO is calling — which is fine for every
 * handler that answers a question about the workspace, and wrong for one that
 * answers a question about conversations. `mcp__chats__search_chats` has to
 * exclude the chat it is being called from: a thread that finds itself in its
 * own search results invites the model to "go read" a transcript it is already
 * inside, spending a retrieval to be told what it just said.
 *
 * Optional everywhere, because the caller is not always a chat — the workspace
 * scanner and title generation run queries with no `sessions` row behind them.
 * A handler that needs the id must cope with its absence rather than assume.
 */
export interface McpRelayContext {
  /** `sessions.id` of the chat this call originated from, when there is one. */
  callerSessionId?: string;
}

/** A host-side relay handler: the model's arguments, plus who is asking. */
export type McpRelayHandler = (args: any, ctx?: McpRelayContext) => Promise<any>;
