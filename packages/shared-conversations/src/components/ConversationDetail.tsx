import React, { useState, useEffect, useRef } from 'react';
import { Message, Conversation, DraftConversation } from '../types/conversation';
import { ProjectFile, DiffResponse } from '../types/project';
import { useConversationsApi } from '../api/useConversationsApi';
import { useProjectsApi } from '../api/useProjectsApi';
import { useConversationPolling } from '../hooks/useConversationPolling';
import { useApiClient } from '../context/ApiContext';
import { ConversationMessage } from './ConversationMessage';
import { ToolMessageAccordion } from './ToolMessageAccordion';
import DiffModal from './DiffModal';

interface ConversationDetailProps {
  conversation: Conversation | DraftConversation | null;
  projectId: number;
  primaryManuscriptId?: number;
  manuscriptFile?: ProjectFile | null;
  onConversationCreated?: (conversation: Conversation) => void;
  onConversationUpdate?: () => void;
  isReviewInProgress?: boolean;
  /** Optional: Called when a message is sent (for analytics) */
  onMessageSent?: (projectId: number, conversationId: number, agentName: string) => void;
  /** Optional: Called when an assistant message is received (for analytics) */
  onMessageReceived?: (projectId: number, conversationId: number, agentName: string, durationSeconds?: number) => void;
  /** Optional: URL for feedback form. If provided, shows a feedback link. */
  feedbackFormUrl?: string;
}

