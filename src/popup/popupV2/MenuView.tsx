import React, { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ConversationItem,
  styles,
  ArrowForwardIcon,
  ArrowBackIcon,
  LoadingSpinner,
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

interface ParsedMessage {
  id: number;
  type: string;
  content: unknown;
  created_at: string;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if ('text' in content && typeof (content as any).text === 'string') return (content as any).text;
    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
    }
  }
  return '';
}

/** Strip context blocks prepended by the backend (legacy <context> tags). */
function stripContext(text: string): string {
  return text.replace(/^<context>[\s\S]*?<\/context>\s*/, '');
}

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
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingStatus, setStreamingStatus] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Local selected text state — syncs from prop, can be dismissed with X
  const [localSelectedText, setLocalSelectedText] = useState<string | null>(selectedTextProp ?? null);
  const [selectionDismissed, setSelectionDismissed] = useState(false);

  // When the prop changes (new selection in Word), update local state
  useEffect(() => {
    if (selectedTextProp) {
      setLocalSelectedText(selectedTextProp);
      setSelectionDismissed(false); // new selection overrides dismissal
    } else if (!selectionDismissed) {
      setLocalSelectedText(null);
    }
  }, [selectedTextProp]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSelectedText = selectionDismissed ? null : localSelectedText;

  // Fetch messages on mount
  useEffect(() => {
    const headers: Record<string, string> = {};
    if (tokenParam) headers['Authorization'] = `Bearer ${tokenParam}`;
    fetch(`${serverUrl}/api/cobuilding/sessions/${sessionId}/messages`, { headers })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.messages) setMessages(data.messages);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId]);

  // Auto-scroll to bottom
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamingText, streamingStatus]);

  const handleSend = () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    setStreamingText('');

    // Capture selection before clearing the pill
    const sentSelection = activeSelectedText;

    // Clear the selection pill after sending — context was consumed
    setSelectionDismissed(true);
    setLocalSelectedText(null);

    // Build displayed message: selection quote + user instruction
    const displayText = sentSelection
      ? `"${sentSelection}"\n\n${text}`
      : text;

    // Optimistically add user message
    const userMsg: ParsedMessage = {
      id: Date.now(),
      type: 'user',
      content: { text: displayText },
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenParam) headers['Authorization'] = `Bearer ${tokenParam}`;

    fetch(`${serverUrl}/api/cobuilding/sessions/${sessionId}/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text,
        ...(documentPath ? { documentPath } : {}),
        ...(activeSelectedText ? { selectedText: activeSelectedText } : {}),
      }),
    }).then(response => {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      function processEvents(chunk: string) {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const eventMatch = part.match(/^event: (\w+)\ndata: (.+)$/s);
          if (!eventMatch) continue;
          const [, eventType, dataStr] = eventMatch;
          try {
            const data = JSON.parse(dataStr);
            if (eventType === 'event') {
              if (data.type === 'text-delta') {
                accumulated += data.text;
                setStreamingText(accumulated);
                setStreamingStatus('');
              } else if (data.type === 'text') {
                accumulated = data.text;
                setStreamingText(accumulated);
                setStreamingStatus('');
              } else if (data.type === 'tool-call-start') {
                setStreamingStatus(`Using ${data.toolName}...`);
              } else if (data.type === 'tool-result') {
                setStreamingStatus('');
              }
            } else if (eventType === 'done') {
              if (accumulated) {
                setMessages(prev => [...prev, {
                  id: Date.now(),
                  type: 'assistant',
                  content: [{ type: 'text', text: accumulated }],
                  created_at: new Date().toISOString(),
                }]);
              }
              setStreamingText('');
              setStreamingStatus('');
              setSending(false);
            } else if (eventType === 'error') {
              setStreamingText('');
              setStreamingStatus('');
              setSending(false);
            }
          } catch { /* skip malformed */ }
        }
      }

      function read(): Promise<void> {
        if (!reader) { setSending(false); return Promise.resolve(); }
        return reader.read().then(({ done, value }) => {
          if (done) { setSending(false); return; }
          processEvents(decoder.decode(value, { stream: true }));
          return read();
        });
      }

      return read();
    }).catch(() => setSending(false));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Show user messages, assistant text, and tool activity
  const displayMessages = messages.filter(m =>
    m.type === 'user' || m.type === 'assistant' || m.type === 'tool_result'
  );

  function extractToolNames(content: unknown): string[] {
    if (!Array.isArray(content)) return [];
    return content
      .filter((b: any) => b.type === 'tool_use' && b.name)
      .map((b: any) => b.name);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '12px', flexShrink: 0 }}>
        <button onClick={onBack} style={styles.backButton} aria-label="Back">
          <ArrowBackIcon />
        </button>
        <span style={styles.sectionHeaderText}>
          {sessionTitle || 'Conversation'}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: '4px' }}>
        {loading ? (
          <div style={styles.loadingText}>Loading...</div>
        ) : displayMessages.length === 0 && !streamingText ? (
          <div style={{ ...styles.loadingText, color: '#6d6d7d' }}>No messages yet.</div>
        ) : (
          <>
            {displayMessages.map(msg => {
              const rawText = extractText(msg.content);
              const isUser = msg.type === 'user';
              const text = isUser ? stripContext(rawText) : rawText;

              // Tool result — show as compact status line
              if (msg.type === 'tool_result') {
                return null; // tool results are shown inline with assistant tool calls
              }

              // Assistant message with tool calls but no text — show tool names
              if (msg.type === 'assistant' && !text) {
                const toolNames = extractToolNames(msg.content);
                if (toolNames.length === 0) return null;
                return (
                  <div key={msg.id} style={{ marginBottom: '8px', ...styles.assistantMessage }}>
                    <div style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: '13px',
                      color: '#6d6d7d',
                      fontStyle: 'italic',
                      padding: '4px 0',
                    }}>
                      Used: {toolNames.join(', ')}
                    </div>
                  </div>
                );
              }

              if (!text) return null;
              return (
                <div key={msg.id} style={{ marginBottom: '12px', ...(isUser ? styles.userMessage : styles.assistantMessage) }}>
                  {isUser ? (
                    <div style={styles.userMessageContent}>{text}</div>
                  ) : (
                    <div className="markdown-content" style={styles.reviewStatusContent}>
                      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
                    </div>
                  )}
                </div>
              );
            })}
            {streamingStatus && !streamingText && (
              <div style={{ marginBottom: '8px', ...styles.assistantMessage }}>
                <div style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '13px',
                  color: '#6d6d7d',
                  fontStyle: 'italic',
                  padding: '4px 0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}>
                  <LoadingSpinner /> {streamingStatus}
                </div>
              </div>
            )}
            {streamingText && (
              <div style={{ marginBottom: '12px', ...styles.assistantMessage }}>
                <div className="markdown-content" style={styles.reviewStatusContent}>
                  <Markdown remarkPlugins={[remarkGfm]}>{streamingText}</Markdown>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Context chips + Input */}
      <div style={{
        paddingTop: '12px',
        borderTop: '1px solid #e0ddd4',
        flexShrink: 0,
      }}>
        {/* Context indicators */}
        {(documentPath || activeSelectedText) && (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            marginBottom: '8px',
          }}>
            {documentPath && (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                backgroundColor: '#EEF2F9',
                borderRadius: '6px',
                padding: '3px 8px',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '12px',
                color: '#3d5a80',
                maxWidth: '100%',
              }}>
                <span style={{ flexShrink: 0 }}>📄</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {documentPath.split('/').pop()}
                </span>
              </div>
            )}
            {activeSelectedText && (
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '4px',
                backgroundColor: '#F0EBF8',
                borderRadius: '6px',
                padding: '4px 8px',
                maxWidth: '100%',
              }}>
                <div style={{
                  flex: 1,
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '12px',
                  color: '#5B4A8A',
                  lineHeight: '1.4',
                  maxHeight: '60px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {activeSelectedText}
                </div>
                <button
                  onClick={() => { setSelectionDismissed(true); setLocalSelectedText(null); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '14px',
                    lineHeight: '1',
                    color: '#5B4A8A',
                    flexShrink: 0,
                  }}
                  aria-label="Clear selection"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeSelectedText ? 'Ask about selection...' : documentPath ? 'Ask about this document...' : 'Type a message...'}
            disabled={sending}
            rows={1}
            style={{
              flex: 1,
              resize: 'none',
              border: '1px solid #ccc9bc',
              borderRadius: '8px',
              padding: '8px 12px',
              fontFamily: "'DM Sans', sans-serif",
              fontSize: '14px',
              lineHeight: '20px',
              outline: 'none',
              minHeight: '36px',
              maxHeight: '100px',
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            style={{
              ...styles.arrowButton,
              opacity: (!input.trim() || sending) ? 0.4 : 1,
              cursor: (!input.trim() || sending) ? 'not-allowed' : 'pointer',
            }}
            aria-label="Send"
          >
            {sending ? <LoadingSpinner /> : <ArrowForwardIcon />}
          </button>
        </div>
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
