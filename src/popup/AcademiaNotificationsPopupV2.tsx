import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { trackTriggerDiffReview, trackTriggerFullReview } from './utils/analytics';
import { onVisibilityChanged, cacheFullStoryConfig } from './utils/fullstory';
import { ConversationView } from './popupV2/ConversationView';
import {
  NotificationData,
  ViewMode,
  ReviewState,
  ProjectStatusResponse,
  WordPollResponse,
  styles,
  serverUrl,
  tokenParam,
  widParam,
  pidParam,
  postBridge,
  navigateToPage,
  POPUP_HEIGHT_NO_NOTIFICATIONS,
  POPUP_HEIGHT_ONE_NOTIFICATION,
  POPUP_HEIGHT_TWO_NOTIFICATIONS,
  POPUP_HEIGHT_REVIEW_VIEW,
  POPUP_HEIGHT_ENABLE_FEEDBACK,
  POPUP_HEIGHT_UNSAVED_DOCUMENT,
  REVIEW_STATUS_CARD_HEIGHT,
} from './popupV2/shared';
import { useWordPollWebSocket } from './popupV2/useWordPollWebSocket';
import { MenuView, EnableFeedbackView } from './popupV2/MenuView';


console.log('[AcademiaNotificationsPopupV2] Initializing...');

