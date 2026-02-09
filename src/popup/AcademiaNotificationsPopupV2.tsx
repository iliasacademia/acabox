import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import DOMPurify from 'isomorphic-dompurify';
import { trackTriggerDiffReview, trackTriggerFullReview } from './utils/analytics';
import { FEEDBACK_FORM_URL } from '../shared/constants';

console.log('[AcademiaNotificationsPopupV2] Initializing...');

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
} | null;

// Define response type locally to avoid importing server types in client code
interface WordPollResponse {
  shouldShow: boolean;
  projectId?: number;
  projectFileId?: number;
  notificationCount?: number;
  isActive: boolean;
  fullReviewNotification?: {
    id: number;
    project_id: number;
    conversation_id: number;
    created_at: number;
    title: string; // Notification title (e.g., "New thoughts on your research!")
    conversation_title?: string; // Conversation title (e.g., "Daily Feedback | Tue, 13 Jan 2026")
    body_html?: string; // HTML content for notification display
    isRead: boolean;
  } | null;
  diffReviewNotification?: {
    id: number;
    project_id: number;
    conversation_id: number;
    created_at: number;
    title: string; // Notification title (e.g., "New thoughts on your research!")
    conversation_title?: string; // Conversation title (e.g., "Daily Feedback | Tue, 13 Jan 2026")
    body_html?: string; // HTML content for notification display
    isRead: boolean;
  } | null;
  activeDocumentPath?: string | null;
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
  messages: Array<{ role: string; content: string; format?: string }>;
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
  // State for review notifications (separate for full and diff reviews)
  const [fullReviewNotification, setFullReviewNotification] = useState<NotificationData>(null);
  const [diffReviewNotification, setDiffReviewNotification] = useState<NotificationData>(null);

