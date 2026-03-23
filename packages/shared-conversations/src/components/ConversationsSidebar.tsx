import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Conversation, DraftConversation } from '../types/conversation';
import { useConversationsApi } from '../api/useConversationsApi';

// ---------------------------------------------------------------------------
// ConversationSection
// ---------------------------------------------------------------------------

interface ConversationSectionProps {
  label: string;
  conversations: Conversation[];
  selectedConversationId: number | null;
  onSelectConversation: (conv: Conversation) => void;
  /** Called when the three-dot menu button is clicked */
  onMenuToggle: (e: React.MouseEvent, conv: Conversation, type: 'active' | 'archived') => void;
  menuType: 'active' | 'archived';
  /** ID of the conversation whose menu is currently open */
  openMenuId: number | null;
  formatDateTime: (ts: string) => string;
  /** Collapsible section (archived). Non-collapsible sections (active) are always visible. */
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Content to render when the list is empty */
  emptyContent?: React.ReactNode;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** ID of the conversation currently being acted on (shows inline spinner) */
  actionSpinnerId?: number | null;
  /** Extra CSS class applied to each conversation item */
  itemClassName?: string;
  /** Slot rendered above the list (e.g. draft conversation) */
  headerSlot?: React.ReactNode;
}

function ConversationSection({
  label,
  conversations,
  selectedConversationId,
  onSelectConversation,
  onMenuToggle,
  menuType,
  openMenuId,
  formatDateTime,
  collapsible = false,
  expanded = true,
  onToggle,
  isLoading = false,
  isLoadingMore = false,
  error = null,
  onRetry,
  emptyContent,
  hasMore = false,
  onLoadMore,
  actionSpinnerId = null,
  itemClassName = '',
  headerSlot,
}: ConversationSectionProps) {
  const header = collapsible ? (
    <button
      className="archivedSectionToggle"
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <svg
        className={`archivedChevron ${expanded ? 'expanded' : ''}`}
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      {label}
    </button>
  ) : null;

  const body = (
    <>
      {headerSlot}
      {isLoading ? (
        <div className="sidebarLoading" style={{ padding: '16px 0' }}>
          <div className="loadingSpinner" />
        </div>
      ) : error ? (
        <div className="sidebarError">
          <p>{error}</p>
          {onRetry && <button onClick={onRetry}>Retry</button>}
        </div>
      ) : conversations.length === 0 ? (
        emptyContent ?? null
      ) : (
        <>
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversationItem ${itemClassName} ${
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
                <p className="conversationItemSummary">{conversation.summary}</p>
              )}
              {actionSpinnerId === conversation.id ? (
                <div className="conversationActionSpinner"><div className="archiveSpinner" /></div>
              ) : (
                <button
                  className={`conversationMenuButton ${openMenuId === conversation.id ? 'active' : ''}`}
                  onClick={(e) => onMenuToggle(e, conversation, menuType)}
                  aria-label="More options"
                  aria-haspopup="true"
                  aria-expanded={openMenuId === conversation.id}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="8" cy="3" r="1.25" fill="currentColor"/>
                    <circle cx="8" cy="8" r="1.25" fill="currentColor"/>
                    <circle cx="8" cy="13" r="1.25" fill="currentColor"/>
                  </svg>
                </button>
              )}
            </div>
          ))}
          {isLoadingMore && (
            <div className="sidebarLoading" style={{ padding: '8px 0' }}>
              <div className="loadingSpinner" />
            </div>
          )}
          {hasMore && !isLoadingMore && onLoadMore && (
            <button className="loadMoreArchivedButton" onClick={onLoadMore}>
              Load more
            </button>
          )}
        </>
      )}
    </>
  );

  return (
    <div className={collapsible ? 'archivedSection' : undefined}>
      {header}
      {(!collapsible || expanded) && (
        collapsible ? <div className="archivedList">{body}</div> : body
      )}
    </div>
  );
}

interface ConversationsSidebarProps {
  projectId?: number | null;
  selectedConversationId: number | null;
  onSelectConversation: (conversation: Conversation, isArchived?: boolean) => void;
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

