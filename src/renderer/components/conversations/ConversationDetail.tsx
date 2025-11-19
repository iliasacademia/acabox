import React, { useState, useEffect, useRef } from 'react';
import { Message, createMessage, createConversation, Conversation } from '../../services/conversationsApi';
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
  onConversationCreated?: (conversation: Conversation) => void;
  onConversationUpdate?: () => void;
}

export function ConversationDetail({
  conversation,
  projectId,
  onConversationCreated,
  onConversationUpdate,
}: ConversationDetailProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showDiffModal, setShowDiffModal] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Mock unified diff data (output from `diff -u file1.txt file2.txt`)
  const mockDiffString = `--- ./tmp/v1.txt        2025-11-18 21:27:07
+++ ./tmp/v2.txt        2025-11-18 21:26:03
@@ -9,6 +9,17 @@
 ©  The Author Journal compilation ©  The Editors of The Philosophical Quarterly
 Published by Blackwell Publishing,  Garsington Road, Oxford  , UK, and  Main Street, Malden,  , USA 
  
+ASPECT-SWITCHING AND VISUAL PHENOMENAL CHARACTER  
+In this paper, I argue that one can explain well known cases of aspect- switching without having to assume that visual experience represents rich properties (i.e., properties other than colour, shape, position and size). Furthermore, I shall argue that even if my arguments are unsound, and cases of aspect-switching do require that visual experience represents rich properties, there is a reason to think that these rich properties do not include natural-kind properties such as the property of being a tomato. 
+In this paper, instead of using the terminology of what properties visual experience represents, I define a kind of looking, phenomenal looking, which is individuated in terms of differences in visual phenomenal character. I identify phenomenal looking by arguing for a constraint on it, that is, a condition necessary for a kind of looking. My methodology is similar to that of someone who wishes to identify, say, a particular kind of justification, and does so by identifying a constraint on a particular kind of justification. 
+The following principle is a preliminary formulation of the constraint: 
+Restricted phenomenal character principle. Necessarily, for all objects x, y and z and all properties F and G, if x looks F to z, y does not look F to z, and y looks G to z, then there is a visual phenomenal difference between the ways x and y look to z. 
+I intend to apply the constraint diachronically and across worlds. Therefore the full constraint, the phenomenal character principle, quantifies over times and worlds, and is as follows: 
+Phenomenal character principle. Necessarily, for all objects x, y and z, all properties F and G, all times t1 and t2 and all worlds w1 and w2, if x looks F to z at t1 at w1, y does not look F to z at t2 at w2, and y looks G to z at t2 at w2, then there is a visual phenomenal difference between the way x looks to z at t1 at w1 and the way y looks to z at t2 at w2. 
+I assume that only one kind of looking satisfies the phenomenal character principle, and I call it phenomenal looking. What it means to say that there is a visual phenomenal difference between the ways two objects a and b look to S is that what it is visually like for S for a to look the way it does to S is different from what it is visually like for S for b to look the way it does to S. 
+The phenomenal character principle is phrased in terms of how things look to a particular subject. Sometimes I refer to the properties that objects phenomenally look to have, and leave it implicit that there is some parti- cular subject to whom these objects phenomenally look to have the proper- ties in question. 
+The phenomenal character principle uses the locution ‘an object looks F’, where ‘F’ is to be replaced by an adjective. In English, some properties can 
+©  The Author Journal compilation ©  The Editors of The Philosophical Quarterly 
  
  RICHARD PRICE 
 be expressed by predicates of the form ‘is + adjective’. For instance, the property of being red can be expressed by the predicate ‘is red’. However, some properties, for instance, the property of being a tomato, are not expressed by predicates of the form ‘is + adjective’. There is no predicate ‘is tomatoey’ which expresses the property of being a tomato. 
@@ -111,3 +122,5 @@
  RICHARD PRICE
 that those properties will not include natural-kind properties such as being a 
 tomato. 
+VI. CONCLUSION 
+I have argued that aspect switching cases, such as the duck/rabbit, do not require that the properties which objects phenomenally look to have (or the properties which are represented by visual experience, to use Siegel’s and Searle’s terminology) must be richer than properties such as colour, shape, position and size. I have argued that aspect-switching cases can be explained by changes in patterns of attention, cognitive shifts and shifts in visual imagination. In the final section I argued that even if aspect-switching cases are taken to show that objects phenomenally look to have a richer range of properties than colour, shape, position and size, there is reason to think that those richer properties do not include natural-kind properties such as being a tomato.5 `;

  const { messages, isPolling, isLoading, error, startPolling, stopPolling, refetch } =
    useConversationPolling();

  // Helper to check if conversation is a draft
  const isDraft = (conv: Conversation | DraftConversation | null): conv is DraftConversation => {
    return conv !== null && 'isDraft' in conv && conv.isDraft === true;
  };

  // Start polling when conversation changes (but not for drafts)
  useEffect(() => {
    if (conversation && !isDraft(conversation)) {
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
            <button
              className="showDiffButton"
              onClick={() => setShowDiffModal(true)}
            >
              Show Diff
            </button>
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

      {/* Diff Modal */}
      {showDiffModal && (
        <DiffModal
          diffString={mockDiffString}
          onClose={() => setShowDiffModal(false)}
        />
      )}
    </div>
  );
}
