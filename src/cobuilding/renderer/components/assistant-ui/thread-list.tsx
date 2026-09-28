import React, { useState, useRef, useEffect, useContext, createContext, useCallback } from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useThreadListItemRuntime,
  useThreadList,
} from '@assistant-ui/react';
import { DropdownMenu, AlertDialog } from 'radix-ui';
import { MessageSquareIcon, MoreVerticalIcon, PencilIcon, TrashIcon, SearchIcon } from 'lucide-react';
import type { FC } from 'react';
import {
  dateFromSessionStoredAt,
  getSessionAppDirName,
  getSessionCreatedAt,
} from '../../sessionTimestamps';
import { resolveToolIcon } from '../command-desk/toolIcon';
import { ChatMarkDot } from '../command-desk/ChatMarkDot';
import { formatRelativeDate as formatRelativeDateFromDate } from '../../../../shared/utils';
import { useChatPreview, formatPreviewLine } from '../../chatPreviewStore';
import { useProseSearch, type ProseSearchState } from '../../useProseSearch';
import { rankSearchRows } from '../../chatSearchRank';

interface ThreadListProps {
  onSelectThread?: () => void;
}

const SearchQueryContext = createContext('');
const SelectThreadContext = createContext<(() => void) | undefined>(undefined);
/** Prose search results for the current query; see `useProseSearch`. Read by
 * `ThreadListItem` to show hit lines instead of the ordinary preview. */
const ProseResultsContext = createContext<ReadonlyMap<string, ChatProseResultData>>(new Map());

// --- Owning-tool chip ---
//
// App chats live in the same list as general ones, so each row that belongs to
// a mini app is tagged with it. The dirName → tool lookup is fetched once per
// mount and shared by every row; a tool that no longer exists (deleted, its
// chats kept) falls back to the raw dirName rather than dropping the chip.

function useToolsByDirName(): Map<string, MiniAppEntry> {
  const [tools, setTools] = useState<Map<string, MiniAppEntry>>(new Map());
  useEffect(() => {
    let cancelled = false;
    window.miniAppsAPI.list().then((apps) => {
      if (!cancelled) setTools(new Map(apps.map((a) => [a.dirName, a])));
    }).catch(() => { /* chip degrades to the dirName */ });
    return () => { cancelled = true; };
  }, []);
  return tools;
}

const ToolsByDirNameContext = createContext<Map<string, MiniAppEntry>>(new Map());

const ChatToolChip: FC<{ dirName: string }> = ({ dirName }) => {
  const tool = useContext(ToolsByDirNameContext).get(dirName);
  const Icon = resolveToolIcon(tool?.icon ?? null);
  return (
    <span className="chatListItemToolChip" title={`Chat for ${tool?.name ?? dirName}`}>
      <Icon style={{ width: 11, height: 11 }} />
      {tool?.name ?? dirName}
    </span>
  );
};