  // Archive state
  const [archivingId, setArchivingId] = useState<number | null>(null);
  const [unarchivingId, setUnarchivingId] = useState<number | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [menuType, setMenuType] = useState<'active' | 'archived'>('active');
  const [menuConversation, setMenuConversation] = useState<Conversation | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [archivedConversations, setArchivedConversations] = useState<Conversation[]>([]);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const [isLoadingMoreArchived, setIsLoadingMoreArchived] = useState(false);
  const [hasMoreArchived, setHasMoreArchived] = useState(false);
  const [archivedOffset, setArchivedOffset] = useState(0);
  const [archivedError, setArchivedError] = useState<string | null>(null);

  const { listConversations, archiveConversation, unarchiveConversation, listArchivedConversations } = useConversationsApi();

  // Fetch first page — renders immediately
  const loadConversations = useCallback(async (isInitialLoad: boolean = false): Promise<Conversation[]> => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await listConversations(0, projectId, 10);
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
      const response = await listConversations(offset, projectId, 10);
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
    if (onConversationView && projectId) {
      onConversationView(projectId, conversation.id, conversation.agent_name);
    }
    const isArchived = archivedConversations.some((c) => c.id === conversation.id);
    onSelectConversation(conversation, isArchived);

    if (window.innerWidth <= 1280 && onToggleCollapsed && !collapsed) {
      onToggleCollapsed();
    }
  };