export function ConversationDetail({
  conversation,
  projectId,
  primaryManuscriptId,
  // manuscriptFile,
  onConversationCreated,
  onConversationUpdate,
  isReviewInProgress,
  onMessageSent,
  onMessageReceived,
  feedbackFormUrl,
}: ConversationDetailProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isInitialLoad = useRef(true);
  const previousMessageCount = useRef(0);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastTrackedAssistantMessageId = useRef<number | null>(null);
  const lastTrackedConversationId = useRef<number | null>(null);
  const conversationViewedAt = useRef<Date | null>(null);
  const lastUserMessageTime = useRef<Date | null>(null);

  const apiClient = useApiClient();
  const { createConversation, createMessage } = useConversationsApi();
  const { getFileDiff } = useProjectsApi();

  // Open feedback form in browser with conversation ID prefilled
  const handleOpenFeedback = () => {
    if (!conversation || isDraft(conversation) || !feedbackFormUrl) return;
    const conversationId = encodeURIComponent(String(conversation.id));
    const formUrl = `${feedbackFormUrl}?usp=pp_url&entry.744362453=${conversationId}`;

    if (apiClient.openExternalUrl) {
      apiClient.openExternalUrl(formUrl);
    } else {
      // Fallback for web: open in new tab
      window.open(formUrl, '_blank');
    }
  };

  // Fetch diff when Show Diff is clicked
  const handleShowDiff = async () => {
    if (!primaryManuscriptId) {
      setDiffError('No primary manuscript file found');
      setShowDiffModal(true);
      return;
    }

    setIsDiffLoading(true);
    setDiffError(null);
    setShowDiffModal(true);

    try {
      const diff = await getFileDiff(projectId, primaryManuscriptId);
      setDiffData(diff);
    } catch (error: unknown) {
      const err = error as { message?: string };
      // Sanitize error message
      const errorMsg = String(err.message || 'Failed to load diff').substring(0, 200);
      setDiffError(errorMsg);
    } finally {
      setIsDiffLoading(false);
    }
  };

  const { messages, isPolling, isLoading, error, startPolling, stopPolling, initializeMessages, addOptimisticMessage } =
    useConversationPolling();

  // Helper to check if conversation is a draft
  const isDraft = (conv: Conversation | DraftConversation | null): conv is DraftConversation => {
    return conv !== null && 'isDraft' in conv && conv.isDraft === true;
  };

  // Load messages when conversation changes (but not for drafts)
  useEffect(() => {
    if (!conversation || isDraft(conversation)) {
      // For drafts or no conversation, stop polling and clear messages
      stopPolling();
      isInitialLoad.current = true;
      previousMessageCount.current = 0;
      lastTrackedAssistantMessageId.current = null;
      lastTrackedConversationId.current = null;
      conversationViewedAt.current = null;
      lastUserMessageTime.current = null;
      return;
    }

    // Mark as initial load when conversation changes
    isInitialLoad.current = true;
    previousMessageCount.current = 0;
    lastTrackedAssistantMessageId.current = null;
    lastTrackedConversationId.current = null;
    conversationViewedAt.current = new Date(); // Record when we started viewing this conversation
    lastUserMessageTime.current = null;

    // Load initial messages for the selected conversation
    initializeMessages(conversation.id, projectId);
  }, [conversation?.id, projectId, initializeMessages, stopPolling]);

  // Handle scrolling: stay at top on initial load, scroll to new message when messages arrive
  useEffect(() => {
    if (messages.length === 0) return;

    if (isInitialLoad.current) {
      // On initial load, stay at the top (don't scroll)
      // The container naturally starts at the top, so we just mark it as loaded
      isInitialLoad.current = false;
      previousMessageCount.current = messages.length;
    } else if (messages.length > previousMessageCount.current) {
      // New messages arrived - scroll to the first new message
      const firstNewMessageIndex = previousMessageCount.current;
      const firstNewMessageRef = messageRefs.current.get(firstNewMessageIndex);

      if (firstNewMessageRef) {
        firstNewMessageRef.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      previousMessageCount.current = messages.length;
    }
  }, [messages]);

  // Track received assistant messages
  useEffect(() => {
    if (!conversation || isDraft(conversation) || messages.length === 0 || !onMessageReceived) return;

    // Find the latest assistant message by timestamp (not array position)
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    if (assistantMessages.length === 0) return;

    // Sort by created_at to find the truly latest message
    const latestAssistantMessage = assistantMessages.reduce((latest, current) => {
      if (!latest.created_at) return current;
      if (!current.created_at) return latest;
      return new Date(current.created_at) > new Date(latest.created_at) ? current : latest;
    });

    // If conversation has changed, reset tracking refs
    if (lastTrackedConversationId.current !== conversation.id) {
      lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
      lastTrackedConversationId.current = conversation.id;
      return;
    }

    // Check if we've already tracked this message
    if (lastTrackedAssistantMessageId.current === latestAssistantMessage.id) {
      return;
    }

    // If this is the initial load (ref was reset to null when switching conversations),
    // set the ref without tracking - we only want to track NEW messages, not existing ones
    if (lastTrackedAssistantMessageId.current === null) {
      lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
      lastTrackedConversationId.current = conversation.id;
      return;
    }

    // CRITICAL CHECK: Only track messages created AFTER we started viewing this conversation
    // This prevents tracking old messages when switching to an existing conversation
    if (conversationViewedAt.current && latestAssistantMessage.created_at) {
      const messageCreatedAt = new Date(latestAssistantMessage.created_at);
      const viewedAt = conversationViewedAt.current;

      if (messageCreatedAt <= viewedAt) {
        // Update ref to prevent repeated checks for this old message
        lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
        return;
      }
    }

    // Calculate duration if we have a user message timestamp
    let durationSeconds: number | undefined;
    if (lastUserMessageTime.current && latestAssistantMessage.created_at) {
      const assistantTime = new Date(latestAssistantMessage.created_at);
      const userTime = lastUserMessageTime.current;
      durationSeconds = Math.round((assistantTime.getTime() - userTime.getTime()) / 1000);
    }

    // Track the received message
    onMessageReceived(
      projectId,
      conversation.id,
      conversation.agent_name,
      durationSeconds
    );

    // Update the last tracked message ID and conversation ID
    lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
    lastTrackedConversationId.current = conversation.id;
  }, [messages, conversation, projectId, onMessageReceived]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!conversation || !inputValue.trim() || isSending) return;

    const content = inputValue.trim();
    setInputValue('');
    setIsSending(true);
    setSendError(null);

    try {
      if (isDraft(conversation)) {
        // First message: create conversation with the message
        const newConversation = await createConversation(
          content,
          conversation.agent_name,
          projectId
        );

        // Track conversation message sent
        if (onMessageSent) {
          onMessageSent(projectId, newConversation.id, conversation.agent_name);
        }
        const now = new Date();
        lastUserMessageTime.current = now;
        conversationViewedAt.current = now; // Update so we track the AI response

        // Notify parent to replace draft with real conversation
        onConversationCreated?.(newConversation);

        // Start polling for AI response (which will also fetch the user message)
        startPolling(newConversation.id, projectId);
      } else {
        // Add user message optimistically to UI
        const optimisticMessage: Message = {
          id: Date.now(), // Temporary ID
          role: 'user',
          content,
          data: null,
          contexts: [],
          created_at: new Date().toISOString(),
        };
        addOptimisticMessage(optimisticMessage);

        // Send message to backend
        await createMessage(conversation.id, content, projectId);

        // Track conversation message sent
        if (onMessageSent) {
          onMessageSent(projectId, conversation.id, conversation.agent_name);
        }
        const now = new Date();
        lastUserMessageTime.current = now;
        conversationViewedAt.current = now; // Update so we track the AI response

        // Notify parent to update conversation list
        onConversationUpdate?.();

        // Start polling to get AI response and sync messages
        startPolling(conversation.id, projectId);
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      setSendError(error.message || 'Failed to send message. Please try again.');
      // Restore input value on error
      setInputValue(content);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(e as unknown as React.FormEvent);
    }
  };

  // Group consecutive tool messages (no date dividers)
  const groupedMessages: Array<{ type: 'message' | 'toolGroup'; data: Message | Message[]; messageIndex: number }> = [];
  let currentToolGroup: Message[] = [];
  let messageIndex = 0;

  messages.forEach((message) => {
    if (message.role === 'tool') {
      currentToolGroup.push(message);
    } else {
      // If we have accumulated tool messages, add them as a group
      if (currentToolGroup.length > 0) {
        groupedMessages.push({
          type: 'toolGroup',
          data: currentToolGroup,
          messageIndex: messageIndex,
        });
        messageIndex++;
        currentToolGroup = [];
      }

      // Add the regular message
      groupedMessages.push({
        type: 'message',
        data: message,
        messageIndex: messageIndex,
      });
      messageIndex++;
    }
  });

  // Don't forget remaining tool messages
  if (currentToolGroup.length > 0) {
    groupedMessages.push({
      type: 'toolGroup',
      data: currentToolGroup,
      messageIndex: messageIndex,
    });
  }

  if (!conversation) {
    return (
      <div className="conversationDetail empty">
        <div className="emptyState">
          {isReviewInProgress ? (
            <>
              <div className="emptyStateIcon">⏳</div>
              <h3>Review in progress</h3>
              <p>Your manuscript is being reviewed. This may take a few minutes.</p>
            </>
          ) : (
            <>
              <div className="emptyStateIcon">📄</div>
              <h3>No feedback yet</h3>
              <p>Upload and sync your manuscript to receive AI-powered feedback.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const currentIsDraft = isDraft(conversation);

  return (
    <div className="conversationDetail">
      {/* Header */}
      <div className="conversationHeader">
        <div className="conversationHeaderContent">
          <div className="conversationTitleRow">
            {!currentIsDraft && conversation.created_at && (
              <p className="conversationDate">
                {new Date(conversation.created_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric'
                })}
              </p>
            )}
            <h2 className="conversationTitle">
              {conversation.title || 'New Conversation'}
            </h2>
          </div>
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

        {currentIsDraft ? (
          <div className="noMessages">
            <p>Start your conversation below</p>
          </div>
        ) : isLoading && groupedMessages.length === 0 ? (
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
              <div
                key={index}
                ref={(el) => {
                  if (el) {
                    messageRefs.current.set(item.messageIndex, el);
                  } else {
                    messageRefs.current.delete(item.messageIndex);
                  }
                }}
              >
                {item.type === 'message' ? (
                  <ConversationMessage
                    message={item.data as Message}
                    isPolling={isPolling}
                    onShowDiff={handleShowDiff}
                  />
                ) : (
                  <ToolMessageAccordion messages={item.data as Message[]} />
                )}
              </div>
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
              placeholder="Or ask anything..."
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

        {/* Feedback Link */}
        {!currentIsDraft && groupedMessages.length > 0 && feedbackFormUrl && (
          <a
            href="#"
            className="feedbackLink"
            onClick={(e) => {
              e.preventDefault();
              handleOpenFeedback();
            }}
          >
            Provide feedback on this review
          </a>
        )}
      </div>

      {/* Diff Modal */}
      {showDiffModal && (
        <DiffModal
          diffData={diffData}
          isLoading={isDiffLoading}
          error={diffError}
          onClose={() => setShowDiffModal(false)}
        />
      )}
    </div>
  );
}
