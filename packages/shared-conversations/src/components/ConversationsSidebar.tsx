import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Conversation, DraftConversation } from '../types/conversation';
import { useConversationsApi } from '../api/useConversationsApi';

interface ConversationsSidebarProps {
  projectId: number;
  selectedConversationId: number | null;
  onSelectConversation: (conversation: Conversation) => void;
  onNewConversation: () => void;
  refreshTrigger?: number; // Used to trigger refresh from parent
  onConversationsLoaded?: (conversations: Conversation[]) => void;
  /** Optional: Called when a conversation is selected (for analytics) */
  onConversationView?: (projectId: number, conversationId: number, agentName: string) => void;
  /** Optional: Event-driven refresh callback. Register this to refetch conversations on events like review_completed */
  onRegisterRefresh?: (refreshFn: () => void) => () => void;
  /** Optional: Collapsed state for responsive sidebar */
  collapsed?: boolean;
  /** Optional: Toggle collapsed state */
  onToggleCollapsed?: () => void;
  /** Supporting materials count */
  supportingMaterialsCount?: number;
  /** Supporting materials loading state */
  supportingMaterialsLoading?: boolean;
  /** Selected view type */
  selectedView?: 'conversation' | 'supporting-materials';
  /** Callback when supporting materials is selected */
  onSelectSupportingMaterials?: () => void;
  /** Whether a review is currently in progress */
  isReviewInProgress?: boolean;
  /** Optional draft conversation to show at the top of the list */
  draftConversation?: DraftConversation | null;
  /** Called after a refresh-triggered load completes */
  onRefreshComplete?: (conversations: Conversation[]) => void;
}