const AcademiaNotificationsPopupV2: React.FC = () => {
  console.log('[AcademiaNotificationsPopupV2] Component mounting');

  // State for review notifications (up to 2 most recent, any type)
  const [recentReviewNotifications, setRecentReviewNotifications] = useState<NotificationData[]>([]);
  // State for project file info (fetched from /word/:pid/poll)
  const [projectId, setProjectId] = useState<number | null>(null);
  const [fileId, setFileId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [error, setError] = useState<string | null>(null);
  const [isEnableFeedback, setIsEnableFeedback] = useState(false);
  const [isUnsavedDocument, setIsUnsavedDocument] = useState(false);

  // State for review status
  const [reviewState, setReviewState] = useState<ReviewState>('idle');
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Track previous height to avoid unnecessary resize calls (prevents infinite loop)
  const previousHeightRef = useRef<number>(0);
  // Track logged notification IDs to avoid stale closure logging issues
  const loggedReviewIdsRef = useRef<Set<number>>(new Set());
  // Track previous width to avoid unnecessary resize calls (same pattern as previousHeightRef)
  const previousWidthRef = useRef<number>(0);

  // Resize state — persists user-chosen size across gestures
  const accumulatedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    baseWidth: number;
    baseHeight: number;
    rafId: number | null;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

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

  // Fetch project status to determine review state
  const fetchProjectStatus = async (projId: number, fId: number, token: string | null): Promise<void> => {
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(
        `${serverUrl}/proxy-api/v0/co_scientist/projects/${projId}/status?file_id=${fId}`,
        { headers }
      );

      if (!response.ok) {
        console.error('[AcademiaNotificationsPopupV2] Failed to fetch project status:', response.status);
        return;
      }

      const data: ProjectStatusResponse = await response.json();

      if (data.agent_runs.length === 0) {
        setReviewState('idle');
        return;
      }

      const sortedRuns = [...data.agent_runs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      const latest = sortedRuns[0];

      switch (latest.status) {
        case 'pending':
        case 'processing':
          setReviewState('reviewing');
          if (reviewState !== 'reviewing') {
            console.log('[AcademiaNotificationsPopupV2] Review in progress on load, starting polling');
            startStatusPolling(projId, fId, token);
          }
          break;
        case 'completed':
          setReviewState('completed');
          break;
        case 'failed':
          setReviewState('failed');
          break;
        default:
          setReviewState('idle');
      }
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error fetching project status:', err);
    }
  };

  // Poll for status updates after triggering a review
  const startStatusPolling = (projId: number, fId: number, token: string | null) => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    setReviewState('reviewing');

    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(
          `${serverUrl}/proxy-api/v0/co_scientist/projects/${projId}/status?file_id=${fId}`,
          { headers }
        );

        if (!response.ok) return;

        const data: ProjectStatusResponse = await response.json();

        if (data.agent_runs.length === 0) return;

        const sortedRuns = [...data.agent_runs].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        const latest = sortedRuns[0];

        if (latest.status === 'completed' || latest.status === 'failed') {
          clearInterval(pollInterval);
          pollingIntervalRef.current = null;
          setReviewState(latest.status === 'completed' ? 'completed' : 'failed');
          console.log(`[AcademiaNotificationsPopupV2] Polling stopped - status: ${latest.status}`);

          if (latest.status === 'completed') {
            try {
              await fetch(`${serverUrl}/api/notifications/sync`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              console.log('[AcademiaNotificationsPopupV2] Triggered notification sync after review completion');
            } catch (err) {
              console.error('[AcademiaNotificationsPopupV2] Failed to trigger notification sync:', err);
            }
          }
        }
      } catch (err) {
        console.error('[AcademiaNotificationsPopupV2] Polling error:', err);
      }
    }, 3000);

    pollingIntervalRef.current = pollInterval;

    setTimeout(() => {
      if (pollingIntervalRef.current === pollInterval) {
        clearInterval(pollInterval);
        pollingIntervalRef.current = null;
        console.log('[AcademiaNotificationsPopupV2] Polling stopped - max duration reached');
      }
    }, 5 * 60 * 1000);
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  // WebSocket-based polling
  const pollData = useWordPollWebSocket(widParam, tokenParam, serverUrl);

  // React to pollData changes to update component state
  useEffect(() => {
    console.log('[AcademiaNotificationsPopupV2] pollData changed:', pollData);
    if (!pollData) return;

    if (pollData.fullStoryConfig) cacheFullStoryConfig(pollData.fullStoryConfig);
    onVisibilityChanged('popup', pollData.shouldShowPopupV2 ?? false);

    setIsEnableFeedback(pollData.isEnableFeedback ?? false);
    setIsUnsavedDocument(pollData.isUnsavedDocument ?? false);

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

  // Check project status periodically if we have IDs
  useEffect(() => {
    if (!projectId || !fileId) return;

    const checkStatus = async () => {
      await fetchProjectStatus(projectId, fileId, tokenParam);
    };

    checkStatus();

    const intervalId = setInterval(checkStatus, 10000);

    return () => clearInterval(intervalId);
  }, [projectId, fileId, tokenParam]);

  // Handle window resizing based on view mode and notification count
  useEffect(() => {
    let height: number;

    if (isEnableFeedback && isUnsavedDocument) {
      height = POPUP_HEIGHT_UNSAVED_DOCUMENT;
    } else if (isEnableFeedback) {
      height = POPUP_HEIGHT_ENABLE_FEEDBACK;
    } else if (viewMode === 'review') {
      height = POPUP_HEIGHT_REVIEW_VIEW;
    } else if (recentReviewNotifications.length >= 2) {
      height = POPUP_HEIGHT_TWO_NOTIFICATIONS;
    } else if (recentReviewNotifications.length === 1) {
      height = POPUP_HEIGHT_ONE_NOTIFICATION;
    } else {
      height = POPUP_HEIGHT_NO_NOTIFICATIONS;
    }

    const isReviewActive = pollData?.isReviewingSelectedText && pollData?.reviewType;
    if (isReviewActive && viewMode === 'menu') {
      height += REVIEW_STATUS_CARD_HEIGHT;
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
  }, [isEnableFeedback, isUnsavedDocument, viewMode, recentReviewNotifications, pollData, isWide]);

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

  const handleGenerateShortReview = async () => {
    if (!projectId || !fileId || !widParam) {
      console.error('[AcademiaNotificationsPopupV2] Missing project, file ID, or window ID');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] Triggering diff review...');

    trackTriggerDiffReview('overlay', projectId, fileId);

    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }

      const response = await fetch(
        `${serverUrl}/api/diff-review/${widParam}`,
        {
          method: 'POST',
          headers,
          body: '{}',
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json();
      console.log('[AcademiaNotificationsPopupV2] Diff review triggered:', data);

      startStatusPolling(projectId, fileId, tokenParam);
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Failed to trigger diff review:', err);
      setReviewState('failed');
    }
  };

  const handleGenerateFullReview = async () => {
    if (!projectId || !fileId || !widParam) {
      console.error('[AcademiaNotificationsPopupV2] Missing project, file ID, or window ID');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] Triggering full review...');

    trackTriggerFullReview('overlay', projectId, fileId);

    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }

      const response = await fetch(
        `${serverUrl}/api/full-paper-review/${widParam}`,
        {
          method: 'POST',
          headers,
          body: '{}',
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json();
      console.log('[AcademiaNotificationsPopupV2] Full review triggered:', data);

      startStatusPolling(projectId, fileId, tokenParam);
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Failed to trigger full review:', err);
      setReviewState('failed');
    }
  };

  // --- Resize pointer handlers ---
  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
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
    setIsResizing(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.modal}>
        {/* Resize handle at top-right corner — only in review view */}
        {viewMode === 'review' && (
          <div
            style={{
              ...styles.resizeHandle,
              cursor: isResizing ? 'ne-resize' : 'ne-resize',
            }}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
          />
        )}
        {isEnableFeedback
          ? <EnableFeedbackView isUnsavedDocument={isUnsavedDocument} />
          : viewMode === 'review' && activeNotification
            ? <ConversationView
                activeNotification={activeNotification}
                projectId={activeNotification.project_id}
                onBack={handleBackFromReview}
                onClose={handleClose}
                setRecentReviewNotifications={setRecentReviewNotifications}
                isWide={isWide}
                onToggleWidth={handleToggleWidth}
              />
            : <MenuView
                recentReviewNotifications={recentReviewNotifications}
                isLoading={isLoading}
                projectId={projectId}
                fileId={fileId}
                reviewState={reviewState}
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
