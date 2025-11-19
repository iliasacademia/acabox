import React, { useState, useEffect, useRef } from 'react';
import { Message, createMessage, Conversation } from '../../services/conversationsApi';
import { useConversationPolling } from '../../hooks/useConversationPolling';
import { ConversationMessage } from './ConversationMessage';
import { ToolMessageAccordion } from './ToolMessageAccordion';
import { DateDivider } from './DateDivider';
import { formatConversationTitle } from './utils';

interface ConversationDetailProps {
  conversation: Conversation | null;
  projectId: number;
  onConversationUpdate?: () => void;
}

export function ConversationDetail({
  conversation,
  projectId,
  onConversationUpdate,
}: ConversationDetailProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const { messages, isPolling, isLoading, error, startPolling, stopPolling, refetch } =
    useConversationPolling();

  // Start polling when conversation changes
  useEffect(() => {
    if (conversation) {
      startPolling(conversation.id, projectId);
    } else {
      stopPolling();
    }

    return () => {
      stopPolling();
    };
  }, [conversation?.id, projectId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!conversation || !inputValue.trim() || isSending) return;

    const content = inputValue.trim();
    setInputValue('');
    setIsSending(true);
    setSendError(null);

    try {
      // Send message (optimistic UI handled by re-fetch)
      await createMessage(conversation.id, content, projectId);

      // Immediately refetch to show user's message
      await refetch();

      // Notify parent to update conversation list
      onConversationUpdate?.();

      // Restart polling to get AI response
      startPolling(conversation.id, projectId);
    } catch (err: any) {
      console.error('Failed to send message:', err);
      setSendError(err.message || 'Failed to send message. Please try again.');
      // Restore input value on error
      setInputValue(content);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(e as any);
    }
  };

  // Helper function to format date for grouping
  const getDateString = (timestamp: string): string => {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Reset time parts for comparison
    const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const yesterdayOnly = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());

    if (dateOnly.getTime() === todayOnly.getTime()) {
      return 'Today';
    } else if (dateOnly.getTime() === yesterdayOnly.getTime()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
  };

  // Group consecutive tool messages and add date dividers
  const groupedMessages: Array<{ type: 'message' | 'toolGroup' | 'dateDivider'; data: any }> = [];
  let currentToolGroup: Message[] = [];
  let lastDateString: string | null = null;

  messages.forEach((message, index) => {
    const messageDateString = getDateString(message.created_at);

    if (message.role === 'tool') {
      currentToolGroup.push(message);
    } else {
      // Check if we need a date divider
      if (messageDateString !== lastDateString) {
        // Flush any pending tool group first
        if (currentToolGroup.length > 0) {
          groupedMessages.push({
            type: 'toolGroup',
            data: currentToolGroup,
          });
          currentToolGroup = [];
        }

        // Add date divider
        groupedMessages.push({
          type: 'dateDivider',
          data: messageDateString,
        });
        lastDateString = messageDateString;
      }

      // If we have accumulated tool messages, add them as a group
      if (currentToolGroup.length > 0) {
        groupedMessages.push({
          type: 'toolGroup',
          data: currentToolGroup,
        });
        currentToolGroup = [];
      }

      // Add the regular message
      groupedMessages.push({
        type: 'message',
        data: message,
      });
    }
  });

  // Don't forget remaining tool messages
  if (currentToolGroup.length > 0) {
    groupedMessages.push({
      type: 'toolGroup',
      data: currentToolGroup,
    });
  }

  if (!conversation) {
    return (
      <div className="conversationDetail empty">
        <div className="emptyState">
          <div className="emptyStateIcon">💬</div>
          <h3>No conversation selected</h3>
          <p>Select a conversation from the sidebar or create a new one.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="conversationDetail">
      {/* Header */}
      <div className="conversationHeader">
        <div className="conversationHeaderContent">
          <h2 className="conversationTitle">
            {conversation.title ? formatConversationTitle(conversation.title, conversation.created_at) : 'New Conversation'}
          </h2>
          {conversation.summary && (
            <p className="conversationSummary">{conversation.summary}</p>
          )}
        </div>
        {isPolling && (
          <div className="pollingIndicator">
            <span className="pollingDot"></span>
            <span className="pollingText">AI is thinking...</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="conversationMessages" ref={messagesContainerRef}>
        {error && (
          <div className="conversationError">
            <span className="errorIcon">⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {isLoading && groupedMessages.length === 0 ? (
          <div className="noMessages">
            <p>Loading messages...</p>
          </div>
        ) : groupedMessages.length === 0 ? (
          <div className="noMessages">
            <p>No messages yet. Start the conversation below!</p>
          </div>
        ) : (
          <>
            {groupedMessages.map((item, index) => (
              <React.Fragment key={index}>
                {item.type === 'message' ? (
                  <ConversationMessage message={item.data} />
                ) : item.type === 'toolGroup' ? (
                  <ToolMessageAccordion messages={item.data} />
                ) : (
                  <DateDivider date={item.data} />
                )}
              </React.Fragment>
            ))}
          </>
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

        <form onSubmit={handleSendMessage}>
          <div className="inputWrapper">
            <textarea
              className="messageInput"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Reply or ask anything..."
              rows={3}
              disabled={isSending}
            />
            <button
              type="submit"
              className="sendButton"
              disabled={!inputValue.trim() || isSending}
              aria-label={isSending ? 'Sending...' : 'Send message'}
            >
              <span className="sendIcon">➤</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