  // Computed value for backward compatibility
  const hasUnreadReview = fullReviewNotification !== null || diffReviewNotification !== null;

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
  const loggedFullReviewIdRef = useRef<number | null>(null);
  const loggedDiffReviewIdRef = useRef<number | null>(null);

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
  const [activeReviewType, setActiveReviewType] = useState<'full' | 'diff' | null>(null);
  const [conversationData, setConversationData] = useState<ConversationData | null>(null);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);

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
        messages: data.messages || [],
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
    if (!pollData) return;

    setShouldShow(pollData.shouldShow);

    if (!pollData.shouldShow) {
      console.log(`[AcademiaNotificationsPopupV2] Hiding popup: shouldShow=false. Active path: ${pollData.activeDocumentPath || 'none'}`);
      postBridge('closeWindow').catch(() => {});
      return;
    }

    if (pollData.projectId && pollData.projectFileId) {
      setProjectId(pollData.projectId);
      setFileId(pollData.projectFileId);
      setIsLoading(false);

      // Handle full review notification (use refs to avoid stale closure issues)
      if (pollData.fullReviewNotification) {
        if (loggedFullReviewIdRef.current !== pollData.fullReviewNotification.id) {
          console.log('[AcademiaNotificationsPopupV2] Found NEW full review notification:', pollData.fullReviewNotification);
          loggedFullReviewIdRef.current = pollData.fullReviewNotification.id;
        }
        setFullReviewNotification(pollData.fullReviewNotification);
      } else {
        if (loggedFullReviewIdRef.current !== null) {
          console.log('[AcademiaNotificationsPopupV2] Full review notification cleared');
          loggedFullReviewIdRef.current = null;
        }
        setFullReviewNotification(null);
      }

      // Handle diff review notification (use refs to avoid stale closure issues)
      if (pollData.diffReviewNotification) {
        if (loggedDiffReviewIdRef.current !== pollData.diffReviewNotification.id) {
          console.log('[AcademiaNotificationsPopupV2] Found NEW diff review notification:', pollData.diffReviewNotification);
          loggedDiffReviewIdRef.current = pollData.diffReviewNotification.id;
        }
        setDiffReviewNotification(pollData.diffReviewNotification);
      } else {
        if (loggedDiffReviewIdRef.current !== null) {
          console.log('[AcademiaNotificationsPopupV2] Diff review notification cleared');
          loggedDiffReviewIdRef.current = null;
        }
        setDiffReviewNotification(null);
      }
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
    } else if (fullReviewNotification && diffReviewNotification) {
      height = POPUP_HEIGHT_TWO_NOTIFICATIONS;
    } else if (fullReviewNotification || diffReviewNotification) {
      height = POPUP_HEIGHT_ONE_NOTIFICATION;
    } else {
      height = POPUP_HEIGHT_NO_NOTIFICATIONS;
    }

    // Only resize if height changed (prevents infinite loop)
    if (height !== previousHeightRef.current) {
      previousHeightRef.current = height;
      postBridge('resizeWindow', { height });
    }
  }, [viewMode, fullReviewNotification, diffReviewNotification]);

  // Handle clicking on full review notification card - show inline review
  const handleViewFullReviewFeedback = async () => {
    if (!fullReviewNotification) {
      console.error('[AcademiaNotificationsPopupV2] No full review notification to view');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] View full review feedback clicked:', fullReviewNotification);

    // Fetch conversation data for inline display
    const data = await fetchConversation(
      fullReviewNotification.conversation_id,
      fullReviewNotification.project_id
    );

    if (data) {
      // Mark notification as read if not already
      if (!fullReviewNotification.isRead) {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (tokenParam) {
            headers['Authorization'] = `Bearer ${tokenParam}`;
          }

          await fetch(`${serverUrl}/api/notifications/${fullReviewNotification.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ status: 'read' }),
          });

          // Update local state to reflect read status
          setFullReviewNotification(prev => prev ? { ...prev, isRead: true } : null);
          console.log('[AcademiaNotificationsPopupV2] Full review notification marked as read');
        } catch (err) {
          console.error('[AcademiaNotificationsPopupV2] Error marking notification as read:', err);
        }
      }

      setConversationData({
        title: fullReviewNotification.conversation_title || fullReviewNotification.title || 'Full review',
        createdAt: fullReviewNotification.created_at,
        messages: data.messages,
      });
      setActiveReviewType('full');
      setViewMode('review');
    } else {
      console.error('[AcademiaNotificationsPopupV2] Failed to fetch conversation data');
    }
  };

  // Handle clicking on diff review notification card - show inline review
  const handleViewDiffReviewFeedback = async () => {
    if (!diffReviewNotification) {
      console.error('[AcademiaNotificationsPopupV2] No diff review notification to view');
      return;
    }

    console.log('[AcademiaNotificationsPopupV2] View diff review feedback clicked:', diffReviewNotification);

    // Fetch conversation data for inline display
    const data = await fetchConversation(
      diffReviewNotification.conversation_id,
      diffReviewNotification.project_id
    );

    if (data) {
      // Mark notification as read if not already
      if (!diffReviewNotification.isRead) {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (tokenParam) {
            headers['Authorization'] = `Bearer ${tokenParam}`;
          }

          await fetch(`${serverUrl}/api/notifications/${diffReviewNotification.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ status: 'read' }),
          });

          // Update local state to reflect read status
          setDiffReviewNotification(prev => prev ? { ...prev, isRead: true } : null);
          console.log('[AcademiaNotificationsPopupV2] Diff review notification marked as read');
        } catch (err) {
          console.error('[AcademiaNotificationsPopupV2] Error marking notification as read:', err);
        }
      }

      setConversationData({
        title: diffReviewNotification.conversation_title || diffReviewNotification.title || 'Diff review',
        createdAt: diffReviewNotification.created_at,
        messages: data.messages,
      });
      setActiveReviewType('diff');
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
    setActiveReviewType(null);
  };

  // Handle clicking "Ask follow up" button - navigate to main window
  const handleAskFollowUp = async () => {
    console.log('[AcademiaNotificationsPopupV2] Ask follow up clicked');

    // Get the current notification being viewed
    const notification = activeReviewType === 'full'
      ? fullReviewNotification
      : diffReviewNotification;

    if (!notification) {
      console.error('[AcademiaNotificationsPopupV2] No notification for follow up');
      return;
    }

    try {
      // Mark the notification as read (not dismissed, so it stays visible)
      if (!notification.isRead) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (tokenParam) {
          headers['Authorization'] = `Bearer ${tokenParam}`;
        }

        await fetch(
          `${serverUrl}/api/notifications/${notification.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ status: 'read' }),
          }
        );

        // Update local state to reflect read status
        if (activeReviewType === 'full') {
          setFullReviewNotification(prev => prev ? { ...prev, isRead: true } : null);
        } else {
          setDiffReviewNotification(prev => prev ? { ...prev, isRead: true } : null);
        }
      }

      // Close popup and navigate to main window via HTTP API
      await postBridge('closeWindow');
      await navigateToPage({
        page: 'conversation',
        projectId: notification.project_id,
        conversationId: notification.conversation_id,
      }, tokenParam);
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error in handleAskFollowUp:', err);
    }
  };

  // Handle clicking "#show-diff" links in review content - navigate to main window with diff modal
  const handleViewEdits = async () => {
    console.log('[AcademiaNotificationsPopupV2] View edits clicked');

    const notification = activeReviewType === 'full'
      ? fullReviewNotification
      : diffReviewNotification;

    if (!notification) {
      console.error('[AcademiaNotificationsPopupV2] No notification for view edits');
      return;
    }

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
    if (!projectId || !fileId) {
      console.error('[AcademiaNotificationsPopupV2] Missing project or file ID');
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

      const response = await fetch(
        `${serverUrl}/proxy-api/v0/co_scientist/projects/${projectId}/files/${fileId}/trigger_diff_review`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
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
    if (!projectId || !fileId) {
      console.error('[AcademiaNotificationsPopupV2] Missing project or file ID');
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

      const response = await fetch(
        `${serverUrl}/proxy-api/v0/co_scientist/projects/${projectId}/files/${fileId}/trigger_full_review`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
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
    const notification = activeReviewType === 'full'
      ? fullReviewNotification
      : diffReviewNotification;

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
            {activeReviewType === 'full' ? 'Full review' : 'Diff review'}
          </h2>
          {notification && (
            <p style={styles.reviewDate}>
              This feedback is from {formatNotificationDate(notification.created_at)}
            </p>
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
              const notification = activeReviewType === 'full' ? fullReviewNotification : diffReviewNotification;
              const feedbackUrl = notification
                ? `${FEEDBACK_FORM_URL}?usp=pp_url&entry.744362453=${encodeURIComponent(String(notification.conversation_id))}`
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
          {/* Notification cards (if any) */}
          {fullReviewNotification && (
            <button
              style={styles.notificationCard}
              onClick={handleViewFullReviewFeedback}
              aria-label="View full review feedback"
            >
              {!fullReviewNotification.isRead && <div style={styles.blueDot} />}
              <div style={styles.notificationContent as React.CSSProperties}>
                <span
                  style={styles.notificationTitle}
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(fullReviewNotification.body_html || fullReviewNotification.conversation_title || fullReviewNotification.title || 'Feedback on your entire manuscript')
                  }}
                />
                <span style={styles.notificationDate}>
                  {formatNotificationDate(fullReviewNotification.created_at)}
                </span>
              </div>
              <div style={styles.arrowIcon}>
                <ArrowForwardIcon />
              </div>
            </button>
          )}
          {diffReviewNotification && (
            <button
              style={styles.notificationCard}
              onClick={handleViewDiffReviewFeedback}
              aria-label="View diff review feedback"
            >
              {!diffReviewNotification.isRead && <div style={styles.blueDot} />}
              <div style={styles.notificationContent as React.CSSProperties}>
                <span
                  style={styles.notificationTitle}
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(diffReviewNotification.body_html || diffReviewNotification.conversation_title || diffReviewNotification.title || 'Feedback on recent changes')
                  }}
                />
                <span style={styles.notificationDate}>
                  {formatNotificationDate(diffReviewNotification.created_at)}
                </span>
              </div>
              <div style={styles.arrowIcon}>
                <ArrowForwardIcon />
              </div>
            </button>
          )}
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
  // Individual notification card (light blue background) - clickable button
  notificationCard: {
    backgroundColor: '#eef2f9', // Figma: background-light-blue
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
};

// Add hover styles
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
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
