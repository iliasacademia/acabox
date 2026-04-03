import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ConversationMessage } from '../../../../packages/shared-conversations/src/components/ConversationMessage';
import { ToolMessageAccordion } from '../../../../packages/shared-conversations/src/components/ToolMessageAccordion';
import { Message } from '../../../../packages/shared-conversations/src/types/conversation';
import { IPC_CHANNELS } from '../../../shared/types';
import '../../../../packages/shared-conversations/src/styles/conversations.css';

interface ConversationSummary {
  id: number;
  title: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface LocalConversationsPageProps {
  onSwitchToRegularMode: () => void;
  manuscriptFilePath?: string | null;
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function LocalConversationsPage({ onSwitchToRegularMode, manuscriptFilePath }: LocalConversationsPageProps) {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isAwaitingResponse, setIsAwaitingResponse] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Conversation history sidebar state
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationIdRef = useRef<number | null>(null);

  // Keep ref in sync with state for use in event handlers
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Load conversation history on mount
  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      setConversationsLoading(true);
      const result = await window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_LIST_CONVERSATIONS,
        { offset: 0, limit: 50, archived: false }
      );
      setConversations(result.conversations || []);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  const handleSelectConversation = useCallback(async (id: number) => {
    try {
      const result = await window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_GET_CONVERSATION,
        id
      );
      if (result) {
        setConversationId(id);
        setMessages(result.messages || []);
        setSendError(null);
        setIsAwaitingResponse(false);
      }
    } catch (err) {
      console.error('Failed to load conversation:', err);
    }
  }, []);

  const handleNewConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setSendError(null);
    setIsAwaitingResponse(false);
    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, []);

  const handleArchiveConversation = useCallback(async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_ARCHIVE_CONVERSATION,
        id
      );
      setConversations(prev => prev.filter(c => c.id !== id));
      if (conversationIdRef.current === id) {
        handleNewConversation();
      }
    } catch (err) {
      console.error('Failed to archive conversation:', err);
    }
  }, [handleNewConversation]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAwaitingResponse]);

  // Listen for stream updates
  useEffect(() => {
    const handleStreamUpdate = (_event: unknown, data: any) => {
      if (!conversationIdRef.current || data.conversation_id !== conversationIdRef.current) return;

      if (data.is_final) {
        setIsAwaitingResponse(false);
        // Refresh the sidebar to show updated title
        loadConversations();
      }

      // Fetch updated messages
      window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_GET_CONVERSATION,
        conversationIdRef.current
      ).then((result: any) => {
        if (result?.messages) {
          setMessages(result.messages);
        }
      });
    };

    window.electronAPI.on(IPC_CHANNELS.LOCAL_AGENT_STREAM_UPDATE, handleStreamUpdate);
    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.LOCAL_AGENT_STREAM_UPDATE, handleStreamUpdate);
    };
  }, [loadConversations]);

  const handleSend = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const content = inputValue.trim();
    if (!content || isSending) return;

    setSendError(null);
    setIsSending(true);
    setInputValue('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      if (!conversationIdRef.current) {
        // First message — create conversation
        const result = await window.electronAPI.invoke(
          IPC_CHANNELS.LOCAL_AGENT_CREATE_CONVERSATION,
          { content, agent_name: 'local', manuscript_file_path: manuscriptFilePath || undefined }
        );
        const newId = result.conversation.id;
        setConversationId(newId);
        // Add optimistic user message
        setMessages([{
          id: Date.now(),
          role: 'user',
          content,
          data: null,
          created_at: new Date().toISOString(),
          contexts: [],
        }]);
        setIsAwaitingResponse(true);
        // Refresh sidebar to show the new conversation
        loadConversations();
      } else {
        // Subsequent messages
        setMessages(prev => [...prev, {
          id: Date.now(),
          role: 'user',
          content,
          data: null,
          created_at: new Date().toISOString(),
          contexts: [],
        }]);
        setIsAwaitingResponse(true);
        await window.electronAPI.invoke(
          IPC_CHANNELS.LOCAL_AGENT_SEND_MESSAGE,
          { conversation_id: conversationIdRef.current, content }
        );
      }
    } catch (err: any) {
      setSendError(err.message || 'Failed to send message');
      setIsAwaitingResponse(false);
    } finally {
      setIsSending(false);
    }
  }, [inputValue, isSending, manuscriptFilePath, loadConversations]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e as unknown as React.FormEvent);
    }
  }, [handleSend]);

  // Group consecutive tool messages for accordion display
  const groupedMessages = useMemo(() => {
    const groups: Array<{ type: 'message' | 'toolGroup'; data: Message | Message[] }> = [];
    let currentToolGroup: Message[] = [];

    messages.forEach((message) => {
      if (message.role === 'tool') {
        currentToolGroup.push(message);
      } else {
        if (currentToolGroup.length > 0) {
          groups.push({ type: 'toolGroup', data: currentToolGroup });
          currentToolGroup = [];
        }
        groups.push({ type: 'message', data: message });
      }
    });

    if (currentToolGroup.length > 0) {
      groups.push({ type: 'toolGroup', data: currentToolGroup });
    }

    return groups;
  }, [messages]);

  return (
    <div className="conversationsPage">
      {/* Top Bar */}
      <div className="conversationsTopBar">
        <div className="topBarLeft">
          <h2 className="docName">
            <span className="docNameText">Local Mode{manuscriptFilePath ? ` — ${manuscriptFilePath.split('/').pop()}` : ''}</span>
          </h2>
        </div>
        <div className="topBarRight">
          <button className="secondaryButton" onClick={onSwitchToRegularMode}>
            Switch to regular mode
          </button>
        </div>
      </div>

      {/* Main Content with Sidebar */}
      <div className="localConversationLayout">
        {/* Sidebar — conversation history */}
        <div className="localConversationSidebar">
          <div className="localSidebarHeader">
            <span className="localSidebarTitle">History</span>
            <button className="localNewChatButton" onClick={handleNewConversation} title="New conversation">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
          <div className="conversationsList">
            {conversationsLoading ? (
              <div className="sidebarLoading">
                <div className="loadingSpinner" />
              </div>
            ) : conversations.length === 0 ? (
              <div className="localSidebarEmpty">
                <p>No conversations yet</p>
              </div>
            ) : (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  className={`conversationItem${conv.id === conversationId ? ' selected' : ''}`}
                  onClick={() => handleSelectConversation(conv.id)}
                >
                  <h4 className="conversationItemTitle">
                    {conv.title || 'Untitled'}
                  </h4>
                  <span className="conversationItemDate">
                    {formatRelativeDate(conv.updated_at || conv.created_at)}
                  </span>
                  <button
                    className="conversationMenuButton"
                    onClick={(e) => handleArchiveConversation(conv.id, e)}
                    title="Archive conversation"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M2 4h12M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6.5 7v4M9.5 7v4M3 4h10l-.867 8.68A2 2 0 0110.14 14H5.86a2 2 0 01-1.993-1.32L3 4z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Chat area */}
        <div className="localConversationBody">
          {/* Messages */}
          <div className="conversationMessages" ref={messagesContainerRef}>
            {groupedMessages.length === 0 && !isSending ? (
              <div className="noMessages">
                <p>No messages yet. Start the conversation below!</p>
              </div>
            ) : (
              groupedMessages.map((item, index) => (
                item.type === 'message' ? (
                  <ConversationMessage
                    key={(item.data as Message).id}
                    message={item.data as Message}
                    hideContexts
                  />
                ) : (
                  <ToolMessageAccordion
                    key={`tool-group-${index}`}
                    messages={item.data as Message[]}
                  />
                )
              ))
            )}

            {/* Loading indicator */}
            {isAwaitingResponse && (
              <div className="conversationMessage assistant">
                <div className="messageContent">
                  <div className="messageLoading">
                    <span className="loadingDot"></span>
                    <span className="loadingDot"></span>
                    <span className="loadingDot"></span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="conversationInput">
            {sendError && (
              <div className="sendError">
                <span className="errorIcon">⚠️</span>
                <span>{sendError}</span>
              </div>
            )}

            <form onSubmit={handleSend}>
              <div className="inputWrapper">
                <div className={`messageInputContainer${isSending ? ' disabled' : ''}`}>
                  <textarea
                    ref={textareaRef}
                    className="messageInput"
                    value={inputValue}
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      const el = e.target;
                      el.style.height = 'auto';
                      el.style.height = `${el.scrollHeight}px`;
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything..."
                    rows={1}
                    disabled={isSending}
                  />
                  <div className="inputToolbar">
                    <div className="inputToolbarLeft" />
                    <button
                      type="submit"
                      className="sendButton"
                      disabled={!inputValue.trim() || isSending}
                      aria-label={isSending ? 'Sending...' : 'Send message'}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 12V4M4 8l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
