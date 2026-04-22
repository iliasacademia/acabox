import React, { useState, useEffect, useCallback } from 'react';
import {
  useLocalRuntime,
  AssistantRuntimeProvider,
} from '@assistant-ui/react';
import { OverlayThread } from './OverlayThread';
import { useHttpChatAdapter, useHttpHistoryAdapter } from './httpChatAdapter';
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
  sessions: Array<{ id: string; title: string; created_at: string }>;
  onOpenSession: (session: { id: string; title: string; created_at: string }) => void;
  onNewConversation: () => void;
}

export const WorkspaceSessionsView: React.FC<WorkspaceSessionsViewProps> = ({
  sessions,
  onOpenSession,
  onNewConversation,
}) => {
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
      {sessions.length === 0 ? (
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '15px',
          color: '#6d6d7d',
          lineHeight: '1.5',
          padding: '8px 0',
        }}>
          No conversations yet. Start a new one!
        </div>
      ) : (
        <div style={styles.feedbackContent}>
          {sessions.slice(0, 5).map((session) => (
            <button
              key={session.id}
              style={styles.notificationCard}
              onClick={() => onOpenSession(session)}
              aria-label="Open conversation"
            >
              <div style={styles.notificationContent as React.CSSProperties}>
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
        </div>
      )}
    </>
  );
};

// ─── Workspace Conversation View ─────────────────────────────────────

interface WorkspaceConversationViewProps {
  sessionId: string;
  sessionTitle: string;
  documentPath?: string | null;
  selectedText?: string | null;
  onBack: () => void;
}

export const WorkspaceConversationView: React.FC<WorkspaceConversationViewProps> = ({
  sessionId,
  sessionTitle,
  documentPath,
  selectedText: selectedTextProp,
  onBack,
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
  const runtime = useLocalRuntime(chatAdapter, { adapters: { history } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header with back button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '8px', flexShrink: 0 }}>
        <button onClick={onBack} style={styles.backButton} aria-label="Back">
          <ArrowBackIcon />
        </button>
        <span style={styles.sectionHeaderText}>
          {sessionTitle || 'Conversation'}
        </span>
      </div>

      {/* Chat — uses the same Thread component as the desktop app */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <AssistantRuntimeProvider runtime={runtime}>
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
