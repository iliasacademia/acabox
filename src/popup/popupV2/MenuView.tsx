import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  useLocalRuntime,
  AssistantRuntimeProvider,
  useAuiState,
} from '@assistant-ui/react';
import { OverlayThread, InitialPromptAutoSend } from './OverlayThread';
import { shouldRefreshOnForeignEvent } from './sessionLogic';
import { useHttpChatAdapter, useHttpHistoryAdapter } from './httpChatAdapter';
import { createOverlayAttachmentAdapter } from './overlayAttachmentAdapter';
import '../../cobuilding/renderer/App.css';
import '@assistant-ui/react-markdown/styles/dot.css';
import {
  ConversationItem,
  styles,
  ArrowForwardIcon,
  ArrowBackIcon,
  formatConversationDate,
  serverUrl,
  tokenParam,
} from './shared';

// ─── Conversation List View ─────────────────────────────────────────

interface ConversationListViewProps {
  conversations: ConversationItem[];
  isLoading: boolean;
  onContinueConversation: (conversation: ConversationItem) => void;
}

export const ConversationListView: React.FC<ConversationListViewProps> = ({
  conversations,
  isLoading,
  onContinueConversation,
}) => {
  if (isLoading) {
    return (
      <div style={styles.loadingText}>Loading conversations...</div>
    );
  }

  if (conversations.length === 0) {
    return (
      <>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionHeaderText}>Conversations</span>
        </div>
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '15px',
          color: '#6d6d7d',
          lineHeight: '1.5',
          padding: '8px 0',
        }}>
          No conversations yet for this manuscript. Start one from the sidebar.
        </div>
      </>
    );
  }

  return (
    <>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionHeaderText}>Conversations</span>
      </div>
      <div style={styles.feedbackContent}>
        {conversations.slice(0, 5).map((conversation) => (
          <button
            key={conversation.id}
            style={styles.notificationCard}
            onClick={() => onContinueConversation(conversation)}
            aria-label="Continue conversation"
          >
            <div style={styles.notificationContent as React.CSSProperties}>
              <span style={styles.notificationDate}>
                {formatConversationDate(conversation.created_at)}
              </span>
              <span style={styles.notificationTitle}>
                {conversation.title || conversation.summary || 'Conversation'}
              </span>
            </div>
            <div style={styles.arrowIcon}>
              <ArrowForwardIcon />
            </div>
          </button>
        ))}
      </div>
    </>
  );
};

// ─── Workspace Sessions View ─────────────────────────────────────────

interface WorkspaceSessionsViewProps {
  sessions: Array<{ id: string; title: string; created_at: string; is_running?: boolean }>;
  /** Active document path. Used as a fallback when the server didn't supply a display name (file-based hosts derive basename client-side). */
  documentPath?: string | null;
  /** Server-supplied display name — preferred when set (synthetic-scheme hosts where the path is opaque). */
  documentDisplayName?: string | null;
  onOpenSession: (session: { id: string; title: string; created_at: string; is_running?: boolean }) => void;
  onNewConversation: () => void;
}

/**
 * Derive a human-readable label for the active document. Prefers the server-
 * supplied display name (Google Docs title, Apple Note name, ...) and falls
 * back to the basename of a real file path (Word .docx, Obsidian .md). Returns
 * null when there's nothing meaningful to show (synthetic path with no title,
 * empty path, etc.).
 */
export function effectiveDocDisplayName(documentDisplayName?: string | null, documentPath?: string | null): string | null {
  if (documentDisplayName && documentDisplayName.trim()) return documentDisplayName.trim();
  if (!documentPath) return null;
  // Synthetic schemes (gdocs://, applenotes://) are opaque without the server hint — nothing to derive.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(documentPath) && !documentPath.startsWith('file://')) return null;
  const cleaned = documentPath.startsWith('file://') ? decodeURIComponent(documentPath.slice(7)) : documentPath;
  const lastSlash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return cleaned.slice(lastSlash + 1) || null;
}

const SESSIONS_PAGE_SIZE = 20;

