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
  getSessionCreatedAt,
} from '../../sessionTimestamps';

interface ThreadListProps {
  onSelectThread?: () => void;
}

const SearchQueryContext = createContext('');
const SelectThreadContext = createContext<(() => void) | undefined>(undefined);

// --- Message preview cache & hook ---

interface PreviewData {
  userText: string;
  assistantText: string;
}

const previewCache = new Map<string, PreviewData>();

function useMessagePreview(sessionId: string | undefined): PreviewData | null {
  const [preview, setPreview] = useState<PreviewData | null>(() => {
    if (!sessionId) return null;
    return previewCache.get(sessionId) ?? null;
  });

  useEffect(() => {
    if (!sessionId) return;
    if (previewCache.has(sessionId)) {
      setPreview(previewCache.get(sessionId)!);
      return;
    }

    let cancelled = false;
    window.sessionsAPI.listMessages(sessionId).then((messages) => {
      if (cancelled) return;

      let userText = '';
      let assistantText = '';

      const firstUser = messages.find((m: any) => m.type === 'user');
      if (firstUser) {
        try {
          const parsed = JSON.parse(firstUser.content);
          userText = (typeof parsed.text === 'string' ? parsed.text : firstUser.content)
            .split('\n')[0]
            .slice(0, 120);
        } catch {
          userText = firstUser.content.split('\n')[0].slice(0, 120);
        }
      }

      const firstAssistant = messages.find((m: any) => m.type === 'assistant');
      if (firstAssistant) {
        try {
          const blocks = JSON.parse(firstAssistant.content);
          const textBlock = Array.isArray(blocks)
            ? blocks.find((b: any) => b.type === 'text')
            : null;
          if (textBlock?.text) {
            assistantText = textBlock.text.split('\n')[0].slice(0, 120);
          }
        } catch {
          assistantText = firstAssistant.content.split('\n')[0].slice(0, 120);
        }
      }

      const data = { userText, assistantText };
      previewCache.set(sessionId, data);
      setPreview(data);
    }).catch(() => {
      if (!cancelled) {
        const data = { userText: '', assistantText: '' };
        previewCache.set(sessionId, data);
        setPreview(data);
      }
    });

    return () => { cancelled = true; };
  }, [sessionId]);

  return preview;
}

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
  const date = dateFromSessionStoredAt(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return '1 week ago';
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric' });
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

// --- Main ThreadList ---

export const ThreadList: FC<ThreadListProps> = ({ onSelectThread }) => {
  const [searchQuery, setSearchQuery] = useState('');

  return (
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
                    placeholder="Search your chats..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>

              {/* Items */}
              <div className="chatListItems">
                <StableThreadItems />
              </div>
          </div>
        </ThreadListPrimitive.Root>
      </SelectThreadContext.Provider>
    </SearchQueryContext.Provider>
  );
};

// --- ThreadListItem ---

const ThreadListItem: FC = () => {
  const runtime = useThreadListItemRuntime();
  const searchQuery = useContext(SearchQueryContext);
  const onSelectThread = useContext(SelectThreadContext);

  const remoteId = runtime.getState().remoteId;
  const title = runtime.getState().title ?? 'New Chat';
  const createdAt = getSessionCreatedAt(remoteId);
  const preview = useMessagePreview(remoteId);

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

  // Build preview string: "You: ... · CS: ..."
  const previewText = preview
    ? [
        preview.userText ? `You: ${preview.userText}` : '',
        preview.assistantText ? `CS: ${preview.assistantText}` : '',
      ].filter(Boolean).join(' \u00b7 ')
    : '';

  // Search filtering (after all hooks)
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const titleMatch = title.toLowerCase().includes(q);
    const previewMatch = previewText.toLowerCase().includes(q);
    if (!titleMatch && !previewMatch) return null;
  }

  return (
    <ThreadListItemPrimitive.Root className="chatListItem">
      <div className="chatListItemIcon">
        <MessageSquareIcon style={{ width: 18, height: 18 }} />
      </div>
      <ThreadListItemPrimitive.Trigger
        className="chatListItemTrigger"
        onClick={() => onSelectThread?.()}
      >
        <span className="chatListItemTitle">
          {searchQuery ? highlightMatch(title, searchQuery) : title}
        </span>
        {previewText ? (
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
