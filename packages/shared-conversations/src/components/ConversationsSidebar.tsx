import React, { useState, useEffect } from 'react';
import { Conversation } from '../types/conversation';
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
}

export function ConversationsSidebar({
  projectId,
  selectedConversationId,
  onSelectConversation,
  // onNewConversation,
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
}: ConversationsSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, _setSearchQuery] = useState('');

  const { listConversations } = useConversationsApi();

  // Load all conversations by fetching in batches if needed
  const loadConversations = async (isInitialLoad: boolean = false) => {
    setIsLoading(true);
    setError(null);

    try {
      let allConversations: Conversation[] = [];
      let offset = 0;
      let hasMore = true;
      const batchSize = 100; // Fetch 100 at a time
      // Keep fetching until we have all conversations
      while (hasMore) {
        const response = await listConversations(offset, projectId, batchSize);
        allConversations = [...allConversations, ...response.conversations];
        hasMore = response.has_more;
        offset += response.conversations.length;

        // Safety check to prevent infinite loops
        if (offset > 10000) {
          console.warn('[ConversationsSidebar] Safety limit reached, stopping fetch');
          break;
        }
      }
      setConversations(allConversations);

      // Only notify parent on initial load (not on polling refreshes)
      if (onConversationsLoaded && allConversations.length > 0 && isInitialLoad) {
        onConversationsLoaded(allConversations);
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Failed to load conversations:', err);
      setError(error.message || 'Failed to load conversations');
    } finally {
      setIsLoading(false);
    }
  };

  // Refresh conversations (called by event-driven updates)
  const refreshConversations = async () => {
    console.log('[ConversationsSidebar] Event-driven refresh triggered');
    await loadConversations(false);
  };

  // Load conversations on mount and when projectId changes
  useEffect(() => {
    setConversations([]);
    loadConversations(true); // Initial load
  }, [projectId]);

  // Register event-driven refresh callback
  useEffect(() => {
    if (!onRegisterRefresh) return;

    console.log('[ConversationsSidebar] Registering event-driven refresh');
    const cleanup = onRegisterRefresh(refreshConversations);

    return cleanup;
  }, [onRegisterRefresh]);

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
          <h3 className="sidebarSectionTitle">Manuscript feedback</h3>
        </div>
      )}

      {/* Conversations List */}
      {!collapsed && (
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
          </>
        )}
        </div>
      )}
      </div>
    </>
  );
}
