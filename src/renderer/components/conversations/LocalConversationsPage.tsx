import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConversationMessage } from '../../../../packages/shared-conversations/src/components/ConversationMessage';
import { Message } from '../../../../packages/shared-conversations/src/types/conversation';
import { IPC_CHANNELS } from '../../../shared/types';
import '../../../../packages/shared-conversations/src/styles/conversations.css';

interface LocalConversationsPageProps {
  onSwitchToRegularMode: () => void;
}

export function LocalConversationsPage({ onSwitchToRegularMode }: LocalConversationsPageProps) {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isAwaitingResponse, setIsAwaitingResponse] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationIdRef = useRef<number | null>(null);

  // Keep ref in sync with state for use in event handlers
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

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
      }

      // Fetch updated messages
      window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_GET_CONVERSATION,
        conversationIdRef.current
      ).then((result: any) => {
        if (result?.messages) {
          setMessages(result.messages.filter((m: Message) => m.role !== 'tool'));
        }
      });
    };

    window.electronAPI.on(IPC_CHANNELS.LOCAL_AGENT_STREAM_UPDATE, handleStreamUpdate);
    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.LOCAL_AGENT_STREAM_UPDATE, handleStreamUpdate);
    };
  }, []);

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
          { content, agent_name: 'local' }
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
  }, [inputValue, isSending]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e as unknown as React.FormEvent);
    }
  }, [handleSend]);

  return (
    <div className="conversationsPage">
      {/* Top Bar */}
      <div className="conversationsTopBar">
        <div className="topBarLeft">
          <h2 className="docName">
            <span className="docNameText">Local Mode</span>
          </h2>
        </div>
        <div className="topBarRight">
          <button className="secondaryButton" onClick={onSwitchToRegularMode}>
            Switch to regular mode
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="localConversationBody">
        {/* Messages */}
        <div className="conversationMessages" ref={messagesContainerRef}>
          {messages.length === 0 && !isSending ? (
            <div className="noMessages">
              <p>No messages yet. Start the conversation below!</p>
            </div>
          ) : (
            messages.map((msg) => (
              <ConversationMessage
                key={msg.id}
                message={msg}
                hideContexts
              />
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
  );
}
