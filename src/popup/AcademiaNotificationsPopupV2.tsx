import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import DOMPurify from 'isomorphic-dompurify';
import { trackTriggerDiffReview, trackTriggerFullReview } from './utils/analytics';
import { onVisibilityChanged, cacheFullStoryConfig, FullStoryConfig } from './utils/fullstory';
import { FEEDBACK_FORM_URL } from '../shared/constants';

console.log('[AcademiaNotificationsPopupV2] Initializing...');

// FullStory is lazily initialized on first popup show via onVisibilityChanged()

// Get serverUrl from window.location.origin (popup is served from the HTTP server)
// This ensures we use the correct port even when server binds to fallback port
const serverUrl = window.location.origin;

// Generate unique instance ID for logging (uses PID from URL or random ID)
const popupUrlParams = new URLSearchParams(window.location.search);
const pidParam = popupUrlParams.get('pid');
const widParam = popupUrlParams.get('wid');
const tokenParam = popupUrlParams.get('token');
const popupInstanceId = `AcademiaNotificationsPopupV2-${widParam || pidParam || Math.random().toString(36).substring(2, 8)}`;

// POST bridge helper — replaces native bridge calls (closeWindow, resizeWindow)
function postBridge(action: string, payload: Record<string, unknown> = {}) {
  return fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: Number(pidParam), wid: widParam }),
  });
}

// Height constants matching native window sizes (updated for new layout)
const POPUP_HEIGHT_NO_NOTIFICATIONS = 240;    // "View previous feedback" row + "Get feedback" buttons
const POPUP_HEIGHT_ONE_NOTIFICATION = 320;    // 1 notification card + above
const POPUP_HEIGHT_TWO_NOTIFICATIONS = 400;   // 2 notification cards + above
const POPUP_HEIGHT_REVIEW_VIEW = 660;         // Height when showing inline review content
const REVIEW_STATUS_CARD_HEIGHT = 72;         // Height of review status card (60px card + 12px gap)

// Arrow Forward Icon component
const ArrowForwardIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12 4L10.59 5.41L16.17 11H4V13H16.17L10.59 18.59L12 20L20 12L12 4Z"
      fill="#141413"
    />
  </svg>
);

// Notifications Icon (bell) component
const NotificationsIcon: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"
      fill="#141413"
    />
  </svg>
);

// Chat Bubble Icon component
const ChatBubbleIcon: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"
      fill="#141413"
    />
  </svg>
);

// Loading Spinner component
const LoadingSpinner: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ animation: 'spin 1s linear infinite' }}>
    <circle cx="12" cy="12" r="10" stroke="#141413" strokeWidth="3" fill="none" opacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" stroke="#141413" strokeWidth="3" strokeLinecap="round" fill="none" />
  </svg>
);

// Close Icon (X) component
const CloseIcon: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M15 5L5 15M5 5L15 15"
      stroke="#141413"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

// Arrow Back Icon component
const ArrowBackIcon: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M20 11H7.83L13.42 5.41L12 4L4 12L12 20L13.41 18.59L7.83 13H20V11Z"
      fill="#141413"
    />
  </svg>
);

// Format notification timestamp to readable date string
const formatNotificationDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  const day = date.getDate();
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase();
  return `${weekday}, ${month} ${day} at ${time}`;
};

// Type definitions for project status API
type AgentRunStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface AgentRun {
  agent_run_id: number;
  agent_name: string;
  file_id: number;
  file_name: string;
  status: AgentRunStatus;
  running_jobs_count: number;
  created_at: string;
  review_data: unknown | null;
}

interface ProjectStatusResponse {
  project_id: number;
  agent_runs: AgentRun[];
}

// Notification data type for review notifications
type NotificationData = {
  id: number;
  project_id: number;
  conversation_id: number;
  created_at: number;
  title: string; // Notification title (e.g., "New thoughts on your research!")
  conversation_title?: string; // Conversation title (e.g., "Daily Feedback | Tue, 13 Jan 2026")
  body_html?: string; // HTML content for notification display
  isRead: boolean;
  selected_text?: string; // Selected text that was reviewed (for selected-text reviews)
  review_type?: 'full-paper' | 'selected-text' | 'review-changes'; // Type of review
  isInProgress?: boolean; // True if this is an in-progress review (not yet completed)
};

// Define response type locally to avoid importing server types in client code
interface WordPollResponse {
  shouldShow: boolean;
  projectId?: number;
  projectFileId?: number;
  notificationCount?: number;
  isActive: boolean;
  recentReviewNotifications?: NotificationData[];
  activeDocumentPath?: string | null;
  isReviewingSelectedText?: boolean;
  reviewType?: 'full-paper' | 'selected-text' | 'review-changes';
  selectedTextReviewStartedAt?: number;
  selectedText?: string;
  shouldShowButtonV2?: boolean;
  shouldShowPopupV2?: boolean;
  fullStoryConfig?: FullStoryConfig;
}

interface WebSocketMessage {
  type: 'poll';
  data: WordPollResponse;
}

