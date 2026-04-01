import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { trackTriggerDiffReview, trackTriggerFullReview } from './utils/analytics';
import { onVisibilityChanged, cacheFullStoryConfig } from './utils/fullstory';
import { ConversationView } from './popupV2/ConversationView';
import {
  ConversationItem,
  NotificationData,
  ViewMode,
  ReviewState,
  styles,
  serverUrl,
  tokenParam,
  widParam,
  pidParam,
  postBridge,
  getV4FocusedWid,
  navigateToPage,
  CloseIcon,
  WidthToggleIcon,
  POPUP_HEIGHT_NO_NOTIFICATIONS,
  POPUP_HEIGHT_REVIEW_VIEW,
  POPUP_HEIGHT_ENABLE_FEEDBACK,
  POPUP_HEIGHT_UNSAVED_DOCUMENT,
  POPUP_HEIGHT_PER_CONVERSATION,
  REVIEW_STATUS_CARD_HEIGHT,
  ERROR_MESSAGE_HEIGHT,
} from './popupV2/shared';
import { useWordPollWebSocket } from './popupV2/useWordPollWebSocket';
import { MenuView, EnableFeedbackView } from './popupV2/MenuView';


console.log('[AcademiaNotificationsPopupV2] Initializing...');

const AcademiaNotificationsPopupV2: React.FC = () => {
  console.log('[AcademiaNotificationsPopupV2] Component mounting');

  // State for review notifications (up to 2 most recent, any type)
  const [recentReviewNotifications, setRecentReviewNotifications] = useState<NotificationData[]>([]);
  // State for all conversations (fetched from list_conversations API)
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  // State for project file info (fetched from /word/:pid/poll)
  const [projectId, setProjectId] = useState<number | null>(null);
  const [fileId, setFileId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [error, setError] = useState<string | null>(null);
  const [isEnableFeedback, setIsEnableFeedback] = useState(false);
  const [isUnsavedDocument, setIsUnsavedDocument] = useState(false);
  const [reviewErrorMessage, setReviewErrorMessage] = useState<string | null>(null);

  // State for save prompt before review
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [showPermissionPrompt, setShowPermissionPrompt] = useState(false);
  const [savePromptReviewType, setSavePromptReviewType] = useState<'diff' | 'full' | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // State for review status
  const [reviewState, setReviewState] = useState<ReviewState>('idle');
  // Track previous height to avoid unnecessary resize calls (prevents infinite loop)
  const previousHeightRef = useRef<number>(0);
  // Track logged notification IDs to avoid stale closure logging issues
  const loggedReviewIdsRef = useRef<Set<number>>(new Set());
  // Track previous width to avoid unnecessary resize calls (same pattern as previousHeightRef)
  const previousWidthRef = useRef<number>(0);

  // Title bar drag state
  const DRAG_THRESHOLD = 3;
  const titleBarAccumulatedOffsetRef = useRef({ dx: 0, dy: 0 });
  const titleBarDragStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    baseOffsetX: number;
    baseOffsetY: number;
    didDrag: boolean;
    rafId: number | null;
  } | null>(null);
  const [isTitleBarDragging, setIsTitleBarDragging] = useState(false);

  // Resize state — persists user-chosen size across gestures
  const accumulatedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    baseWidth: number;
    baseHeight: number;
    rafId: number | null;
  } | null>(null);

  // State for inline review view
  const [viewMode, setViewMode] = useState<ViewMode>('menu');
  const [activeNotification, setActiveNotification] = useState<NotificationData | null>(null);

  // Width toggle state
  const [isWide, setIsWide] = useState(false);
  const narrowWidthRef = useRef<number>(window.innerWidth);
  const WIDE_WIDTH = 700;
  const sizeAnimRef = useRef<number | null>(null);

  // Animate popup size (width and/or height) over ~250ms with ease-out
  const animateSize = (fromWidth: number, toWidth: number, fromHeight: number, toHeight: number, onDone?: () => void) => {
    if (sizeAnimRef.current !== null) cancelAnimationFrame(sizeAnimRef.current);
    if (Math.round(fromWidth) === Math.round(toWidth) && Math.round(fromHeight) === Math.round(toHeight)) {
      onDone?.();
      return;
    }
    const duration = 250;
    const startTime = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad
      const w = Math.round(fromWidth + (toWidth - fromWidth) * eased);
      const h = Math.round(fromHeight + (toHeight - fromHeight) * eased);
      postBridge('setPopupSize', { width: w, height: h });
      if (t < 1) {
        sizeAnimRef.current = requestAnimationFrame(step);
      } else {
        sizeAnimRef.current = null;
        accumulatedSizeRef.current = { width: toWidth, height: toHeight };
        onDone?.();
      }
    };
    sizeAnimRef.current = requestAnimationFrame(step);
  };

  // WebSocket-based polling
  const pollData = useWordPollWebSocket(widParam, tokenParam, serverUrl);
  const effectiveWid = getV4FocusedWid();

  // Derive review state from word poll data (pushed via WebSocket)
  useEffect(() => {
    if (!pollData?.projectReviewState) return;
    const state = pollData.projectReviewState;
    console.log('[AcademiaNotificationsPopupV2] Review state from poll data:', state);
    setReviewState(state);
  }, [pollData?.projectReviewState]);

  // React to pollData changes to update component state
  useEffect(() => {
    console.log('[AcademiaNotificationsPopupV2] pollData changed:', pollData);
    if (!pollData) return;

    if (pollData.fullStoryConfig) cacheFullStoryConfig(pollData.fullStoryConfig);
    onVisibilityChanged('popup', pollData.shouldShowPopupV2 ?? false);

    setIsEnableFeedback(pollData.isEnableFeedback ?? false);
    setIsUnsavedDocument(pollData.isUnsavedDocument ?? false);
    setReviewErrorMessage(pollData.reviewErrorMessage ?? null);

    if (!pollData.shouldShowPopupV2 && !pollData.isEnableFeedback) {
      console.log(`[AcademiaNotificationsPopupV2] Hiding popup: shouldShowPopupV2=false. Active path: ${pollData.activeDocumentPath || 'none'}`);
      // Cancel any running size animation to stop stale setPopupSize calls
      if (sizeAnimRef.current !== null) {
        cancelAnimationFrame(sizeAnimRef.current);
        sizeAnimRef.current = null;
      }
      previousHeightRef.current = 0;
      previousWidthRef.current = 0;
      accumulatedSizeRef.current = null;
      postBridge('closeWindow').catch(() => {});
      return;
    }

    if (pollData.projectId && pollData.projectFileId) {
      setProjectId(pollData.projectId);
      setFileId(pollData.projectFileId);
      setIsLoading(false);

      const incoming = pollData.recentReviewNotifications || [];
      const incomingIds = new Set(incoming.map(n => n.id));

      for (const n of incoming) {
        if (!loggedReviewIdsRef.current.has(n.id)) {
          console.log('[AcademiaNotificationsPopupV2] Found NEW review notification:', n);
        }
      }
      loggedReviewIdsRef.current = incomingIds;

      setRecentReviewNotifications(incoming);
    } else {
      setIsLoading(false);
    }
  }, [pollData]);

  // Fetch conversations when projectId becomes available
  useEffect(() => {
    if (!projectId) return;
    const params = new URLSearchParams({
      offset: '0',
      limit: '5',
      parent_id: projectId.toString(),
      parent_type: 'Project',
    });
    const headers: Record<string, string> = {};
    if (tokenParam) headers['Authorization'] = `Bearer ${tokenParam}`;
    fetch(`${serverUrl}/proxy-api/v0/co_scientist/list_conversations?${params}`, { headers })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.conversations) setConversations(data.conversations); })
      .catch(() => {});
  }, [projectId]);

  // Handle window resizing based on view mode and notification count
  useEffect(() => {
    let height: number;

    if (showSavePrompt || showPermissionPrompt) {
      height = POPUP_HEIGHT_ENABLE_FEEDBACK; // Similar size to enable feedback view
    } else if (isEnableFeedback && isUnsavedDocument) {
      height = POPUP_HEIGHT_UNSAVED_DOCUMENT;
    } else if (isEnableFeedback) {
      height = POPUP_HEIGHT_ENABLE_FEEDBACK;
    } else if (viewMode === 'review') {
      height = POPUP_HEIGHT_REVIEW_VIEW;
    } else {
      // Base height covers section header + "View all" row + "Get feedback" section
      height = POPUP_HEIGHT_NO_NOTIFICATIONS;
      // Add height for each item in the unified list (up to 5 conversations + any in-progress extras)
      const convIds = new Set(conversations.map(c => c.id));
      const inProgressExtrasCount = recentReviewNotifications.filter(n => n.isInProgress && !convIds.has(n.conversation_id)).length;
      const totalItems = inProgressExtrasCount + Math.min(conversations.length, 5);
      height += totalItems * POPUP_HEIGHT_PER_CONVERSATION;
    }

    const isReviewActive = pollData?.isReviewingSelectedText && pollData?.reviewType;
    if (isReviewActive && viewMode === 'menu') {
      height += REVIEW_STATUS_CARD_HEIGHT;
    }

    if (reviewErrorMessage && viewMode === 'menu') {
      height += ERROR_MESSAGE_HEIGHT;
    }

    const width = isWide ? WIDE_WIDTH : narrowWidthRef.current;

    if (height !== previousHeightRef.current || width !== previousWidthRef.current) {
      const isFirstOpen = !previousHeightRef.current || !previousWidthRef.current;
      if (isFirstOpen) {
        // Snap on first open / reopen — don't animate from 0
        postBridge('setPopupSize', { width, height });
        previousHeightRef.current = height;
        previousWidthRef.current = width;
        accumulatedSizeRef.current = { width, height };
      } else {
        animateSize(previousWidthRef.current, width, previousHeightRef.current, height, () => {
          previousHeightRef.current = height;
          previousWidthRef.current = width;
        });
      }
    }
  }, [isEnableFeedback, isUnsavedDocument, viewMode, recentReviewNotifications, conversations, pollData, isWide, reviewErrorMessage, showSavePrompt, showPermissionPrompt]);

  // Handle clicking on a review notification card - show inline review
  const handleViewReviewFeedback = async (notification: NotificationData) => {
    console.log('[AcademiaNotificationsPopupV2] View review feedback clicked:', notification);

    if (notification.isInProgress) {
      await postBridge('setReviewState', {
        projectId: notification.project_id,
        reviewType: notification.review_type,
        selectedText: notification.selected_text,
      });
      await postBridge('closeWindow', { clearReviewState: false });
      return;
    }

    if (!notification.isRead) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (tokenParam) {
          headers['Authorization'] = `Bearer ${tokenParam}`;
        }

        await fetch(`${serverUrl}/api/notifications/${notification.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'read' }),
        });

        setRecentReviewNotifications(prev =>
          prev.map(n => n.id === notification.id ? { ...n, isRead: true } : n)
        );
        console.log('[AcademiaNotificationsPopupV2] Review notification marked as read');
      } catch (err) {
        console.error('[AcademiaNotificationsPopupV2] Error marking notification as read:', err);
      }
    }

    setActiveNotification(notification);
    setViewMode('review');

    // Auto-widen on entering conversation view
    setIsWide(true);
    const currentWidth = accumulatedSizeRef.current?.width ?? window.innerWidth;
    const currentHeight = accumulatedSizeRef.current?.height ?? window.innerHeight;
    animateSize(currentWidth, WIDE_WIDTH, currentHeight, POPUP_HEIGHT_REVIEW_VIEW);
  };

  // Handle clicking "View previous feedback" link
  const handleViewPreviousFeedback = async () => {
    if (!projectId) {
      console.error('[AcademiaNotificationsPopupV2] No project ID for previous feedback');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] View previous feedback clicked');

    try {
      await navigateToPage({
        page: 'conversations',
        projectId,
      }, tokenParam);

      onVisibilityChanged('popup', false);
      postBridge('closeWindow').catch(() => {});
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error in handleViewPreviousFeedback:', err);
    }
  };

  // Handle toggling popup width
  const handleToggleWidth = () => {
    const newIsWide = !isWide;
    setIsWide(newIsWide);
    const currentWidth = accumulatedSizeRef.current?.width ?? window.innerWidth;
    const targetWidth = newIsWide ? WIDE_WIDTH : narrowWidthRef.current;
    const currentHeight = accumulatedSizeRef.current?.height ?? window.innerHeight;
    animateSize(currentWidth, targetWidth, currentHeight, currentHeight);
  };

  // Handle clicking "Back" from review view - return to menu
  const handleBackFromReview = () => {
    console.log('[AcademiaNotificationsPopupV2] Back from review clicked');

    const currentWidth = accumulatedSizeRef.current?.width ?? window.innerWidth;
    const currentHeight = accumulatedSizeRef.current?.height ?? window.innerHeight;
    setIsWide(false);
    setViewMode('menu');
    setActiveNotification(null);
    animateSize(currentWidth, narrowWidthRef.current, currentHeight, currentHeight, () => {
      accumulatedSizeRef.current = null;
      postBridge('clearPopupSize', {});
    });
  };

  const handleClose = async () => {
    console.log('[AcademiaNotificationsPopupV2] Close button clicked');

    try {
      onVisibilityChanged('popup', false);
      await postBridge('closeWindow');
      console.log('[AcademiaNotificationsPopupV2] Close window request sent');
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Close failed:', err);
    }
  };

  const runPreCheck = async (): Promise<{ canProceed: boolean; reason?: string; message?: string }> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenParam) {
      headers['Authorization'] = `Bearer ${tokenParam}`;
    }
    const res = await fetch(`${serverUrl}/api/review-pre-check`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    return res.json();
  };

  const doSaveAndContinue = async (alwaysSave: boolean) => {
    setIsSaving(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }
      const url = alwaysSave ? `${serverUrl}/api/word-save?alwaysSave=true` : `${serverUrl}/api/word-save`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: '{}',
      });
      const data = await res.json();
      if (!data.success) {
        setReviewErrorMessage(data.error || 'Failed to save document.');
        setIsSaving(false);
        setShowSavePrompt(false);
        return;
      }
      setShowSavePrompt(false);
      setIsSaving(false);
      // Re-trigger the review that was blocked
      if (savePromptReviewType === 'diff') {
        triggerDiffReview();
      } else if (savePromptReviewType === 'full') {
        triggerFullReview();
      }
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Save error:', err);
      setReviewErrorMessage('Failed to save document.');
      setIsSaving(false);
      setShowSavePrompt(false);
    }
  };

  const handleSaveAndContinue = () => doSaveAndContinue(false);
  const handleAlwaysSaveAndContinue = () => doSaveAndContinue(true);

  const handleCancelSave = () => {
    setShowSavePrompt(false);
    setSavePromptReviewType(null);
  };

  const triggerDiffReview = async () => {
    if (!projectId || !fileId || !effectiveWid) return;

    trackTriggerDiffReview('overlay', projectId, fileId);
    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }

      const response = await fetch(
        `${serverUrl}/api/diff-review/${effectiveWid}`,
        { method: 'POST', headers, body: '{}' }
      );

      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const data = await response.json();
      console.log('[AcademiaNotificationsPopupV2] Diff review triggered:', data);
      setReviewState('reviewing');
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Failed to trigger diff review:', err);
      setReviewState('failed');
    }
  };

  const triggerFullReview = async () => {
    if (!projectId || !fileId || !effectiveWid) return;

    trackTriggerFullReview('overlay', projectId, fileId);
    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }

      const response = await fetch(
        `${serverUrl}/api/full-paper-review/${effectiveWid}`,
        { method: 'POST', headers, body: '{}' }
      );

      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const data = await response.json();
      console.log('[AcademiaNotificationsPopupV2] Full review triggered:', data);
      setReviewState('reviewing');
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Failed to trigger full review:', err);
      setReviewState('failed');
    }
  };

  const handleGenerateShortReview = async () => {
    if (!projectId || !fileId || !effectiveWid) {
      console.error('[AcademiaNotificationsPopupV2] Missing project, file ID, or window ID');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] Triggering diff review...');

    try {
      const preCheck = await runPreCheck();
      if (!preCheck.canProceed) {
        if (preCheck.reason === 'duplicate_name') {
          setReviewErrorMessage(preCheck.message || 'Multiple windows have the same name.');
          return;
        }
        if (preCheck.reason === 'unsaved_changes') {
          setShowSavePrompt(true);
          setSavePromptReviewType('diff');
          return;
        }
        if (preCheck.reason === 'permission_denied') {
          setShowPermissionPrompt(true);
          setSavePromptReviewType('diff');
          return;
        }
      }
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Pre-check error:', err);
      // Fail-open
    }

    triggerDiffReview();
  };

  const handleGenerateFullReview = async () => {
    if (!projectId || !fileId || !effectiveWid) {
      console.error('[AcademiaNotificationsPopupV2] Missing project, file ID, or window ID');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] Triggering full review...');

    try {
      const preCheck = await runPreCheck();
      console.log('[AcademiaNotificationsPopupV2] Full review pre-check result:', preCheck);
      if (!preCheck.canProceed) {
        if (preCheck.reason === 'duplicate_name') {
          setReviewErrorMessage(preCheck.message || 'Multiple windows have the same name.');
          return;
        }
        if (preCheck.reason === 'unsaved_changes') {
          setShowSavePrompt(true);
          setSavePromptReviewType('full');
          return;
        }
        if (preCheck.reason === 'permission_denied') {
          setShowPermissionPrompt(true);
          setSavePromptReviewType('full');
          return;
        }
      }
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Pre-check error:', err);
      // Fail-open
    }

    triggerFullReview();
  };

  // --- Title bar drag handlers ---
  const handleTitleBarPointerDown = async (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Fetch the server's current drag offset to use as base (prevents position jump if button was dragged first)
    let baseOffsetX = titleBarAccumulatedOffsetRef.current.dx;
    let baseOffsetY = titleBarAccumulatedOffsetRef.current.dy;
    try {
      const res = await fetch(`${serverUrl}/api/drag-offset?wid=${effectiveWid}`, {
        headers: tokenParam ? { Authorization: `Bearer ${tokenParam}` } : {},
      });
      if (res.ok) {
        const offset = await res.json();
        baseOffsetX = offset.dx ?? baseOffsetX;
        baseOffsetY = offset.dy ?? baseOffsetY;
        titleBarAccumulatedOffsetRef.current = { dx: baseOffsetX, dy: baseOffsetY };
      }
    } catch {
      // Fall back to locally tracked offset
    }
    setIsTitleBarDragging(true);
    titleBarDragStateRef.current = {
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      baseOffsetX,
      baseOffsetY,
      didDrag: false,
      rafId: null,
    };
  };

  const handleTitleBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = titleBarDragStateRef.current;
    if (!ds) return;

    const dx = e.screenX - ds.startScreenX;
    const dy = -(e.screenY - ds.startScreenY); // Cocoa Y is inverted

    if (!ds.didDrag && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      ds.didDrag = true;
    }
    if (!ds.didDrag) return;

    if (ds.rafId !== null) return;
    ds.rafId = requestAnimationFrame(() => {
      ds.rafId = null;
      postBridge('setDragOffset', {
        dx: ds.baseOffsetX + dx,
        dy: ds.baseOffsetY + dy,
      });
    });
  };

  const handleTitleBarPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const ds = titleBarDragStateRef.current;
    if (ds) {
      if (ds.rafId !== null) cancelAnimationFrame(ds.rafId);
      if (ds.didDrag) {
        const dx = e.screenX - ds.startScreenX;
        const dy = -(e.screenY - ds.startScreenY);
        const finalDx = ds.baseOffsetX + dx;
        const finalDy = ds.baseOffsetY + dy;
        postBridge('setDragOffset', { dx: finalDx, dy: finalDy });
        titleBarAccumulatedOffsetRef.current = { dx: finalDx, dy: finalDy };
      }
    }
    titleBarDragStateRef.current = null;
    setIsTitleBarDragging(false);
  };

  // --- Resize pointer handlers ---
  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ne-resize';
    const currentWidth = accumulatedSizeRef.current?.width ?? window.innerWidth;
    const currentHeight = accumulatedSizeRef.current?.height ?? window.innerHeight;
    resizeStateRef.current = {
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      baseWidth: currentWidth,
      baseHeight: currentHeight,
      rafId: null,
    };
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rs = resizeStateRef.current;
    if (!rs) return;
    if (rs.rafId !== null) return;
    rs.rafId = requestAnimationFrame(() => {
      rs.rafId = null;
      const deltaX = e.screenX - rs.startScreenX;
      const deltaY = -(e.screenY - rs.startScreenY);
      const newWidth = Math.max(370, rs.baseWidth + deltaX);
      const newHeight = Math.max(previousHeightRef.current, rs.baseHeight + deltaY);
      postBridge('setPopupSize', { width: Math.round(newWidth), height: Math.round(newHeight) });
    });
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const rs = resizeStateRef.current;
    if (rs) {
      if (rs.rafId !== null) {
        cancelAnimationFrame(rs.rafId);
      }
      const deltaX = e.screenX - rs.startScreenX;
      const deltaY = -(e.screenY - rs.startScreenY);
      const finalWidth = Math.max(370, rs.baseWidth + deltaX);
      const finalHeight = Math.max(previousHeightRef.current, rs.baseHeight + deltaY);
      postBridge('setPopupSize', { width: Math.round(finalWidth), height: Math.round(finalHeight) });
      accumulatedSizeRef.current = { width: finalWidth, height: finalHeight };
    }
    resizeStateRef.current = null;
    document.body.style.cursor = '';
  };

  return (
    <div style={styles.container}>
      <div style={{ ...styles.modal, overflowY: viewMode === 'review' ? 'hidden' : 'auto' }}>
        {/* Draggable title bar */}
        <div
          style={{ ...styles.titleBar, cursor: isTitleBarDragging ? 'grabbing' : 'default' }}
          onPointerDown={handleTitleBarPointerDown}
          onPointerMove={handleTitleBarPointerMove}
          onPointerUp={handleTitleBarPointerUp}
        >
          {/* Left spacer balances the right-side buttons to keep title visually centered */}
          <div style={{ width: '44px', flexShrink: 0 }} />
          <span style={styles.titleBarText}>Academia</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            <button
              style={styles.titleBarCloseBtn}
              onClick={handleToggleWidth}
              onPointerDown={e => e.stopPropagation()}
              aria-label={isWide ? 'Narrow window' : 'Widen window'}
              title={isWide ? 'Narrow window' : 'Widen window'}
            >
              <WidthToggleIcon />
            </button>
            <button
              style={styles.titleBarCloseBtn}
              onClick={handleClose}
              onPointerDown={e => e.stopPropagation()}
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        {/* Resize handle at top-right corner, within title bar area */}
        <div
          style={{
            ...styles.resizeHandle,
            cursor: 'ne-resize',
          }}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
        />
        {showPermissionPrompt ? (
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '15px', color: '#374151', lineHeight: '1.5' }}>
              Unable to check for unsaved changes. Remember to save before reviewing.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setShowPermissionPrompt(false); setSavePromptReviewType(null); }}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#FFFFFF',
                  color: '#374151',
                  border: '1px solid #D1D5DB',
                  borderRadius: '8px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
                }}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#FFFFFF',
                  color: '#374151',
                  border: '1px solid #D1D5DB',
                  borderRadius: '8px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Enable Permissions
              </button>
              <button
                onClick={() => {
                  setShowPermissionPrompt(false);
                  if (savePromptReviewType === 'diff') {
                    triggerDiffReview();
                  } else if (savePromptReviewType === 'full') {
                    triggerFullReview();
                  }
                  setSavePromptReviewType(null);
                }}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#000000',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '8px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Continue Review
              </button>
            </div>
          </div>
        ) : showSavePrompt ? (
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: '15px', color: '#374151', lineHeight: '1.5' }}>
              Reviewing requires saving the document.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCancelSave}
                disabled={isSaving}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#FFFFFF',
                  color: '#374151',
                  border: '1px solid #D1D5DB',
                  borderRadius: '8px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  opacity: isSaving ? 0.5 : 1,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveAndContinue}
                disabled={isSaving}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#FFFFFF',
                  color: '#374151',
                  border: '1px solid #D1D5DB',
                  borderRadius: '8px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  opacity: isSaving ? 0.5 : 1,
                }}
              >
                {isSaving ? 'Saving...' : 'Save and Continue'}
              </button>
              <button
                onClick={handleAlwaysSaveAndContinue}
                disabled={isSaving}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#000000',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '8px',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  opacity: isSaving ? 0.7 : 1,
                }}
              >
                {isSaving ? 'Saving...' : 'Always Save and Continue'}
              </button>
            </div>
          </div>
        ) : isEnableFeedback
          ? <EnableFeedbackView isUnsavedDocument={isUnsavedDocument} />
          : viewMode === 'review' && activeNotification
            ? <ConversationView
                activeNotification={activeNotification}
                projectId={activeNotification.project_id}
                onBack={handleBackFromReview}
                onClose={handleClose}
                setRecentReviewNotifications={setRecentReviewNotifications}
              />
            : <MenuView
                recentReviewNotifications={recentReviewNotifications}
                conversations={conversations}
                isLoading={isLoading}
                projectId={projectId}
                fileId={fileId}
                reviewState={reviewState}
                reviewErrorMessage={reviewErrorMessage}
                onClose={handleClose}
                onViewReviewFeedback={handleViewReviewFeedback}
                onViewPreviousFeedback={handleViewPreviousFeedback}
                onGenerateShortReview={handleGenerateShortReview}
                onGenerateFullReview={handleGenerateFullReview}
              />}
      </div>
    </div>
  );
};

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<AcademiaNotificationsPopupV2 />);
  console.log('[AcademiaNotificationsPopupV2] React app initialized');
} else {
  console.error('[AcademiaNotificationsPopupV2] Root container not found!');
}