  // Close menu on click-outside
  useEffect(() => {
    if (openMenuId === null) return;
    const handleClickOutside = () => setOpenMenuId(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openMenuId]);

  const handleMenuToggle = (e: React.MouseEvent, conversation: Conversation, type: 'active' | 'archived') => {
    e.stopPropagation();
    setMenuPosition({ x: e.clientX, y: e.clientY });
    setOpenMenuId((prev) => (prev === conversation.id ? null : conversation.id));
    setMenuType(type);
    setMenuConversation(conversation);
  };

  const handleArchive = async (e: React.MouseEvent, conversation: Conversation) => {
    e.stopPropagation();
    setOpenMenuId(null);
    if (archivingId !== null) return;

    setArchivingId(conversation.id);
    try {
      await archiveConversation(conversation.id, projectId);
      setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
      if (archivedExpanded) {
        setArchivedConversations((prev) => [conversation, ...prev]);
      }
    } catch (err) {
      console.error('Failed to archive conversation:', err);
    } finally {
      setArchivingId(null);
    }
  };

  const handleUnarchive = async (e: React.MouseEvent, conversation: Conversation) => {
    e.stopPropagation();
    setOpenMenuId(null);
    if (unarchivingId !== null) return;

    setUnarchivingId(conversation.id);
    try {
      await unarchiveConversation(conversation.id, projectId);
      setArchivedConversations((prev) => prev.filter((c) => c.id !== conversation.id));
      setConversations((prev) => {
        const updated = [...prev, conversation];
        updated.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        return updated;
      });
    } catch (err) {
      console.error('Failed to unarchive conversation:', err);
    } finally {
      setUnarchivingId(null);
    }
  };

  const loadArchivedConversations = useCallback(async () => {
    setIsLoadingArchived(true);
    setArchivedError(null);
    try {
      const response = await listArchivedConversations(0, projectId, 10);
      setArchivedConversations(response.conversations);
      setHasMoreArchived(response.has_more);
      setArchivedOffset(response.conversations.length);
    } catch (err: unknown) {
      const error = err as { message?: string };
      setArchivedError(error.message || 'Failed to load archived conversations');
    } finally {
      setIsLoadingArchived(false);
    }
  }, [projectId, listArchivedConversations]);

  const loadMoreArchived = useCallback(async () => {
    if (isLoadingMoreArchived || !hasMoreArchived) return;
    setIsLoadingMoreArchived(true);
    try {
      const response = await listArchivedConversations(archivedOffset, projectId, 10);
      setArchivedConversations((prev) => [...prev, ...response.conversations]);
      setHasMoreArchived(response.has_more);
      setArchivedOffset((prev) => prev + response.conversations.length);
    } catch (err) {
      console.error('Failed to load more archived conversations:', err);
    } finally {
      setIsLoadingMoreArchived(false);
    }
  }, [isLoadingMoreArchived, hasMoreArchived, archivedOffset, projectId, listArchivedConversations]);

  const handleToggleArchived = () => {
    const nextExpanded = !archivedExpanded;
    setArchivedExpanded(nextExpanded);
    if (nextExpanded) {
      loadArchivedConversations();
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
            <div className={`supportingMaterialsEmptyState ${selectedView === 'supporting-materials' ? 'selected' : ''}`} onClick={onSelectSupportingMaterials} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectSupportingMaterials?.(); }}>
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
        <div className="sidebarSection" style={{ marginBottom: 0 }}>
          <div className="sidebarSectionHeader">
            <h3 className="sidebarSectionTitle">Feedback & conversations</h3>
            <button
              className="newConversationButton"
              onClick={onNewConversation}
              aria-label="New conversation"
              title="New conversation"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 2V14M2 8H14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              New
            </button>
          </div>
        </div>
      )}

      {/* Conversations List */}
      {!collapsed && (
        <div className="conversationsList" ref={listRef}>
        {/* Active section */}
        <ConversationSection
          label="Active"
          conversations={filteredConversations}
          selectedConversationId={selectedConversationId}
          onSelectConversation={handleSelectConversation}
          onMenuToggle={handleMenuToggle}
          menuType="active"
          openMenuId={openMenuId}
          formatDateTime={formatDateTime}
          isLoading={isLoading && conversations.length === 0}
          isLoadingMore={isLoadingMore}
          error={error}
          onRetry={() => loadConversations(true)}
          actionSpinnerId={archivingId}
          headerSlot={draftConversation ? (
            <div
              className={`conversationItem ${selectedConversationId === -1 ? 'selected' : ''}`}
              onClick={() => onSelectConversation(draftConversation as Conversation)}
            >
              <h4 className="conversationItemTitle">{draftConversation.title || 'New Conversation'}</h4>
              {draftConversation.created_at && (
                <span className="conversationItemDate">{formatDateTime(draftConversation.created_at)}</span>
              )}
            </div>
          ) : undefined}
          emptyContent={!draftConversation ? (
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
          ) : undefined}
        />

        {/* Archived section */}
        {!isLoading && (
          <ConversationSection
            label="Archived"
            conversations={archivedConversations}
            selectedConversationId={selectedConversationId}
            onSelectConversation={handleSelectConversation}
            onMenuToggle={handleMenuToggle}
            menuType="archived"
            openMenuId={openMenuId}
            formatDateTime={formatDateTime}
            collapsible
            expanded={archivedExpanded}
            onToggle={handleToggleArchived}
            isLoading={isLoadingArchived}
            isLoadingMore={isLoadingMoreArchived}
            error={archivedError}
            onRetry={loadArchivedConversations}
            hasMore={hasMoreArchived}
            onLoadMore={loadMoreArchived}
            actionSpinnerId={unarchivingId}
            itemClassName="archivedConversationItem"
            emptyContent={<p className="archivedEmpty">No archived conversations</p>}
          />
        )}
        </div>
      )}
      </div>

      {/* Fixed context menu rendered outside the scrollable list */}
      {openMenuId !== null && menuConversation && (
        <div
          className="conversationMenu"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuType === 'active' ? (
            <button
              className="conversationMenuItem"
              onClick={(e) => handleArchive(e, menuConversation)}
              disabled={archivingId === menuConversation.id}
            >
              {archivingId === menuConversation.id ? 'Archiving…' : 'Archive'}
            </button>
          ) : (
            <button
              className="conversationMenuItem"
              onClick={(e) => handleUnarchive(e, menuConversation)}
              disabled={unarchivingId === menuConversation.id}
            >
              {unarchivingId === menuConversation.id ? 'Unarchiving…' : 'Unarchive'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