export const WorkspaceSessionsView: React.FC<WorkspaceSessionsViewProps> = ({
  sessions,
  documentPath,
  documentDisplayName,
  onOpenSession,
  onNewConversation,
}) => {
  const [visibleCount, setVisibleCount] = useState(SESSIONS_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const effectiveCount = Math.min(visibleCount, sessions.length);
  const hasMore = effectiveCount < sessions.length;

  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => c + SESSIONS_PAGE_SIZE);
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, effectiveCount]);

  const visibleSessions = sessions.slice(0, effectiveCount);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '12px' }}>
        <span style={styles.sectionHeaderText}>Conversations</span>
        <button
          onClick={onNewConversation}
          style={{
            ...styles.actionButton,
            width: 'auto',
            padding: '4px 12px',
            gap: '4px',
          }}
          aria-label="New conversation"
        >
          <span style={{ fontSize: '16px', lineHeight: '20px' }}>+</span>
          <span style={styles.buttonText}>New</span>
        </button>
      </div>
      <div style={styles.feedbackContent}>
          {visibleSessions.map((session) => (
            <button
              key={session.id}
              style={styles.notificationCard}
              onClick={() => onOpenSession(session)}
              aria-label="Open conversation"
            >
              <div style={{ ...styles.notificationContent as React.CSSProperties, position: 'relative' }}>
                {session.is_running && (
                  <span style={{
                    position: 'absolute',
                    top: 4,
                    left: -12,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#3b82f6',
                    animation: 'chatListPulse 1.5s ease-in-out infinite',
                  }} />
                )}
                <span style={styles.notificationDate}>
                  {formatConversationDate(session.created_at)}
                </span>
                <span style={styles.notificationTitle}>
                  {session.title || 'Conversation'}
                </span>
              </div>
              <div style={styles.arrowIcon}>
                <ArrowForwardIcon />
              </div>
            </button>
          ))}
          {hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
        </div>
    </>
  );
};

// ─── Workspace Conversation View ─────────────────────────────────────

interface WorkspaceConversationViewProps {
  sessionId: string;
  sessionTitle: string;
  documentPath?: string | null;
  /** Server-supplied display name for the active doc — used in the header for synthetic-scheme hosts. */
  documentDisplayName?: string | null;
  selectedText?: string | null;
  onBack: () => void;
  /**
   * Hide the back button when there's no sessions list to return to (i.e. the
   * empty-workspace auto-opened chat). Without this, pressing back just loops
   * back into a fresh blank chat.
   */
  canGoBack?: boolean;
  /**
   * Prompt to programmatically send into the composer once the chat is mounted.
   * Used by the Writing-Agent flow to start the conversation with a kickoff
   * message already sent — no manual typing required.
   */
  initialPrompt?: string;
  /** Called once after the initial prompt has been auto-sent (or attempted). */
  onInitialPromptSent?: () => void;
}

/**
 * Outer wrapper that owns a refresh counter for cross-surface chat sync.
 *
 * When a turn completes in the desktop chat panel (or any other surface
 * driving this session), the server's chat-event SSE channel emits a
 * `done` frame to /api/cobuilding/sessions/:id/events. The Inner
 * component's `<ForeignTurnWatcher>` listens for it and bumps the
 * counter — which, via the inner's `key`, forces a fresh runtime mount
 * so `history.load()` re-fetches the conversation. We suppress the bump
 * for OUR own turns (where `s.thread.isRunning` is true at the moment of
 * the `done` event) to avoid a flash on every send.
 */
export const WorkspaceConversationView: React.FC<WorkspaceConversationViewProps> = (props) => {
  const [refreshCounter, setRefreshCounter] = useState(0);
  return (
    <WorkspaceConversationViewInner
      key={`${props.sessionId}-${refreshCounter}`}
      {...props}
      onForeignTurnDone={() => setRefreshCounter((c) => c + 1)}
    />
  );
};

