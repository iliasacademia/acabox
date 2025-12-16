import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { getBridgeInstance, useSendMessage } from './hooks/useBridge';
import { trackTriggerDiffReview, trackTriggerFullReview } from './utils/analytics';

// Initialize bridge early
getBridgeInstance('notifications-popup');

console.log('[AcademiaNotificationsPopup] Initializing...');
console.log('[AcademiaNotificationsPopup] Platform:', window.__messageBridge?.getPlatform());

// Get serverUrl from window.location.origin (popup is served from the HTTP server)
// This ensures we use the correct port even when server binds to fallback port
const serverUrl = window.location.origin;

// Generate unique instance ID for logging (uses PID from URL or random ID)
const popupUrlParams = new URLSearchParams(window.location.search);
const pidParam = popupUrlParams.get('pid');
const popupInstanceId = `AcademiaNotificationsPopup-${pidParam || Math.random().toString(36).substring(2, 8)}`;

// Height constants matching native window sizes
const POPUP_HEIGHT_DEFAULT = 280;      // 2 sections (short + full review)
const POPUP_HEIGHT_WITH_NOTIF = 400;   // 3 sections (new review + short + full)

// Arrow Forward Icon component
const ArrowForwardIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12 4L10.59 5.41L16.17 11H4V13H16.17L10.59 18.59L12 20L20 12L12 4Z"
      fill="#141413"
    />
  </svg>
);

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

// Define response type locally to avoid importing server types in client code
interface WordPollResponse {
  shouldShow: boolean;
  projectId?: number;
  projectFileId?: number;
  notificationCount?: number;
  isActive: boolean;
  latestReviewNotification?: {
    id: number;
    project_id: number;
    conversation_id: number;
  } | null;
  activeDocumentPath?: string | null;
}

type ReviewState = 'idle' | 'reviewing' | 'completed' | 'failed';