export function ConversationsSidebar({
  projectId,
  selectedConversationId,
  onSelectConversation,
  onNewConversation,
  refreshTrigger,
  onConversationsLoaded,
  onConversationView,
  onRegisterRefresh,
  collapsed = false,
  onToggleCollapsed,
  supportingMaterialsCount = 0,
  supportingMaterialsLoading = false,
  selectedView = 'conversation',
  onSelectSupportingMaterials,
  isReviewInProgress = false,
  draftConversation,
  onRefreshComplete,
}: ConversationsSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, _setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const { listConversations } = useConversationsApi();

  // Fetch first page — renders immediately
  const loadConversations = useCallback(async (isInitialLoad: boolean = false): Promise<Conversation[]> => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await listConversations(0, projectId);
      setConversations(response.conversations);
      setHasMore(response.has_more);
      setOffset(response.conversations.length);

      if (onConversationsLoaded && response.conversations.length > 0 && isInitialLoad) {
        onConversationsLoaded(response.conversations);
      }

      return response.conversations;
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Failed to load conversations:', err);
      setError(error.message || 'Failed to load conversations');
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [projectId, listConversations, onConversationsLoaded]);

  // Fetch next page and append
  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);

    try {
      const response = await listConversations(offset, projectId);
      setConversations((prev) => [...prev, ...response.conversations]);
      setHasMore(response.has_more);
      setOffset((prev) => prev + response.conversations.length);
    } catch (err: unknown) {
      console.error('Failed to load more conversations:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore, offset, projectId, listConversations]);

  // Infinite scroll — load more when near bottom of list
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
        loadMore();
      }
    };

    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadMore]);

  // Refresh conversations (called by event-driven updates)
  const refreshConversations = useCallback(async () => {
    console.log('[ConversationsSidebar] Event-driven refresh triggered');
    await loadConversations(false);
  }, [loadConversations]);

  // Load first page on mount and when projectId changes
  useEffect(() => {
    setConversations([]);
    setOffset(0);
    setHasMore(false);
    loadConversations(true);
  }, [projectId]);

  // Register event-driven refresh callback
  useEffect(() => {
    if (!onRegisterRefresh) return;

    console.log('[ConversationsSidebar] Registering event-driven refresh');
    const cleanup = onRegisterRefresh(refreshConversations);

    return cleanup;
  }, [onRegisterRefresh, refreshConversations]);

  // Refresh when refreshTrigger changes
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      loadConversations(false).then((conversations) => {
        if (onRefreshComplete && conversations) {
          onRefreshComplete(conversations);
        }
      });
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

  const handleSelectConversation = (conversation: Conversation) => {
    // Call analytics callback if provided
    if (onConversationView) {
      onConversationView(projectId, conversation.id, conversation.agent_name);
    }
    onSelectConversation(conversation);

    // Auto-close sidebar on mobile after selection
    if (window.innerWidth <= 1280 && onToggleCollapsed && !collapsed) {
      onToggleCollapsed();
    }
  };

  return (
    <>
      <div className={`conversationsSidebar ${collapsed ? 'collapsed' : ''}`}>
      {/* Supporting Materials Section */}
      {!collapsed && (
        <div className="sidebarSection">
          <h3 className="sidebarSectionTitle">Supporting materials</h3>
          {supportingMaterialsLoading ? (
            <div className="sidebarLoading">
              <div className="loadingSpinner"></div>
              <p>Loading materials...</p>
            </div>
          ) : supportingMaterialsCount === 0 ? (
            <div className="supportingMaterialsEmptyState">
              <p className="supportingMaterialsEmptyText">
                Improve reviews by adding supporting materials, such as references or notes.
              </p>
              <button
                className="supportingMaterialsGetStarted"
                onClick={onSelectSupportingMaterials}
              >
                Get started
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ marginLeft: '4px' }}
                >
                  <path
                    d="M6 12L10 8L6 4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : (
            <div
              className={`supportingMaterialsCard ${
                selectedView === 'supporting-materials' ? 'selected' : ''
              }`}
              onClick={onSelectSupportingMaterials}
            >
              <p className="supportingMaterialsCardSubtitle">
                {supportingMaterialsCount} connected {supportingMaterialsCount === 1 ? 'file' : 'files'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Manuscript Feedback Section */}
      {!collapsed && (
        <div className="sidebarSection">
          <div className="sidebarSectionHeader">
            <h3 className="sidebarSectionTitle">Feedback & Conversations</h3>
            <button
              className="newConversationButton"
              onClick={onNewConversation}
              aria-label="New conversation"
              title="New conversation"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 2V14M2 8H14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Conversations List */}
      {!collapsed && (
        <div className="conversationsList" ref={listRef}>
        {error && (
          <div className="sidebarError">
            <span className="errorIcon">⚠️</span>
            <p>{error}</p>
            <button onClick={() => loadConversations(true)}>Retry</button>
          </div>
        )}

        {/* Draft conversation always appears at top */}
        {draftConversation && (
          <div
            className={`conversationItem ${selectedConversationId === -1 ? 'selected' : ''}`}
            onClick={() => onSelectConversation(draftConversation as Conversation)}
          >
            <h4 className="conversationItemTitle">{draftConversation.title || 'New Conversation'}</h4>
            {draftConversation.created_at && (
              <span className="conversationItemDate">
                {formatDateTime(draftConversation.created_at)}
              </span>
            )}
          </div>
        )}

        {isLoading && conversations.length === 0 ? (
          <div className="sidebarLoading">
            <div className="loadingSpinner"></div>
            <p>Loading feedback...</p>
          </div>
        ) : filteredConversations.length === 0 && !draftConversation ? (
          <div className="sidebarEmpty">
            <div className="emptyIcon">💬</div>
            <h3>
              {searchQuery
                ? 'No feedback found'
                : isReviewInProgress
                  ? 'Review in progress'
                  : 'No feedback yet'}
            </h3>
            <p>
              {searchQuery
                ? 'Try a different search term'
                : isReviewInProgress
                  ? 'Your manuscript is being reviewed'
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
                onClick={() => handleSelectConversation(conversation)}
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
            {isLoadingMore && (
              <div className="sidebarLoading">
                <div className="loadingSpinner"></div>
              </div>
            )}
          </>
        )}
        </div>
      )}
      </div>
    </>
  );
}