type ReviewState = 'idle' | 'reviewing' | 'completed' | 'failed';

// View mode for popup (menu shows notification cards, review shows inline feedback)
type ViewMode = 'menu' | 'review';

// Navigation request payload type
interface NavigateRequest {
  page: 'conversation' | 'conversations' | 'external';
  projectId?: number;
  conversationId?: number;
  openDiffModal?: boolean;
  url?: string;
}

// Helper function to call the navigation API
const navigateToPage = async (payload: NavigateRequest, token: string | null): Promise<boolean> => {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${serverUrl}/api/navigate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('[AcademiaNotificationsPopupV2] Navigation API failed:', response.status);
      return false;
    }

    const data = await response.json();
    return data.success === true;
  } catch (err) {
    console.error('[AcademiaNotificationsPopupV2] Navigation API error:', err);
    return false;
  }
};

// Conversation data structure for inline review
interface ConversationData {
  title: string;
  createdAt: number;
  selected_text?: string;
  messages: Array<{
    role: string;
    content: string;
    format?: string;
    data?: {
      selected_text?: string;
      [key: string]: any;
    };
  }>;
}

const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Custom hook: connects to /ws/word/v2/:wid via WebSocket for real-time updates.
 * Falls back to HTTP polling (3s) if WebSocket fails permanently.
 * Returns the full WordPollResponse (or null before first data arrives).
 */