const WorkspaceConversationViewInner: React.FC<WorkspaceConversationViewProps & { onForeignTurnDone: () => void }> = ({
  sessionId,
  sessionTitle,
  documentPath,
  documentDisplayName,
  selectedText: selectedTextProp,
  onBack,
  canGoBack = true,
  onForeignTurnDone,
  initialPrompt,
  onInitialPromptSent,
}) => {
  // Local selected text state — syncs from prop, can be dismissed with X
  const [localSelectedText, setLocalSelectedText] = useState<string | null>(selectedTextProp ?? null);
  const [selectionDismissed, setSelectionDismissed] = useState(false);

  useEffect(() => {
    if (selectedTextProp) {
      setLocalSelectedText(selectedTextProp);
      setSelectionDismissed(false);
    } else if (!selectionDismissed) {
      setLocalSelectedText(null);
    }
  }, [selectedTextProp]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSelectedText = selectionDismissed ? null : localSelectedText;

  const getContext = useCallback(() => ({
    documentPath,
    selectedText: activeSelectedText,
  }), [documentPath, activeSelectedText]);

  const chatAdapter = useHttpChatAdapter({
    serverUrl,
    token: tokenParam,
    sessionId,
    getContext,
  });

  const history = useHttpHistoryAdapter(serverUrl, tokenParam, sessionId);
  const attachments = useMemo(() => createOverlayAttachmentAdapter(), []);
  const runtime = useLocalRuntime(chatAdapter, { adapters: { history, attachments } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Document title bar is rendered at the modal level (sibling of the
          title bar) so it can span full overlay width — see AcademiaNotificationsPopupV2. */}
      {/* Header with back button + conversation title (hidden when canGoBack is false) */}
      {canGoBack && (
        <div className="overlayChatHeader" style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingBottom: '8px', flexShrink: 0 }}>
          <button onClick={onBack} style={styles.backButton} aria-label="Back">
            <ArrowBackIcon />
          </button>
          <span
            style={{ ...styles.sectionHeaderText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
            title={sessionTitle || 'Conversation'}
          >
            {sessionTitle || 'Conversation'}
          </span>
        </div>
      )}

      {/* Chat — uses the same Thread component as the desktop app */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <AssistantRuntimeProvider runtime={runtime}>
          <ForeignTurnWatcher sessionId={sessionId} onForeignDone={onForeignTurnDone} />
          <InitialPromptAutoSend prompt={initialPrompt} onSent={onInitialPromptSent} />
          <OverlayThread
            documentPath={documentPath}
            selectedText={activeSelectedText}
            onDismissSelection={() => { setSelectionDismissed(true); setLocalSelectedText(null); }}
          />
        </AssistantRuntimeProvider>
      </div>
    </div>
  );
};

/**
 * Subscribes to /api/cobuilding/sessions/:id/events and signals the parent
 * when a turn that wasn't initiated locally finishes — e.g. the user sent
 * a message from the desktop chat panel and the agent's response landed
 * in the database. Our own turns are filtered out by checking the runtime
 * state at the moment of the `done` event: if `s.thread.isRunning` is
 * true, the in-flight /send SSE response is already streaming the result
 * into our runtime, so a remount would just cause a needless flash.
 *
 * Note: only fires on `done`. Refreshing on intermediate `event` ticks
 * makes the conversation flicker (each refresh remounts the message list),
 * so live in-progress tool-call rendering for foreign turns is sacrificed
 * for a stable view. The user sees their first message immediately, then
 * the full agent response when the turn completes. Replace this with a
 * runtime-push mechanism if live progress without remount is needed.
 */
const ForeignTurnWatcher: React.FC<{ sessionId: string; onForeignDone: () => void }> = ({ sessionId, onForeignDone }) => {
  const isRunning = useAuiState((s: any) => s.thread.isRunning);
  // Stable refs so the EventSource isn't torn down on every isRunning flip.
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const onForeignDoneRef = useRef(onForeignDone);
  onForeignDoneRef.current = onForeignDone;

  useEffect(() => {
    if (!sessionId || !serverUrl) return;
    const tokenQs = tokenParam ? `?token=${encodeURIComponent(tokenParam)}` : '';
    const es = new EventSource(`${serverUrl}/api/cobuilding/sessions/${sessionId}/events${tokenQs}`);
    const handleDone = () => {
      if (shouldRefreshOnForeignEvent('done', null, isRunningRef.current)) {
        onForeignDoneRef.current();
      }
    };
    // Foreign user-message: a message just landed in DB from another
    // surface. Refresh so the user turn shows up immediately, before
    // the assistant streams its reply.
    const handleEvent = (e: MessageEvent) => {
      let data: unknown = null;
      try { data = JSON.parse(e.data); } catch { /* malformed — ignore */ }
      if (shouldRefreshOnForeignEvent('event', data, isRunningRef.current)) {
        onForeignDoneRef.current();
      }
    };
    es.addEventListener('done', handleDone);
    es.addEventListener('event', handleEvent);
    return () => {
      es.removeEventListener('done', handleDone);
      es.removeEventListener('event', handleEvent);
      es.close();
    };
  }, [sessionId]);

  return null;
};

// ─── Not Linked View ─────────────────────────────────────────────────

interface NotLinkedViewProps {
  isUnsavedDocument: boolean;
}

export const NotLinkedView: React.FC<NotLinkedViewProps> = ({
  isUnsavedDocument,
}) => {
  return (
    <>
      {isUnsavedDocument ? (
        <>
          <div style={styles.enableFeedbackTitle}>
            Save your document first
          </div>
          <div style={styles.enableFeedbackDescription}>
            Please save your document to get started.
          </div>
        </>
      ) : (
        <>
          <div style={styles.enableFeedbackTitle}>
            Not linked to a project
          </div>
          <div style={styles.enableFeedbackDescription}>
            This document isn't linked to a Writing Agent project yet. Create a project in Writing Agent to start working on this manuscript.
          </div>
        </>
      )}
    </>
  );
};
