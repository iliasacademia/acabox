import React, { useState, useEffect, useRef } from 'react';
import { Message, createMessage, createConversation, Conversation, getConversation } from '../../services/conversationsApi';
import { getFileDiff, ProjectFile } from '../../services/projectsApi';
import { useConversationPolling } from '../../hooks/useConversationPolling';
import { ConversationMessage } from './ConversationMessage';
import { ToolMessageAccordion } from './ToolMessageAccordion';
import { DateDivider } from './DateDivider';
import { formatConversationTitle } from './utils';
import { DraftConversation } from './ConversationsPage';
import DiffModal from './DiffModal';

interface ConversationDetailProps {
  conversation: Conversation | DraftConversation | null;
  projectId: number;
  primaryManuscriptId?: number;
  manuscriptFile?: ProjectFile | null;
  onConversationCreated?: (conversation: Conversation) => void;
  onConversationUpdate?: () => void;
}

export function ConversationDetail({
  conversation,
  projectId,
  primaryManuscriptId,
  manuscriptFile,
  onConversationCreated,
  onConversationUpdate,
}: ConversationDetailProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [diffString, setDiffString] = useState<string>('');
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Validate diff content format and size
  const validateDiff = (diff: string): { valid: boolean; error?: string } => {
    // Check if diff is a string
    if (typeof diff !== 'string') {
      return { valid: false, error: 'Invalid diff format' };
    }

    // Check maximum size (5MB)
    const MAX_DIFF_SIZE = 5 * 1024 * 1024;
    if (diff.length > MAX_DIFF_SIZE) {
      return { valid: false, error: 'Diff content too large' };
    }

    // Basic validation: unified diff should start with --- or +++
    // or be empty (no changes)
    if (diff.length > 0 && !diff.match(/^(---|\+\+\+|diff)/m)) {
      return { valid: false, error: 'Invalid diff format' };
    }

    return { valid: true };
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

      // Validate diff content before displaying
      const validation = validateDiff(diff);
      if (!validation.valid) {
        setDiffError(validation.error || 'Invalid diff content');
        setDiffString('');
        return;
      }

      setDiffString(diff);
    } catch (error: any) {
      // Sanitize error message
      const errorMsg = String(error.message || 'Failed to load diff').substring(0, 200);
      setDiffError(errorMsg);
    } finally {
      setIsDiffLoading(false);
    }
  };


  const { messages, isPolling, isLoading, error, startPolling, stopPolling, refetch } =
    useConversationPolling();

  // Helper to check if conversation is a draft
  const isDraft = (conv: Conversation | DraftConversation | null): conv is DraftConversation => {
    return conv !== null && 'isDraft' in conv && conv.isDraft === true;
  };

  // Load messages when conversation changes (but not for drafts)
  useEffect(() => {
    const loadInitialMessages = async () => {
      if (!conversation || isDraft(conversation)) {
        setInitialMessages([]);
        return;
      }

      setIsLoadingInitial(true);
      setLoadError(null);

      try {
        const conv = await getConversation(conversation.id, projectId);
        if (conv) {
          setInitialMessages(conv.messages || []);
        }
      } catch (err: any) {
        setLoadError(err.message || 'Failed to load messages');
      } finally {
        setIsLoadingInitial(false);
      }
    };

    loadInitialMessages();

    return () => {
      // Stop any active polling when switching conversations
      stopPolling();
    };
  }, [conversation?.id, projectId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, initialMessages]);

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

        // Notify parent to replace draft with real conversation
        onConversationCreated?.(newConversation);

        // Start polling for AI response
        startPolling(newConversation.id, projectId);
      } else {
        // Existing conversation: send message normally
        await createMessage(conversation.id, content, projectId);

        // Immediately refetch to show user's message
        await refetch();

        // Notify parent to update conversation list
        onConversationUpdate?.();

        // Restart polling to get AI response
        startPolling(conversation.id, projectId);
      }
    } catch (err: any) {
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

  // Use polling messages when active, otherwise use initial messages
  const displayMessages = isPolling ? messages : initialMessages;
  const displayLoading = isPolling ? isLoading : isLoadingInitial;
  const displayError = isPolling ? error : loadError;

  // Group consecutive tool messages (no date dividers)
  const groupedMessages: Array<{ type: 'message' | 'toolGroup'; data: any }> = [];
  let currentToolGroup: Message[] = [];

  displayMessages.forEach((message) => {
    if (message.role === 'tool') {
      currentToolGroup.push(message);
    } else {
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

  const currentIsDraft = isDraft(conversation);

  return (
    <div className="conversationDetail">
      {/* Header */}
      <div className="conversationHeader">
        <div className="conversationHeaderContent">
          <div className="conversationTitleRow">
            <h2 className="conversationTitle">
              {currentIsDraft
                ? conversation.title
                : conversation.title
                  ? formatConversationTitle(conversation.title, conversation.created_at)
                  : 'New Conversation'
              }
            </h2>
            {manuscriptFile?.last_review?.review_type === 'diff_review' && (
              <button
                className="showDiffButton"
                onClick={handleShowDiff}
                disabled={!primaryManuscriptId}
              >
                Show Diff
              </button>
            )}
          </div>
          {conversation.summary && (
            <p className="conversationSummary">{conversation.summary}</p>
          )}
        </div>
        {isPolling && !isLoadingInitial && (
          <div className="pollingIndicator">
            <span className="pollingDot"></span>
            <span className="pollingText">AI is thinking...</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="conversationMessages" ref={messagesContainerRef}>
        {displayError && (
          <div className="conversationError">
            <span className="errorIcon">⚠️</span>
            <span>{displayError}</span>
          </div>
        )}

        {currentIsDraft ? (
          <div className="noMessages">
            <p>Start your conversation below</p>
          </div>
        ) : displayLoading && groupedMessages.length === 0 ? (
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
                ) : (
                  <ToolMessageAccordion messages={item.data} />
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

      {/* Diff Modal */}
      {showDiffModal && (
        <DiffModal
          diffString={diffString}
          isLoading={isDiffLoading}
          error={diffError}
          onClose={() => setShowDiffModal(false)}
        />
      )}
    </div>
  );
}