function useWordPollWebSocket(
  wid: string | null,
  token: string | null,
  apiBaseUrl: string
): WordPollResponse | null {
  const [pollData, setPollData] = useState<WordPollResponse | null>(null);

  useEffect(() => {
    if (!wid || !token) {
      setPollData(null);
      return;
    }

    let cleanedUp = false;
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let usingFallback = false;

    function applyPollData(data: WordPollResponse) {
      if (cleanedUp) return;
      setPollData(data);
    }

    // --- HTTP polling fallback ---
    function startFallbackPolling() {
      if (fallbackInterval || cleanedUp) return;
      usingFallback = true;
      console.log('[V2] WebSocket unavailable, falling back to HTTP polling');

      const poll = async () => {
        if (cleanedUp) return;
        try {
          const headers: Record<string, string> = {
            'Accept': 'application/json',
            'X-Instance-Id': popupInstanceId,
            'Authorization': `Bearer ${token}`,
          };
          const res = await fetch(`${apiBaseUrl}/word/v2/${wid}/poll`, { headers });
          if (!res.ok) {
            setPollData(prev => prev ? { ...prev, shouldShow: false } : null);
            return;
          }
          const data: WordPollResponse = await res.json();
          applyPollData(data);
        } catch {
          // ignore
        }
      };

      poll();
      fallbackInterval = setInterval(poll, 3000);
    }

    function stopFallbackPolling() {
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
    }

    // --- WebSocket connection ---
    function connect() {
      if (cleanedUp || usingFallback) return;

      const wsUrl = `${apiBaseUrl.replace(/^http/, 'ws')}/ws/word/v2/${wid}?token=${encodeURIComponent(token!)}`;

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        console.log('[V2] WebSocket connected');
        reconnectAttempt = 0;
        stopFallbackPolling();
      };

      ws.onmessage = (event) => {
        try {
          const msg: WebSocketMessage = JSON.parse(event.data as string);
          if (msg.type === 'poll') {
            applyPollData(msg.data);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        ws = null;
        console.log('[V2] WebSocket closed', event);
        if (cleanedUp || usingFallback) return;
        if (event.code === 4401) {
          console.warn('[V2] WebSocket auth failed, falling back to HTTP polling');
          startFallbackPolling();
          return;
        }
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire after onerror, reconnection handled there
      };
    }

    function scheduleReconnect() {
      if (cleanedUp || usingFallback) return;
      reconnectAttempt += 1;
      if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
        startFallbackPolling();
        return;
      }
      const delay = Math.pow(2, reconnectAttempt - 1) * 1000;
      console.log(`[V2] Reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    // Start connection
    connect();

    // Cleanup
    return () => {
      cleanedUp = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.onclose = null; // prevent onclose from triggering reconnect
        ws.close();
        ws = null;
      }
      stopFallbackPolling();
    };
  }, [wid, token, apiBaseUrl]);

  return pollData;
}

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
  const [shouldShow, setShouldShow] = useState<boolean>(true); // Default to true, update via poll

  // State for review status
  const [reviewState, setReviewState] = useState<ReviewState>('idle');
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Track previous height to avoid unnecessary resize calls (prevents infinite loop)
  const previousHeightRef = useRef<number>(POPUP_HEIGHT_NO_NOTIFICATIONS);
  // Track logged notification IDs to avoid stale closure logging issues
  const loggedReviewIdsRef = useRef<Set<number>>(new Set());

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
  const [conversationData, setConversationData] = useState<ConversationData | null>(null);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [isSelectedTextExpanded, setIsSelectedTextExpanded] = useState(false);

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

      // Find the latest agent run by created_at timestamp
      if (data.agent_runs.length === 0) {
        setReviewState('idle');
        return;
      }

      // Sort by created_at descending to get the latest
      const sortedRuns = [...data.agent_runs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      const latest = sortedRuns[0];

      // Map API status to UI state and start polling if in progress
      switch (latest.status) {
        case 'pending':
        case 'processing':
          setReviewState('reviewing');
          // Start polling since a review is already in progress
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

  // Fetch conversation data for inline review display
  const fetchConversation = async (conversationId: number, projectId: number): Promise<ConversationData | null> => {
    setIsLoadingConversation(true);
    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }

      const params = new URLSearchParams({
        conversation_id: conversationId.toString(),
        parent_id: projectId.toString(),
        parent_type: 'Project',
      });

      const response = await fetch(
        `${serverUrl}/proxy-api/v0/co_scientist/get_conversation?${params}`,
        { headers }
      );

      if (!response.ok) {
        console.error('[AcademiaNotificationsPopupV2] Failed to fetch conversation:', response.status);
        return null;
      }

      const data = await response.json();

      return {
        title: data.conversation?.title || 'Review',
        createdAt: new Date(data.conversation?.created_at).getTime(),
        selected_text: data.conversation?.selected_text,
        messages: (data.messages || []) as ConversationData['messages'],
      };
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error fetching conversation:', err);
      return null;
    } finally {
      setIsLoadingConversation(false);
    }
  };

  // Poll for status updates after triggering a review
  const startStatusPolling = (projId: number, fId: number, token: string | null) => {
    // Clear any existing polling
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

        // Stop polling when status is terminal
        if (latest.status === 'completed' || latest.status === 'failed') {
          clearInterval(pollInterval);
          pollingIntervalRef.current = null;
          setReviewState(latest.status === 'completed' ? 'completed' : 'failed');
          console.log(`[AcademiaNotificationsPopupV2] Polling stopped - status: ${latest.status}`);

          // Trigger immediate notification sync to clear in-progress state faster
          if (latest.status === 'completed') {
            try {
              await fetch(`${serverUrl}/api/notifications/sync`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
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
    }, 3000); // Poll every 3 seconds

    pollingIntervalRef.current = pollInterval;

    // Cleanup after 5 minutes max
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

  // WebSocket-based polling (replaces V1 HTTP polling useEffect)
  const pollData = useWordPollWebSocket(widParam, tokenParam, serverUrl);

  // React to pollData changes to update component state
  useEffect(() => {
    console.log('[AcademiaNotificationsPopupV2] pollData changed:', pollData);
    if (!pollData) return;

    if (pollData.fullStoryConfig) cacheFullStoryConfig(pollData.fullStoryConfig);
    setShouldShow(pollData.shouldShow);
    onVisibilityChanged('popup', pollData.shouldShowPopupV2 ?? pollData.shouldShow);

    if (!pollData.shouldShow) {
      console.log(`[AcademiaNotificationsPopupV2] Hiding popup: shouldShow=false. Active path: ${pollData.activeDocumentPath || 'none'}`);
      postBridge('closeWindow').catch(() => {});
      return;
    }

    if (pollData.projectId && pollData.projectFileId) {
      setProjectId(pollData.projectId);
      setFileId(pollData.projectFileId);
      setIsLoading(false);

      // Handle recent review notifications
      const incoming = pollData.recentReviewNotifications || [];
      const incomingIds = new Set(incoming.map(n => n.id));

      // Log new notifications
      for (const n of incoming) {
        if (!loggedReviewIdsRef.current.has(n.id)) {
          console.log('[AcademiaNotificationsPopupV2] Found NEW review notification:', n);
        }
      }
      loggedReviewIdsRef.current = incomingIds;

      setRecentReviewNotifications(incoming);
    } else {
      // Not showing or missing ID - keep minimal state or hide
      setIsLoading(false);
    }
  }, [pollData]);

  // Check project status periodically if we have IDs
  useEffect(() => {
      if (!projectId || !fileId) return;

      const checkStatus = async () => {
          await fetchProjectStatus(projectId, fileId, tokenParam);
      };

      // Check immediately
      checkStatus();

      // Check every 10 seconds (less frequent than main poll)
      const intervalId = setInterval(checkStatus, 10000);

      return () => clearInterval(intervalId);
  }, [projectId, fileId, tokenParam]);

  // Handle window resizing based on view mode and notification count
  useEffect(() => {
    let height: number;

    if (viewMode === 'review') {
      // Taller height for inline review content
      height = POPUP_HEIGHT_REVIEW_VIEW;
    } else if (recentReviewNotifications.length >= 2) {
      height = POPUP_HEIGHT_TWO_NOTIFICATIONS;
    } else if (recentReviewNotifications.length === 1) {
      height = POPUP_HEIGHT_ONE_NOTIFICATION;
    } else {
      height = POPUP_HEIGHT_NO_NOTIFICATIONS;
    }

    // Add extra height if review status card is showing
    const isReviewActive = pollData?.isReviewingSelectedText && pollData?.reviewType;
    if (isReviewActive && viewMode === 'menu') {
      height += REVIEW_STATUS_CARD_HEIGHT;
    }

    // Only resize if height changed (prevents infinite loop)
    if (height !== previousHeightRef.current) {
      previousHeightRef.current = height;
      postBridge('resizeWindow', { height });
    }
  }, [viewMode, recentReviewNotifications, pollData]);

  // Handle clicking on a review notification card - show inline review
  const handleViewReviewFeedback = async (notification: NotificationData) => {
    console.log('[AcademiaNotificationsPopupV2] View review feedback clicked:', notification);

    // If this is an in-progress review, close the popup to show the review status overlay
    if (notification.isInProgress) {
      // First restore the review state (in case it was cleared), then close popup without clearing it
      await postBridge('setReviewState', {
        projectId: notification.project_id,
        reviewType: notification.review_type,
        selectedText: notification.selected_text,
      });
      await postBridge('closeWindow', { clearReviewState: false });
      return;
    }

    // Mark notification as read if not already
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

        // Update local state to reflect read status
        setRecentReviewNotifications(prev =>
          prev.map(n => n.id === notification.id ? { ...n, isRead: true } : n)
        );
        console.log('[AcademiaNotificationsPopupV2] Review notification marked as read');
      } catch (err) {
        console.error('[AcademiaNotificationsPopupV2] Error marking notification as read:', err);
      }
    }

    // Fetch conversation for messages
    const conversationData = await fetchConversation(
      notification.conversation_id,
      notification.project_id
    );

    if (conversationData) {
      setConversationData({
        title: notification.conversation_title || notification.title || 'Review',
        createdAt: notification.created_at,
        selected_text: notification.selected_text, // Use selected_text from notification data directly
        messages: conversationData.messages,
      });
      setActiveNotification({
        ...notification,
        selected_text: notification.selected_text, // Use from notification
      });
      setIsSelectedTextExpanded(false);
      setViewMode('review');
    } else {
      console.error('[AcademiaNotificationsPopupV2] Failed to fetch conversation data');
    }
  };

  // Handle clicking "View previous feedback" link
  const handleViewPreviousFeedback = async () => {
    if (!projectId) {
      console.error('[AcademiaNotificationsPopupV2] No project ID for previous feedback');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] View previous feedback clicked');

    try {
      // Navigate to conversations list via HTTP API
      await navigateToPage({
        page: 'conversations',
        projectId,
      }, tokenParam);

      // Close popup (fire-and-forget)
      onVisibilityChanged('popup', false);
      postBridge('closeWindow').catch(() => {});
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error in handleViewPreviousFeedback:', err);
    }
  };

  // Handle clicking "Back" from review view - return to menu (notification stays visible)
  const handleBackFromReview = () => {
    console.log('[AcademiaNotificationsPopupV2] Back from review clicked');

    // Clear resize state so menu snaps back to content-driven size
    accumulatedSizeRef.current = null;
    postBridge('clearPopupSize', {});

    // Return to menu view (notification remains visible with isRead state from poll)
    setViewMode('menu');
    setConversationData(null);
    setActiveNotification(null);
    setIsSelectedTextExpanded(false);
  };

  // Handle clicking "Ask follow up" button - navigate to main window
  const handleAskFollowUp = async () => {
    console.log('[AcademiaNotificationsPopupV2] Ask follow up clicked');

    if (!activeNotification) {
      console.error('[AcademiaNotificationsPopupV2] No notification for follow up');
      return;
    }

    try {
      // Mark the notification as read (not dismissed, so it stays visible)
      if (!activeNotification.isRead) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (tokenParam) {
          headers['Authorization'] = `Bearer ${tokenParam}`;
        }

        await fetch(
          `${serverUrl}/api/notifications/${activeNotification.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ status: 'read' }),
          }
        );

        // Update local state to reflect read status
        setRecentReviewNotifications(prev =>
          prev.map(n => n.id === activeNotification.id ? { ...n, isRead: true } : n)
        );
      }

      // Close popup and navigate to main window via HTTP API
      onVisibilityChanged('popup', false);
      await postBridge('closeWindow');
      await navigateToPage({
        page: 'conversation',
        projectId: activeNotification.project_id,
        conversationId: activeNotification.conversation_id,
      }, tokenParam);
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error in handleAskFollowUp:', err);
    }
  };

  // Handle clicking "#show-diff" links in review content - navigate to main window with diff modal
  const handleViewEdits = async () => {
    console.log('[AcademiaNotificationsPopupV2] View edits clicked');

    if (!activeNotification) {
      console.error('[AcademiaNotificationsPopupV2] No notification for view edits');
      return;
    }

    const notification = activeNotification;

    try {
      console.log('[AcademiaNotificationsPopupV2] Navigating to conversation with diff modal:', true);
      console.log('[AcademiaNotificationsPopupV2] Project ID:', notification.project_id);
      console.log('[AcademiaNotificationsPopupV2] Conversation ID:', notification.conversation_id);
      // Navigate to main window with diff modal flag via HTTP API (keep popup open)
      await navigateToPage({
        page: 'conversation',
        projectId: notification.project_id,
        conversationId: notification.conversation_id,
        openDiffModal: true,
      }, tokenParam);
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error in handleViewEdits:', err);
    }
  };

  // Handle clicks on review content to intercept #show-diff links
  const handleReviewContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // Check if clicked element is an anchor with href="#show-diff"
    if (target.tagName === 'A') {
      const href = target.getAttribute('href');
      if (href === '#show-diff') {
        e.preventDefault();
        handleViewEdits();
      }
    }
  };

  const handleGenerateShortReview = async () => {
    if (!projectId || !fileId || !widParam) {
      console.error('[AcademiaNotificationsPopupV2] Missing project, file ID, or window ID');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] Triggering diff review...');

    // Track analytics - diff review triggered from overlay
    trackTriggerDiffReview('overlay', projectId, fileId);

    // Optimistically set reviewing state
    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }

      // Use local API endpoint which handles both backend trigger and overlay state
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

      // Start polling for status updates
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

    // Track analytics - full review triggered from overlay
    trackTriggerFullReview('overlay', projectId, fileId);

    // Optimistically set reviewing state
    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tokenParam) {
        headers['Authorization'] = `Bearer ${tokenParam}`;
      }

      // Use local API endpoint which handles both backend trigger and overlay state
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

      // Start polling for status updates
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
      // Right = wider (positive deltaX)
      const deltaX = e.screenX - rs.startScreenX;
      // Up = taller (screen Y decreases going up, so negate)
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

  // Compute UI state
  const isReviewing = reviewState === 'reviewing';
  const showFailedMessage = reviewState === 'failed';
  const buttonsDisabled = isLoading || !projectId || !fileId || isReviewing;

  // Render the review view (inline feedback content)
  const renderReviewView = () => {
    return (
      <>
        {/* Header with Back and Close */}
        <div style={styles.reviewHeader}>
          <button
            style={styles.backButton}
            onClick={handleBackFromReview}
            aria-label="Back"
          >
            <ArrowBackIcon />
            <span style={styles.backButtonText}>Back</span>
          </button>
          <button
            style={styles.closeButton}
            onClick={handleClose}
            aria-label="Close"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Scrollable Content */}
        <div style={styles.reviewScrollArea}>
          {/* Title and Date */}
          <h2 style={styles.reviewTitle}>
            {activeNotification?.conversation_title || activeNotification?.title || 'Review'}
          </h2>
          {activeNotification && (
            <p style={styles.reviewDate}>
              This feedback is from {formatNotificationDate(activeNotification.created_at)}
            </p>
          )}

          {/* Selected Text Display (for selected-text reviews) */}
          {activeNotification?.selected_text && (
            <div style={styles.selectedTextContainer}>
              <div style={styles.selectedTextBox}>
                {isSelectedTextExpanded || activeNotification.selected_text.length <= 150
                  ? activeNotification.selected_text
                  : `${activeNotification.selected_text.substring(0, 150)}...`
                }{' '}
                {activeNotification.selected_text.length > 150 && (
                  <button
                    style={styles.selectedTextToggle}
                    onClick={() => setIsSelectedTextExpanded(!isSelectedTextExpanded)}
                  >
                    {isSelectedTextExpanded ? 'See less' : 'See more'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Loading State */}
          {isLoadingConversation && (
            <p style={styles.loadingText}>Loading feedback...</p>
          )}

          {/* Message Content - show user and assistant messages */}
          {conversationData?.messages
            .filter(m => m.role !== 'tool')
            .map((message, idx) => {
              const isUser = message.role === 'user';

              return (
                <div
                  key={idx}
                  style={isUser ? styles.userMessage : styles.assistantMessage}
                >
                  <div
                    className={isUser ? undefined : "review-content"}
                    style={isUser ? styles.userMessageContent : styles.reviewContent}
                    onClick={isUser ? undefined : handleReviewContentClick}
                    dangerouslySetInnerHTML={{ __html: message.content }}
                  />
                </div>
              );
            })}
        </div>

        {/* Footer with Ask Follow Up button */}
        <div style={styles.reviewFooter}>
          <button
            style={styles.askFollowUpButton}
            onClick={handleAskFollowUp}
            aria-label="Ask follow up"
          >
            <span>Ask follow up</span>
            <ArrowForwardIcon />
          </button>
          <button
            style={styles.provideFeedbackLink}
            onClick={() => {
              const feedbackUrl = activeNotification
                ? `${FEEDBACK_FORM_URL}?usp=pp_url&entry.744362453=${encodeURIComponent(String(activeNotification.conversation_id))}`
                : FEEDBACK_FORM_URL;
              navigateToPage({ page: 'external', url: feedbackUrl }, tokenParam);
            }}
          >
            Provide feedback on this review
          </button>
        </div>
      </>
    );
  };

  // Render the menu view (notification cards and action buttons)
  const renderMenuView = () => (
    <>
      {/* Close Button */}
      <button
        style={styles.closeButton}
        onClick={handleClose}
        aria-label="Close"
        title="Close"
      >
        <CloseIcon />
      </button>

      {/* Section 1: Feedback (always visible) */}
      <div>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionHeaderText}>Feedback</span>
        </div>
        <div style={styles.feedbackContent}>
          {/* In-progress reviews are shown in the review status overlay, not here */}
          {/* Notification cards (up to 2 most recent) */}
          {recentReviewNotifications.map((notification) => {
            const isSelectionReview = notification.review_type === 'selected-text';

            return (
              <button
                key={notification.id}
                style={styles.notificationCard}
                onClick={() => handleViewReviewFeedback(notification)}
                aria-label="View review feedback"
              >
                {!notification.isRead && <div style={styles.blueDot} />}
                <div style={styles.notificationContent as React.CSSProperties}>
                  <span style={styles.notificationDate}>
                    {formatNotificationDate(notification.created_at)}
                  </span>
                  <span style={styles.notificationTitle}>
                    {notification.isInProgress && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                        <LoadingSpinner />
                        <span>Selection review</span>
                      </span>
                    )}
                    {!notification.isInProgress && isSelectionReview && 'Selection review'}
                    {!notification.isInProgress && !isSelectionReview && (
                      <span
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(notification.body_html || notification.conversation_title || notification.title || 'Feedback on your manuscript')
                        }}
                      />
                    )}
                  </span>
                </div>
                <div style={styles.arrowIcon}>
                  <ArrowForwardIcon />
                </div>
              </button>
            );
          })}
          {/* View previous feedback row (always visible) */}
          <button
            style={styles.viewPreviousRow}
            onClick={handleViewPreviousFeedback}
            aria-label="View previous feedback"
          >
            <span style={styles.viewPreviousText}>View previous feedback</span>
            <div style={styles.arrowIcon}>
              <ArrowForwardIcon />
            </div>
          </button>
        </div>
      </div>

      {/* Section 2: Get Feedback Actions */}
      <div>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionHeaderText}>Get feedback</span>
        </div>
        <div style={styles.feedbackButtonsRow}>
          <button
            style={{
              ...styles.feedbackButton,
              ...(buttonsDisabled ? styles.feedbackButtonDisabled : {}),
            }}
            onClick={handleGenerateShortReview}
            disabled={buttonsDisabled}
            aria-label="Generate review on recent changes"
          >
            <span style={styles.feedbackButtonText}>
              {isReviewing ? 'Reviewing...' : 'On recent changes'}
            </span>
            <div style={styles.arrowIcon}>
              <ArrowForwardIcon />
            </div>
          </button>
          <button
            style={{
              ...styles.feedbackButton,
              ...(buttonsDisabled ? styles.feedbackButtonDisabled : {}),
            }}
            onClick={handleGenerateFullReview}
            disabled={buttonsDisabled}
            aria-label="Generate review on full manuscript"
          >
            <span style={styles.feedbackButtonText}>
              {isReviewing ? 'Reviewing...' : 'On the full manuscript'}
            </span>
            <div style={styles.arrowIcon}>
              <ArrowForwardIcon />
            </div>
          </button>
        </div>
      </div>

      {/* Error Message (if any) */}
      {showFailedMessage && (
        <div style={styles.errorMessage}>
          Review failed. Please try again.
        </div>
      )}
    </>
  );

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
        {viewMode === 'review' ? renderReviewView() : renderMenuView()}
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  modal: {
    width: '100%',
    background: '#ffffff', // Figma: background-white
    borderRadius: '16px', // Figma: corner-radius/radius-lg
    border: '1px solid #ccc9bc', // Figma: stroke-beige-light
    position: 'relative',
    padding: '24px', // Figma: spacing/sm-24
    fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    maxHeight: '100%',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '16px',
    height: '16px',
    cursor: 'ne-resize',
    zIndex: 10,
    // Subtle diagonal grip lines
    backgroundImage:
      'linear-gradient(225deg, transparent 3px, #ccc9bc 3px, #ccc9bc 4px, transparent 4px, transparent 7px, #ccc9bc 7px, #ccc9bc 8px, transparent 8px)',
    backgroundSize: '16px 16px',
    backgroundPosition: 'top right',
    borderTopRightRadius: '16px',
  },
  closeButton: {
    position: 'absolute',
    top: '12px',
    right: '12px',
    width: '20px',
    height: '20px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  // Section header with icon and text
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingBottom: '12px', // Figma: spacing/xs-12
  },
  sectionHeaderText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px', // Figma: type/body/md/size
    fontWeight: 600, // Figma: type/weights/semibold-600
    lineHeight: '20px', // Figma: type/body/md/line-height
    color: '#141413', // Figma: text-primary
  },
  // Feedback content container (notification cards + view previous row)
  feedbackContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px', // Figma: spacing/xs-12
  },
  // Review status card (shows when review is in progress)
  reviewStatusCard: {
    backgroundColor: '#FFFFFF',
    border: '1px solid #E0E0E0',
    borderRadius: '12px',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  reviewStatusHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  reviewStatusSpinner: {
    width: '20px',
    height: '20px',
    animation: 'spin 1s linear infinite',
    flexShrink: 0,
  },
  reviewStatusTitle: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 600,
    lineHeight: '20px',
    color: '#141413',
  },
  reviewStatusContent: {
    backgroundColor: '#EEF2F9',
    borderRadius: '8px',
    padding: '12px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    lineHeight: '20px',
    color: '#141413',
  },
  reviewProgressBar: {
    width: '100%',
    height: '8px',
    backgroundColor: '#E0E0E0',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  reviewProgressFill: {
    height: '100%',
    backgroundColor: '#6B7E6F',
    borderRadius: '4px',
  },
  reviewProgressFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  reviewProgressText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 600,
    lineHeight: '18px',
    color: '#141413',
  },
  // Individual notification card (light blue background) - clickable button
  notificationCard: {
    backgroundColor: '#F5F3EE', // Light beige/cream background
    borderRadius: '8px', // Figma: corner-radius/radius-md
    padding: '12px', // Figma: spacing/xs-12
    paddingRight: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px', // Figma: spacing/xs-8
    position: 'relative',
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
  },
  // Blue dot indicator for unread notifications
  blueDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: '#0645b1', // Figma: blue indicator
    position: 'absolute',
    left: '-5px',
    top: '50%',
    transform: 'translateY(-50%)',
    flexShrink: 0,
  },
  notificationContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  selectedTextPreview: {
    backgroundColor: '#eef2f9',
    borderRadius: '4px',
    padding: '8px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    lineHeight: '18px',
    color: '#141413',
    marginBottom: '8px',
  },
  notificationTitle: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px', // Figma: type/body/md/size
    fontWeight: 400, // Figma: type/body/md/font-weight
    lineHeight: '20px', // Figma: type/body/md/line-height
    color: '#141413', // Figma: text-primary
  },
  notificationDate: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px', // Figma: type/body/sm/size
    fontWeight: 400, // Figma: type/body/sm/font-weight
    lineHeight: '20px', // Figma: type/body/sm/line-height
    color: '#6d6d7d', // Figma: brand-colors/neutral-800
  },
  // View previous feedback row (beige background)
  viewPreviousRow: {
    backgroundColor: '#f9f8f6', // Figma: background-beige-light
    borderRadius: '8px', // Figma: corner-radius/radius-md
    padding: '12px', // Figma: spacing/xs-12
    paddingRight: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px', // Figma: spacing/xs-12
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
  },
  viewPreviousText: {
    flex: 1,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px', // Figma: type/body/md/size
    fontWeight: 400, // Figma: type/body/md/font-weight
    lineHeight: '20px', // Figma: type/body/md/line-height
    color: '#141413', // Figma: text-primary
  },
  // Arrow icon container
  arrowIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  // Horizontal row for Get Feedback buttons
  feedbackButtonsRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: '12px', // Figma: spacing/xs-12
  },
  // Individual feedback button (bordered card)
  feedbackButton: {
    flex: 1,
    backgroundColor: '#ffffff',
    border: '1px solid #141413', // Figma: stroke-black
    borderRadius: '8px', // Figma: corner-radius/radius-md
    padding: '10px 8px 10px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px', // Figma: spacing/xs-12
    cursor: 'pointer',
    textAlign: 'left',
  },
  feedbackButtonText: {
    flex: 1,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px', // Figma: type/body/md/size
    fontWeight: 400, // Figma: type/body/md/font-weight
    lineHeight: '20px', // Figma: type/body/md/line-height
    color: '#141413', // Figma: text-primary
  },
  feedbackButtonDisabled: {
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  // Legacy action card styles (can be removed after migration)
  actionCard: {
    backgroundColor: '#f9f8f6', // Figma: background-beige-light
    borderRadius: '8px', // Figma: corner-radius/radius-md
    overflow: 'hidden',
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px', // Figma: spacing/xs-16
    padding: '16px', // Figma: spacing/xs-16
  },
  actionRowWithBorder: {
    borderBottom: '1px solid #dddde2', // Figma: stroke-grey-light
  },
  actionRowText: {
    flex: 1,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px', // Figma: type/body/md/size
    fontWeight: 400, // Figma: type/body/md/font-weight
    lineHeight: '20px', // Figma: type/body/md/line-height
    color: '#141413', // Figma: text-primary
  },
  // Arrow button (small button with arrow icon)
  arrowButton: {
    backgroundColor: '#ffffff', // Figma: button-xs-fill
    border: '1px solid #141413', // Figma: button-xs-stroke
    borderRadius: '8px', // Figma: corner-radius/radius-md
    width: '32px', // Figma: button xs height
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
  },
  arrowButtonDisabled: {
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  // View previous feedback link
  viewPreviousLink: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px', // Figma: type/body/sm/size
    fontWeight: 400, // Figma: type/body/sm/font-weight
    lineHeight: '20px', // Figma: type/body/sm/line-height
    color: '#141413', // Figma: text-primary
    textDecoration: 'underline',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    textAlign: 'left',
  },
  // Error message
  errorMessage: {
    backgroundColor: '#FEE2E2',
    borderRadius: '8px',
    padding: '12px 16px',
    color: '#DC2626',
    fontSize: '14px',
    fontFamily: "'DM Sans', sans-serif",
  },
  // Legacy styles kept for backward compatibility during transition
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px', // Figma: spacing/sm-24
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px', // Figma: spacing/xs-16
  },
  sectionWithBorder: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px', // Figma: spacing/xs-16
    paddingBottom: '24px', // Figma: spacing/sm-24
    borderBottom: '1px solid #CCC9BC', // Figma: stroke-beige-light
  },
  sectionText: {
    fontSize: '16px', // Figma: type/body/md/size
    fontWeight: 600, // Figma: type/weights/semibold-600
    color: '#141413', // Figma: text-primary
    lineHeight: '20px', // Figma: type/body/md/line-height
    margin: 0,
  },
  actionButton: {
    width: '100%',
    height: '32px', // Figma: button xs height
    backgroundColor: '#ffffff', // Figma: buttons/button-style/extra-small/button-xs-fill
    border: '1px solid #141413', // Figma: buttons/button-style/extra-small/button-xs-stroke
    borderRadius: '8px', // Figma: buttons/extra-small-buttons/corner-radius
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px', // Figma: buttons/extra-small-buttons/gap
    padding: '4px 8px', // Figma: button/xs padding
    transition: 'background-color 0.15s ease',
    fontFamily: 'inherit',
  },
  buttonText: {
    fontSize: '14px', // Figma: type/body/sm/size
    fontWeight: 400, // Figma: type/body/sm/font-weight
    color: '#141413', // Figma: buttons/button-style/extra-small/button-xs-text
    lineHeight: '20px', // Figma: type/body/sm/line-height
    textAlign: 'center',
  },
  errorText: {
    fontSize: '14px',
    fontWeight: 500,
    color: '#DC2626',
    lineHeight: '18px',
    margin: 0,
    textAlign: 'center' as const,
  },
  actionButtonDisabled: {
    backgroundColor: '#E5E5E5',
    borderColor: '#CCCCCC',
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  buttonTextDisabled: {
    color: '#999999',
  },
  // Review view styles
  reviewHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: '16px',
  },
  backButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
  },
  backButtonText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 600,
    color: '#141413',
  },
  reviewScrollArea: {
    flex: 1,
    overflowY: 'auto',
    paddingRight: '8px',
  },
  reviewTitle: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '20px',
    fontWeight: 700,
    lineHeight: '24px',
    color: '#141413',
    margin: '0 0 4px 0',
  },
  reviewDate: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#535366',
  },
  reviewContent: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    // lineHeight: '20px',
    color: '#141413',
  },
  loadingText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    color: '#535366',
    textAlign: 'center',
    padding: '24px 0',
  },
  // User message styles (right-aligned, blue background)
  userMessage: {
    marginLeft: 'auto',
    marginRight: 0,
    maxWidth: '300px',
    marginBottom: '12px',
  },
  userMessageContent: {
    padding: '12px 16px',
    backgroundColor: '#e6ecf7', // --background-blue from design tokens
    borderRadius: '8px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  // Assistant message wrapper
  assistantMessage: {
    marginBottom: '12px',
  },
  reviewFooter: {
    borderTop: '1px solid #dddde2',
    paddingTop: '24px',
    marginTop: '24px',
  },
  askFollowUpButton: {
    width: '100%',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    backgroundColor: '#ffffff',
    border: '1px solid #141413',
    borderRadius: '8px',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 400,
    color: '#141413',
  },
  provideFeedbackLink: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#0645b1',
    textDecoration: 'underline',
    textAlign: 'center',
    width: '100%',
    display: 'block',
    marginTop: '10px',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
  },
  // Selected text display (for selection reviews)
  selectedTextContainer: {
    marginTop: '16px',
    marginBottom: '16px',
  },
  selectedTextBox: {
    backgroundColor: '#EEF2F9', // Light blue background
    borderRadius: '8px',
    padding: '12px 16px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  selectedTextToggle: {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#0645b1',
    textDecoration: 'underline',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    padding: 0,
    marginLeft: '4px',
  },
};

// Add hover styles
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
    .action-button:hover:not(:disabled) {
      background-color: #f5f5f5 !important;
    }
    .action-button:disabled {
      cursor: not-allowed !important;
    }
    button[aria-label="Close"]:hover {
      background-color: rgba(0, 0, 0, 0.05) !important;
    }
    .review-content p, .review-content h1, .review-content h2, .review-content h3, .review-content h4, .review-content h5, .review-content h6, .review-content ul, .review-content ol, .review-content li {
      margin: 0 0 12px 0;
    }
  `;

  // Only append if not already added
  if (!document.getElementById('academia-notifications-popup-v2-styles')) {
    styleElement.id = 'academia-notifications-popup-v2-styles';
    document.head.appendChild(styleElement);
  }
}

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<AcademiaNotificationsPopupV2 />);
  console.log('[AcademiaNotificationsPopupV2] React app initialized');
} else {
  console.error('[AcademiaNotificationsPopupV2] Root container not found!');
}
