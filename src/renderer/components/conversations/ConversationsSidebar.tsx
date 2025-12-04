import React, { useState, useEffect, useRef } from 'react';
import { Conversation, listConversations } from '../../services/conversationsApi';

interface ConversationsSidebarProps {
  projectId: number;
  selectedConversationId: number | null;
  onSelectConversation: (conversation: Conversation) => void;
  onNewConversation: () => void;
  refreshTrigger?: number; // Used to trigger refresh from parent
  onConversationsLoaded?: (conversations: Conversation[]) => void;
}

export function ConversationsSidebar({
  projectId,
  selectedConversationId,
  onSelectConversation,
  // onNewConversation,
  refreshTrigger,
  onConversationsLoaded,
}: ConversationsSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, _setSearchQuery] = useState('');

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const POLL_INTERVAL = 5000; // Poll every 5 seconds

  // Load all conversations by fetching in batches if needed
  const loadConversations = async (isInitialLoad: boolean = false) => {
    setIsLoading(true);
    setError(null);

    try {
      let allConversations: Conversation[] = [];
      let offset = 0;
      let hasMore = true;
      const batchSize = 100; // Fetch 100 at a time

      console.log('[ConversationsSidebar] Starting to load all conversations');

      // Keep fetching until we have all conversations
      while (hasMore) {
        const response = await listConversations(offset, projectId, batchSize);
        console.log(`[ConversationsSidebar] Batch at offset ${offset}:`, response.conversations.length, 'conversations, has_more:', response.has_more);

        allConversations = [...allConversations, ...response.conversations];
        hasMore = response.has_more;
        offset += response.conversations.length;

        // Safety check to prevent infinite loops
        if (offset > 10000) {
          console.warn('[ConversationsSidebar] Safety limit reached, stopping fetch');
          break;
        }
      }

      console.log('[ConversationsSidebar] Total conversations loaded:', allConversations.length);
      setConversations(allConversations);

      // Only notify parent on initial load (not on polling refreshes)
      if (onConversationsLoaded && allConversations.length > 0 && isInitialLoad) {
        onConversationsLoaded(allConversations);
      }
    } catch (err: any) {
      console.error('Failed to load conversations:', err);
      setError(err.message || 'Failed to load conversations');
    } finally {
      setIsLoading(false);
    }
  };

  // Start polling for new conversations
  const startPolling = () => {
    // Stop any existing polling
    stopPolling();

    // Set up new polling interval
    pollIntervalRef.current = setInterval(async () => {
      // Only check for new conversations at the top, don't reset the entire list
      try {
        const response = await listConversations(0, projectId, 20);

        // Check if there are any new conversations by comparing the first conversation ID
        if (response.conversations.length > 0 && conversations.length > 0) {
          const newestPolledId = response.conversations[0].id;
          const currentNewestId = conversations[0].id;

          // If there's a newer conversation, prepend only the new ones
          if (newestPolledId !== currentNewestId) {
            const newConversations = response.conversations.filter(
              conv => !conversations.some(existing => existing.id === conv.id)
            );

            if (newConversations.length > 0) {
              setConversations(prev => [...newConversations, ...prev]);
            }
          }
        } else if (response.conversations.length > 0 && conversations.length === 0) {
          // If we had no conversations before and now we do, add them
          setConversations(response.conversations);
        }
      } catch (error) {
        // Silent fail for polling
        console.error('Polling error:', error);
      }
    }, POLL_INTERVAL);
  };

  // Stop polling
  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  // Load conversations on mount and when projectId changes
  useEffect(() => {
    setConversations([]);
    loadConversations(true); // Initial load

    // Start polling for new conversations
    startPolling();

    return () => {
      // Clean up polling on unmount or when projectId changes
      stopPolling();
    };
  }, [projectId]);

  // Refresh conversations when refreshTrigger changes
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      setConversations([]);
      loadConversations(true); // Treat as initial load to auto-select new conversation
    }
  }, [refreshTrigger]);

  // Filter conversations by search query
  const filteredConversations = conversations.filter((conv) => {
    if (!searchQuery) return true;

    const query = searchQuery.toLowerCase();
    const title = (conv.title || '').toLowerCase();
    const summary = (conv.summary || '').toLowerCase();

    return title.includes(query) || summary.includes(query);
  });

  // Format date with time in expanded format (e.g., "Nov 12, 2024, 10:30 AM")
  const formatDateTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="conversationsSidebar">
      {/* Conversations List */}
      <div className="conversationsList">
        {error && (
          <div className="sidebarError">
            <span className="errorIcon">⚠️</span>
            <p>{error}</p>
            <button onClick={() => loadConversations(true)}>Retry</button>
          </div>
        )}

        {isLoading && conversations.length === 0 ? (
          <div className="sidebarLoading">
            <div className="loadingSpinner"></div>
            <p>Loading feedback...</p>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="sidebarEmpty">
            <div className="emptyIcon">💬</div>
            <h3>
              {searchQuery
                ? 'No feedback found'
                : 'No feedback yet'}
            </h3>
            <p>
              {searchQuery
                ? 'Try a different search term'
                : 'Upload your manuscript to get started'}
            </p>
          </div>
        ) : (
          <>
            {filteredConversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`conversationItem ${
                  selectedConversationId === conversation.id ? 'selected' : ''
                }`}
                onClick={() => onSelectConversation(conversation)}
              >
                <h4 className="conversationItemTitle">
                  {conversation.title || 'Untitled Conversation'}
                </h4>
                <span className="conversationItemDate">
                  {formatDateTime(conversation.created_at)}
                </span>
                {conversation.summary && (
                  <p className="conversationItemSummary">
                    {conversation.summary}
                  </p>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