const AcademiaNotificationsPopup: React.FC = () => {
  // State for unread review notification
  const [hasUnreadReview, setHasUnreadReview] = useState<boolean>(false);
  const [currentNotification, setCurrentNotification] = useState<{
    id: number;
    project_id: number;
    conversation_id: number;
  } | null>(null);
  const { sendRequest } = useSendMessage();

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

  // Auth token from URL
  const [authToken, setAuthToken] = useState<string | null>(null);

  // Extract Token from URL
  const tokenParam = popupUrlParams.get('token');

  useEffect(() => {
    if (tokenParam) setAuthToken(tokenParam);
  }, [tokenParam]);

  // Fetch project status to determine review state
  const fetchProjectStatus = async (projId: number, fId: number, token: string | null): Promise<void> => {
    try {
      // console.log(`[AcademiaNotificationsPopup] Fetching project status for project ${projId}, file ${fId}`);

      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(
        `${serverUrl}/proxy-api/v0/co_scientist/projects/${projId}/status?file_id=${fId}`,
        { headers }
      );

      if (!response.ok) {
        console.error('[AcademiaNotificationsPopup] Failed to fetch project status:', response.status);
        return;
      }

      const data: ProjectStatusResponse = await response.json();
      // console.log('[AcademiaNotificationsPopup] Project status:', data);

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
          // Note: Only start if not already polling to avoid loop, handled by startStatusPolling
          if (reviewState !== 'reviewing') {
              console.log('[AcademiaNotificationsPopup] Review in progress on load, starting polling');
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

      // console.log(`[AcademiaNotificationsPopup] Review state set to: ${latest.status}`);
    } catch (err) {
      console.error('[AcademiaNotificationsPopup] Error fetching project status:', err);
      // Don't update state on error - keep previous state
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
          console.log(`[AcademiaNotificationsPopup] Polling stopped - status: ${latest.status}`);
        }
      } catch (err) {
        console.error('[AcademiaNotificationsPopup] Polling error:', err);
      }
    }, 3000); // Poll every 3 seconds

    pollingIntervalRef.current = pollInterval;

    // Cleanup after 5 minutes max
    setTimeout(() => {
      if (pollingIntervalRef.current === pollInterval) {
        clearInterval(pollInterval);
        pollingIntervalRef.current = null;
        console.log('[AcademiaNotificationsPopup] Polling stopped - max duration reached');
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

  // Poll endpoint for PID info and notifications
  useEffect(() => {
    if (!pidParam) {
      console.error('[AcademiaNotificationsPopup] No PID provided in URL');
      setError('No PID provided');
      setIsLoading(false);
      setShouldShow(false);
      return;
    }

    const poll = async () => {
      try {
        const url = `${serverUrl}/word/${pidParam}/poll`;
        const headers: Record<string, string> = {
          'Accept': 'application/json',
          'X-Instance-Id': popupInstanceId,
        };
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok) {
           setShouldShow(false);
           return;
        }

        const data: WordPollResponse = await response.json();
        
        setShouldShow(data.shouldShow);

        if (!data.shouldShow) {
             console.log(`[AcademiaNotificationsPopup] Hiding popup: shouldShow=false. Active path: ${data.activeDocumentPath || 'none'}`);
             sendRequest('closeWindow', {});
             return;
        }

        if (data.shouldShow && data.projectId && data.projectFileId) {
             setProjectId(data.projectId);
             setFileId(data.projectFileId);
             setIsLoading(false);

             // Handle notifications
             if (data.latestReviewNotification) {
                 if (!hasUnreadReview) {
                     console.log('[AcademiaNotificationsPopup] Found NEW notification with conversation:', data.latestReviewNotification);
                     setCurrentNotification(data.latestReviewNotification);
                     setHasUnreadReview(true);
                     // Resize window for 3-section layout
                     await sendRequest('resizeWindow', { height: POPUP_HEIGHT_WITH_NOTIF });
                 }
             } else {
                 if (hasUnreadReview) {
                     // Notifications cleared
                     console.log('[AcademiaNotificationsPopup] Notifications cleared, resetting UI');
                     setCurrentNotification(null);
                     setHasUnreadReview(false);
                     // Resize window back to default (2-section layout)
                     await sendRequest('resizeWindow', { height: POPUP_HEIGHT_DEFAULT });
                 }
             }
        } else {
            // Not showing or missing ID - keep minimal state or hide
            setIsLoading(false);
        }

      } catch (error) {
        console.error('[AcademiaNotificationsPopup] Poll failed:', error);
      }
    };

    // Poll immediately
    poll();

    // Set interval (3 seconds)
    const intervalId = setInterval(poll, 3000);

    return () => clearInterval(intervalId);
  }, [pidParam, authToken, hasUnreadReview, sendRequest]);

  // Check project status periodically if we have IDs
  useEffect(() => {
      if (!projectId || !fileId) return;

      const checkStatus = async () => {
          await fetchProjectStatus(projectId, fileId, authToken);
      };

      // Check immediately
      checkStatus();

      // Check every 10 seconds (less frequent than main poll)
      const intervalId = setInterval(checkStatus, 10000);

      return () => clearInterval(intervalId);
  }, [projectId, fileId, authToken]);


  const handleSeeNewReview = async () => {
    if (!currentNotification) {
      console.error('[AcademiaNotificationsPopup] No notification to navigate to');
      return;
    }

    console.log('[AcademiaNotificationsPopup] See new review clicked:', currentNotification);

    try {
      // 1. Dismiss the notification via PATCH
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const patchResponse = await fetch(
        `${serverUrl}/api/notifications/${currentNotification.id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'dismissed' }),
        }
      );

      if (!patchResponse.ok) {
        console.error('[AcademiaNotificationsPopup] Failed to dismiss notification:', patchResponse.status);
        // Continue anyway - navigation is more important than dismissal
      } else {
        console.log('[AcademiaNotificationsPopup] Notification dismissed');
      }

      // 2. Close the popup first to avoid focus interference
      await sendRequest('closeWindow', {});

      // 3. Navigate to conversation via native bridge
      await sendRequest('navigateToPage', {
        page: 'conversation',
        projectId: currentNotification.project_id,
        conversationId: currentNotification.conversation_id,
      });
    } catch (err) {
      console.error('[AcademiaNotificationsPopup] Error in handleSeeNewReview:', err);
    }
  };

  const handleGenerateShortReview = async () => {
    if (!projectId || !fileId) {
      console.error('[AcademiaNotificationsPopup] Missing project or file ID');
      return;
    }

    console.log('[AcademiaNotificationsPopup] Triggering diff review...');

    // Track analytics - diff review triggered from overlay
    trackTriggerDiffReview('overlay', projectId, fileId);

    // Optimistically set reviewing state
    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
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
      console.log('[AcademiaNotificationsPopup] Diff review triggered:', data);

      // Start polling for status updates
      startStatusPolling(projectId, fileId, authToken);
    } catch (err) {
      console.error('[AcademiaNotificationsPopup] Failed to trigger diff review:', err);
      setReviewState('failed');
    }
  };

  const handleGenerateFullReview = async () => {
    if (!projectId || !fileId) {
      console.error('[AcademiaNotificationsPopup] Missing project or file ID');
      return;
    }

    console.log('[AcademiaNotificationsPopup] Triggering full review...');

    // Track analytics - full review triggered from overlay
    trackTriggerFullReview('overlay', projectId, fileId);

    // Optimistically set reviewing state
    setReviewState('reviewing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
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
      console.log('[AcademiaNotificationsPopup] Full review triggered:', data);

      // Start polling for status updates
      startStatusPolling(projectId, fileId, authToken);
    } catch (err) {
      console.error('[AcademiaNotificationsPopup] Failed to trigger full review:', err);
      setReviewState('failed');
    }
  };

  const handleClose = async () => {
    console.log('[AcademiaNotificationsPopup] Close button clicked');

    try {
      await sendRequest('closeWindow', {});
      console.log('[AcademiaNotificationsPopup] Close window request sent');
    } catch (err) {
      console.error('[AcademiaNotificationsPopup] Close failed:', err);
    }
  };

  // Compute UI state
  const isReviewing = reviewState === 'reviewing';
  const showFailedMessage = reviewState === 'failed';
  const buttonsDisabled = isLoading || !projectId || !fileId || isReviewing;

  // If we should not show (e.g. invalid PID or file), we might want to render empty or a message
  // For popup, it usually stays open but maybe disabled. Or we can just disable buttons.
  // The 'shouldShow' from poll refers more to the Button visibility.
  // But if the project file is gone, the popup probably shouldn't be interactable.
  // Let's rely on buttonsDisabled which checks for missing projectId/fileId.

  return (
    <div style={styles.container}>
      <div style={styles.modal}>
        {/* Close Button */}
        <button
          style={styles.closeButton}
          onClick={handleClose}
          aria-label="Close"
          title="Close"
        >
          ×
        </button>

        {/* Status Messages */}
        {showFailedMessage && (
          <div style={styles.errorMessage}>
            <p style={styles.errorText}>The last review failed. Please try again.</p>
          </div>
        )}

        {/* Content */}
        <div style={styles.content}>
          {/* New Review Ready Section - Conditional */}
          {hasUnreadReview && (
            <div style={styles.sectionWithBorder}>
              <p style={styles.sectionText}>A new review is ready</p>
              <button
                style={styles.actionButton}
                className="action-button"
                onClick={handleSeeNewReview}
              >
                <span style={styles.buttonText}>See new review</span>
                <ArrowForwardIcon />
              </button>
            </div>
          )}

          {/* Generate Short Review Section */}
          <div style={styles.sectionWithBorder}>
            <p style={styles.sectionText}>
              Generate a short review based on your last changes
            </p>
            <button
              style={{
                ...styles.actionButton,
                ...(buttonsDisabled ? styles.actionButtonDisabled : {}),
              }}
              className="action-button"
              onClick={handleGenerateShortReview}
              disabled={buttonsDisabled}
            >
              <span
                style={{
                  ...styles.buttonText,
                  ...(buttonsDisabled ? styles.buttonTextDisabled : {}),
                }}
              >
                {isReviewing ? 'Reviewing...' : 'Generate short review'}
              </span>
              {!isReviewing && <ArrowForwardIcon />}
            </button>
          </div>

          {/* Generate Full Review Section */}
          <div style={styles.section}>
            <p style={styles.sectionText}>
              Generate a full review of your entire document
            </p>
            <button
              style={{
                ...styles.actionButton,
                ...(buttonsDisabled ? styles.actionButtonDisabled : {}),
              }}
              className="action-button"
              onClick={handleGenerateFullReview}
              disabled={buttonsDisabled}
            >
              <span
                style={{
                  ...styles.buttonText,
                  ...(buttonsDisabled ? styles.buttonTextDisabled : {}),
                }}
              >
                {isReviewing ? 'Reviewing...' : 'Generate full review'}
              </span>
              {!isReviewing && <ArrowForwardIcon />}
            </button>
          </div>
        </div>
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
    width: '370px',
    background: '#F9F8F6', // Figma: background-beige-light
    borderRadius: '16px', // Figma: corner-radius/radius-lg
    border: '1px solid #CCC9BC', // Figma: stroke-beige-light
    boxShadow: 'none',
    position: 'relative',
    padding: '24px', // Figma: spacing/sm-24
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    overflow: 'hidden',
  },
  closeButton: {
    position: 'absolute',
    top: '11px',
    right: '15px',
    width: '20px',
    height: '20px',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: '20px',
    fontWeight: 300,
    color: '#141413', // Figma: text-primary
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    transition: 'background-color 0.2s ease',
    padding: 0,
    lineHeight: 1,
  },
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
  errorMessage: {
    backgroundColor: '#FEE2E2',
    borderRadius: '8px',
    padding: '12px 16px',
    marginBottom: '8px',
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
  `;

  // Only append if not already added
  if (!document.getElementById('academia-notifications-popup-styles')) {
    styleElement.id = 'academia-notifications-popup-styles';
    document.head.appendChild(styleElement);
  }
}

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<AcademiaNotificationsPopup />);
  console.log('[AcademiaNotificationsPopup] React app initialized');
} else {
  console.error('[AcademiaNotificationsPopup] Root container not found!');
}

// Wait for bridge to be ready
const checkReady = setInterval(() => {
  const bridge = window.__messageBridge;
  if (bridge && bridge.isConnected()) {
    console.log('[AcademiaNotificationsPopup] Bridge connected and ready');
    clearInterval(checkReady);
  }
}, 100);

// Timeout after 5 seconds
setTimeout(() => {
  const bridge = window.__messageBridge;
  if (!bridge || !bridge.isConnected()) {
    console.error('[AcademiaNotificationsPopup] Bridge connection timeout - native bridge may not be initialized');
    clearInterval(checkReady);
  }
}, 5000);
