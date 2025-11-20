import React, { useState, useEffect, useRef } from 'react';
import { Conversation, listConversations } from '../../services/conversationsApi';
import { formatConversationTitle } from './utils';

interface ConversationsSidebarProps {
  projectId: number;
  selectedConversationId: number | null;
  onSelectConversation: (conversation: Conversation) => void;
  onNewConversation: () => void;
  refreshTrigger?: number; // Used to trigger refresh from parent
}

export function ConversationsSidebar({
  projectId,
  selectedConversationId,
  onSelectConversation,
  onNewConversation,
  refreshTrigger,
}: ConversationsSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);

  const listContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingMore = useRef(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const ITEMS_PER_PAGE = 20;
  const POLL_INTERVAL = 5000; // Poll every 5 seconds

  // Load initial conversations
  const loadConversations = async (reset: boolean = false, silent: boolean = false) => {
    if (isLoadingMore.current) return;

    const newOffset = reset ? 0 : offset;

    if (!silent) {
      setIsLoading(reset);
      setError(null);
    }
    isLoadingMore.current = true;

    try {
      const response = await listConversations(newOffset, projectId);

      if (reset) {
        setConversations(response.conversations);
      } else {
        setConversations((prev) => [...prev, ...response.conversations]);
      }

      setHasMore(response.has_more);
      setOffset(newOffset + response.conversations.length);
    } catch (err: any) {
      console.error('Failed to load conversations:', err);
      setError(err.message || 'Failed to load conversations');
    } finally {
      setIsLoading(false);
      isLoadingMore.current = false;
    }
  };

  // Start polling for new conversations
  const startPolling = () => {
    // Stop any existing polling
    stopPolling();

    // Set up new polling interval
    pollIntervalRef.current = setInterval(() => {
      loadConversations(true, true); // Silent reload to check for new conversations
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
    setOffset(0);
    setHasMore(true);
    loadConversations(true);

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
      setOffset(0);
      setHasMore(true);
      loadConversations(true);
    }
  }, [refreshTrigger]);

  // Infinite scroll handler
  const handleScroll = () => {
    if (!listContainerRef.current || !hasMore || isLoadingMore.current) return;

    const container = listContainerRef.current;
    const scrollBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    // Load more when within 100px of bottom
    if (scrollBottom < 100) {
      loadConversations(false);
    }
  };

  useEffect(() => {
    const container = listContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [hasMore, offset]);

  // Filter conversations by search query
  const filteredConversations = conversations.filter((conv) => {
    if (!searchQuery) return true;

    const query = searchQuery.toLowerCase();
    const title = (conv.title || '').toLowerCase();
    const summary = (conv.summary || '').toLowerCase();

    return title.includes(query) || summary.includes(query);
  });

  // Format date with time
  const formatDateTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / 3600000);

    // Format time as HH:MM AM/PM
    const timeString = date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    if (diffHours < 24) {
      return timeString; // Just show time for today
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return `Yesterday ${timeString}`;
    if (diffDays < 7) return `${diffDays} days ago`;

    return date.toLocaleDateString();
  };

  return (
    <div className="conversationsSidebar">
      {/* Header */}
      <div className="sidebarHeader">
        <h2>Conversations</h2>
        <button className="newConversationButton" onClick={onNewConversation}>
          <span className="buttonIcon">+</span>
          New
        </button>
      </div>

      {/* Conversations List */}
      <div className="conversationsList" ref={listContainerRef}>
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
            <p>Loading conversations...</p>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="sidebarEmpty">
            <div className="emptyIcon">💬</div>
            <h3>
              {searchQuery
                ? 'No conversations found'
                : 'No conversations yet'}
            </h3>
            <p>
              {searchQuery
                ? 'Try a different search term'
                : 'Start a new conversation with Co-Scientist'}
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
                <div className="conversationItemHeader">
                  <h4 className="conversationItemTitle">
                    {formatConversationTitle(conversation.title, conversation.created_at) || 'Untitled Conversation'}
                  </h4>
                  <span className="conversationItemDate">
                    {formatDateTime(conversation.created_at)}
                  </span>
                </div>
                {conversation.summary && (
                  <p className="conversationItemSummary">
                    {conversation.summary}
                  </p>
                )}
              </div>
            ))}

            {/* Load more indicator */}
            {hasMore && !isLoading && (
              <div className="loadMoreIndicator">
                <p>Scroll for more...</p>
              </div>
            )}

            {/* Loading more */}
            {isLoadingMore.current && (
              <div className="loadingMore">
                <div className="loadingSpinner small"></div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
