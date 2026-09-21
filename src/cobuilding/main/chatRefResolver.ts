/**
 * Turns the chat links pasted into a message into what the agent needs to
 * understand them: a short, resolved reference (title, activity, owning tool)
 * for each — never the referenced chat's own transcript. See the header
 * comment of `shared/chatLinks.ts` for why the transcript itself never
 * travels here.
 *
 * Pure and dependency-injected (`ChatRefLookup`) so it can be unit-tested with
 * fake lookups and has no direct dependency on `better-sqlite3` — the real
 * caller in `agentSession.ts` passes `getSession`/`getSessionActivity` from
 * `./db/chatRepository`.
 */
import { parseChatLinks, MAX_CHAT_REFS_PER_MESSAGE, type ChatRef } from '../shared/chatLinks';

export interface ChatRefLookup {
  getSession: (id: string) => { workspace_id: string; title: string; app_dir_name: string | null } | undefined;
  getActivity: (id: string) => { messageCount: number; lastMessageAt: string | null };
}

/**
 * Resolve every chat link in `text` (minus the current chat's own link, which
 * adds nothing) against `lookup`, capped at `MAX_CHAT_REFS_PER_MESSAGE`.
 *
 * A linked id that doesn't exist, or whose session belongs to a different
 * workspace, resolves to `exists: false` with no other field populated —
 * deliberately: leaking a title or message count from another workspace's
 * chat would be a cross-workspace information leak, even though the agent
 * itself is workspace-scoped everywhere else. A lookup that throws is treated
 * the same way rather than propagating, since a resolver failure must never
 * take down the turn that triggered it.
 */
export function resolveChatRefs(
  text: string,
  currentSessionId: string,
  workspaceId: string,
  lookup: ChatRefLookup,
): ChatRef[] {
  const ids = parseChatLinks(text)
    .filter((id) => id !== currentSessionId)
    .slice(0, MAX_CHAT_REFS_PER_MESSAGE);

  return ids.map((sessionId): ChatRef => {
    try {
      const session = lookup.getSession(sessionId);
      if (!session || session.workspace_id !== workspaceId) {
        return { sessionId, exists: false, title: null, appDirName: null, messageCount: 0, lastMessageAt: null };
      }
      const activity = lookup.getActivity(sessionId);
      return {
        sessionId,
        exists: true,
        title: session.title,
        appDirName: session.app_dir_name,
        messageCount: activity.messageCount,
        lastMessageAt: activity.lastMessageAt,
      };
    } catch {
      return { sessionId, exists: false, title: null, appDirName: null, messageCount: 0, lastMessageAt: null };
    }
  });
}