// --- Search highlighting ---

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query || !text) return text;
  const lower = text.toLowerCase();
  const lq = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(lq, cursor);
  while (idx !== -1) {
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(<mark key={idx} className="searchHighlight">{text.slice(idx, idx + query.length)}</mark>);
    cursor = idx + query.length;
    idx = lower.indexOf(lq, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? <>{parts}</> : text;
}

// --- Relative date formatting ---

function formatRelativeDate(iso: string): string {
  return formatRelativeDateFromDate(dateFromSessionStoredAt(iso));
}

// --- Conversation count ---

const ConversationCount: FC = () => {
  const threadIds = useThreadList((s: any) => s.threadIds);
  const count = threadIds?.length ?? 0;
  // Hold the last non-zero count so the "0 CONVERSATIONS" flash during a
  // background refresh (sessions:changed → _loadThreadsPromise reset) doesn't
  // show. We only ever bump the displayed count up or hold it; the runtime
  // settles to the real count on its own.
  const stableRef = useRef(count);
  if (count > 0) stableRef.current = count;
  const display = count > 0 ? count : stableRef.current;
  return <>{display} CONVERSATION{display !== 1 ? 'S' : ''}</>;
};

// --- Stable items: hide the empty flash during refresh ---
//
// `useThreadList((s) => s.threadIds)` briefly returns `[]` when the runtime
// invalidates the list cache and reloads (we do this on every
// sessions:changed broadcast, see SessionsListRefresher in index.tsx). If we
// render the live items unconditionally, navigating back from a chat shows
// an empty list for a beat before the new fetch lands.
//
// We persist "have we ever seen items?" at module scope so that ThreadList
// unmount/remount (which happens when the user enters a chat and clicks
// back) doesn't reset the signal. While the live count is 0 but we know
// items exist server-side, we render a "Refreshing…" placeholder instead
// of the genuine empty state.
let haveEverSeenThreads = false;

const StableThreadItems: FC = () => {
  const threadIds = useThreadList((s: any) => s.threadIds) as string[] | undefined;
  const count = threadIds?.length ?? 0;
  if (count > 0) haveEverSeenThreads = true;

  if (count === 0 && haveEverSeenThreads) {
    return (
      <div className="chatListRefreshing" style={{ padding: '12px 4px', color: '#9ca3af', fontSize: 13 }}>
        Refreshing chats…
      </div>
    );
  }

  return (
    <ThreadListPrimitive.Items>
      {() => <ThreadListItem />}
    </ThreadListPrimitive.Items>
  );
};

// --- Ranked items: search mode ---
//
// Browsing renders every item through the runtime's own `Items` primitive.
// Searching instead renders a caller-picked subset in a caller-picked order —
// title matches first, then prose-only ones, per `rankSearchRows` — via
// `ItemByIndex`, which is the one primitive that takes an explicit index
// rather than iterating for you.

const RankedThreadItems: FC<{ query: string; prose: ProseSearchState }> = ({ query, prose }) => {
  const threadIds = (useThreadList((s: any) => s.threadIds) as string[] | undefined) ?? [];
  const threadItems = (useThreadList((s: any) => s.threadItems) as
    Record<string, { remoteId?: string; title?: string }> | undefined) ?? {};
  const trimmed = query.trim();
  const rows = rankSearchRows(threadIds, threadItems, query, prose.results);

  if (rows.length === 0) {
    // `prose.forQuery` lags the query while a debounced request is in flight —
    // rendering the empty state before it answers would flash "no chats"
    // for every query on the way to a real hit.
    if (prose.forQuery !== trimmed) return null;
    return <div className="chatListEmpty">No chats mention &ldquo;{trimmed}&rdquo;.</div>;
  }

  return (
    <>
      {rows.map((row) => (
        <ThreadListPrimitive.ItemByIndex
          key={row.threadId}
          index={threadIds.indexOf(row.threadId)}
          components={{ ThreadListItem }}
        />
      ))}
    </>
  );
};

// --- Main ThreadList ---

export const ThreadList: FC<ThreadListProps> = ({ onSelectThread }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const toolsByDirName = useToolsByDirName();
  const prose = useProseSearch(searchQuery);
  const isSearching = searchQuery.trim().length > 0;

  return (
    <ToolsByDirNameContext.Provider value={toolsByDirName}>
    <ProseResultsContext.Provider value={prose.results}>
    <SearchQueryContext.Provider value={searchQuery}>
      <SelectThreadContext.Provider value={onSelectThread}>
        <ThreadListPrimitive.Root className="pageShell">
          <div className="pageShell__inner">
              {/* Page header */}
              <div className="pageShell__headerBlock">
                <div className="pageShell__stats">
                  <ConversationCount />
                </div>
                <h1 className="pageShell__title">Chats</h1>
                <p className="pageShell__subtitle">
                  Every conversation you've had with me. Most recent first.
                </p>
              </div>

              {/* Search */}
              <div className="chatListSearchRow">
                <div className="chatListSearchBox">
                  <SearchIcon className="chatListSearchIcon" />
                  <input
                    className="chatListSearchInput"
                    placeholder="Search chat titles and messages…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>

              {/* Items */}
              <div className="chatListItems">
                {isSearching ? <RankedThreadItems query={searchQuery} prose={prose} /> : <StableThreadItems />}
              </div>
          </div>
        </ThreadListPrimitive.Root>
      </SelectThreadContext.Provider>
    </SearchQueryContext.Provider>
    </ProseResultsContext.Provider>
    </ToolsByDirNameContext.Provider>
  );
};

// --- ThreadListItem ---

const ThreadListItem: FC = () => {
  const runtime = useThreadListItemRuntime();
  const searchQuery = useContext(SearchQueryContext);
  const onSelectThread = useContext(SelectThreadContext);
  const proseResults = useContext(ProseResultsContext);

  const remoteId = runtime.getState().remoteId;
  const title = runtime.getState().title ?? 'New Chat';
  const createdAt = getSessionCreatedAt(remoteId);
  const appDirName = getSessionAppDirName(remoteId);
  const preview = useChatPreview(remoteId);
  const previewText = formatPreviewLine(preview);
  // Present only while searching and only for a chat with matching message
  // text — a title-only match keeps the ordinary preview line below.
  const proseHit = remoteId ? proseResults.get(remoteId) : undefined;
  const hits = proseHit?.hits ?? [];
  const total = proseHit?.total ?? 0;

  // --- Rename modal state (must be before any early return) ---
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const openRename = useCallback(() => {
    setRenameValue(title);
    setRenameOpen(true);
  }, [title]);

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== runtime.getState().title) {
      runtime.rename(trimmed);
    }
    setRenameOpen(false);
  }, [renameValue, runtime]);

  // --- Delete confirm state ---
  const [deleteOpen, setDeleteOpen] = useState(false);

  const confirmDelete = useCallback(() => {
    runtime.delete();
    setDeleteOpen(false);
  }, [runtime]);

  // The runtime always holds one unstarted "new thread" with no remoteId —
  // it has no persisted session to jump back into, so keep it out of the list
  // (the header count already excludes it).
  if (!remoteId) return null;

  // Which rows render at all is now the caller's decision (`rankSearchRows` /
  // `StableThreadItems`) — this component only decides what to show inside a
  // row it has already been asked to render.

  return (
    <ThreadListItemPrimitive.Root className="chatListItem">
      <div className="chatListItemIcon">
        <MessageSquareIcon style={{ width: 18, height: 18 }} />
        <ChatMarkDot sessionId={remoteId} className="chatListItemMark" />
      </div>
      <ThreadListItemPrimitive.Trigger
        className="chatListItemTrigger"
        onClick={() => onSelectThread?.()}
      >
        <span className="chatListItemTitleRow">
          <span className="chatListItemTitle">
            {searchQuery ? highlightMatch(title, searchQuery) : title}
          </span>
          {appDirName ? <ChatToolChip dirName={appDirName} /> : null}
        </span>
        {hits.length > 0 ? (
          <span className="chatListItemHits">
            {hits.map((h) => (
              <span key={h.messageId} className="chatListItemHit">
                <span className="chatListItemHitWho">{h.role === 'user' ? 'You:' : 'CS:'}</span>{' '}
                {highlightMatch(h.snippet, searchQuery)}
              </span>
            ))}
            {total > hits.length && <span className="chatListItemHitMore">+{total - hits.length} more</span>}
          </span>
        ) : previewText ? (
          <span className="chatListItemPreview">
            {searchQuery ? highlightMatch(previewText, searchQuery) : previewText}
          </span>
        ) : null}
      </ThreadListItemPrimitive.Trigger>

      {/* Date + menu, vertically centered together */}
      <div className="chatListItemMeta">
        {createdAt ? (
          <span className="chatListItemDate">{formatRelativeDate(createdAt)}</span>
        ) : null}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="chatListItemMenuBtn" onClick={(e) => e.stopPropagation()}>
              <MoreVerticalIcon style={{ width: 16, height: 16 }} />
            </button>
          </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="chatListDropdown" sideOffset={4} align="end">
            <DropdownMenu.Item
              className="chatListDropdownItem"
              onSelect={openRename}
            >
              <PencilIcon style={{ width: 14, height: 14 }} />
              Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="chatListDropdownItem chatListDropdownItem--danger"
              onSelect={() => setDeleteOpen(true)}
            >
              <TrashIcon style={{ width: 14, height: 14 }} />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* Rename modal */}
      <AlertDialog.Root open={renameOpen} onOpenChange={setRenameOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="chatListModalOverlay" />
          <AlertDialog.Content className="chatListModal" onOpenAutoFocus={(e) => {
            e.preventDefault();
            setTimeout(() => renameInputRef.current?.select(), 0);
          }}>
            <AlertDialog.Title className="chatListModalTitle">Rename chat</AlertDialog.Title>
            <AlertDialog.Description className="chatListModalDesc">
              Enter a new name for this conversation.
            </AlertDialog.Description>
            <input
              ref={renameInputRef}
              className="chatListModalInput"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
              }}
            />
            <div className="chatListModalActions">
              <AlertDialog.Cancel asChild>
                <button className="chatListModalBtn chatListModalBtn--secondary">Cancel</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button className="chatListModalBtn chatListModalBtn--primary" onClick={commitRename}>
                  Save
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Delete confirmation */}
      <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="chatListModalOverlay" />
          <AlertDialog.Content className="chatListModal">
            <AlertDialog.Title className="chatListModalTitle">Delete chat</AlertDialog.Title>
            <AlertDialog.Description className="chatListModalDesc">
              Are you sure you want to delete &ldquo;{title}&rdquo;? This action cannot be undone.
            </AlertDialog.Description>
            <div className="chatListModalActions">
              <AlertDialog.Cancel asChild>
                <button className="chatListModalBtn chatListModalBtn--secondary">Cancel</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button className="chatListModalBtn chatListModalBtn--danger" onClick={confirmDelete}>
                  Delete
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ThreadListItemPrimitive.Root>
  );
};
