/**
 * Pure ranking for the Chats-page search box. See
 * `docs/design/chat-search.md` § Ticket B.
 *
 * A row can match on its title (from the thread-list runtime's own state,
 * cheap and already in memory) and/or on message prose (from
 * `useProseSearch`, one batched main-process query). Title matches are shown
 * first — they are what the user is most likely typing a chat's name to find
 * — then prose-only matches, each group keeping the list's own recency order
 * (`threadIds`) rather than being re-sorted by relevance.
 *
 * No imports — in particular nothing from `@assistant-ui/react` — so this
 * renders under jest.
 */

export interface RankedRow {
  threadId: string;
  sessionId: string;
  titleMatch: boolean;
  prose: ChatProseResultData | null;
}

export function rankSearchRows(
  threadIds: readonly string[],
  items: Readonly<Record<string, { remoteId?: string; title?: string }>>,
  query: string,
  prose: ReadonlyMap<string, ChatProseResultData>,
): RankedRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const titleRows: RankedRow[] = [];
  const proseRows: RankedRow[] = [];

  for (const threadId of threadIds) {
    const item = items[threadId];
    const remoteId = item?.remoteId;
    if (!remoteId) continue; // the unstarted "new thread" entry has no remoteId

    const title = (item.title ?? 'New Chat').toLowerCase();
    const titleMatch = title.includes(q);
    const hasProse = prose.has(remoteId);
    if (!titleMatch && !hasProse) continue;

    const row: RankedRow = { threadId, sessionId: remoteId, titleMatch, prose: prose.get(remoteId) ?? null };
    (titleMatch ? titleRows : proseRows).push(row);
  }

  return [...titleRows, ...proseRows];
}
