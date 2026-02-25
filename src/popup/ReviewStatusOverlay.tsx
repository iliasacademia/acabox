import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { onVisibilityChanged, cacheFullStoryConfig, FullStoryConfig } from './utils/fullstory';
import './ReviewStatusOverlay.css';

const serverUrl = window.location.origin;

const urlParams = new URLSearchParams(window.location.search);
const pidParam = urlParams.get('pid');
const widParam = urlParams.get('wid');
const tokenParam = urlParams.get('token');

interface WordPollResponse {
  shouldShow: boolean;
  isReviewingSelectedText?: boolean;
  reviewType?: 'full-paper' | 'selected-text' | 'review-changes';
  selectedText?: string;
  selectedTextReviewStartedAt?: number;
  shouldShowReviewStatusOverlay?: boolean;
  fullStoryConfig?: FullStoryConfig;
}

interface WebSocketMessage {
  type: 'poll';
  data: WordPollResponse;
}

const MAX_RECONNECT_ATTEMPTS = 5;

function useWordPoll(
  wid: string | null,
  token: string | null,
  apiBaseUrl: string
): { shouldShow: boolean; reviewType: string | null; selectedText: string | null; shouldShowReviewStatusOverlay: boolean } {
  const [shouldShow, setShouldShow] = useState(false);
  const [reviewType, setReviewType] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [shouldShowReviewStatusOverlay, setShouldShowReviewStatusOverlay] = useState(false);

  useEffect(() => {
    if (!wid || !token) {
      setShouldShow(false);
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
      if (data.fullStoryConfig) cacheFullStoryConfig(data.fullStoryConfig);
      const isReviewing = data.isReviewingSelectedText ?? false;
      setShouldShow(isReviewing);
      setReviewType(isReviewing ? (data.reviewType || 'selected-text') : null);
      setSelectedText(data.selectedText || null);
      setShouldShowReviewStatusOverlay(data.shouldShowReviewStatusOverlay ?? false);
    }

    function startFallbackPolling() {
      if (fallbackInterval || cleanedUp) return;
      usingFallback = true;
      console.log('[ReviewStatusOverlay] WebSocket unavailable, falling back to HTTP polling');

      const poll = async () => {
        if (cleanedUp) return;
        try {
          const res = await fetch(`${apiBaseUrl}/word/v2/${wid}/poll`, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          });
          if (!res.ok) { setShouldShow(false); return; }
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
        console.log('[ReviewStatusOverlay] WebSocket connected');
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
        if (cleanedUp || usingFallback) return;
        if (event.code === 4401) {
          console.warn('[ReviewStatusOverlay] WebSocket auth failed, falling back to HTTP polling');
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
      console.log(`[ReviewStatusOverlay] Reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      cleanedUp = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopFallbackPolling();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [wid, token, apiBaseUrl]);

  return { shouldShow, reviewType, selectedText, shouldShowReviewStatusOverlay };
}

const ReviewStatusOverlay: React.FC = () => {
  const { shouldShow, reviewType, selectedText, shouldShowReviewStatusOverlay } = useWordPoll(widParam, tokenParam, serverUrl);
  const [progress, setProgress] = React.useState(0);
  const [isExpanded, setIsExpanded] = React.useState(false);

  useEffect(() => {
    onVisibilityChanged('review-status-overlay', shouldShowReviewStatusOverlay);
  }, [shouldShowReviewStatusOverlay]);

  // Simulate progress for now (in production, this would come from the API)
  React.useEffect(() => {
    if (shouldShow && reviewType) {
      setProgress(0);
      const interval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 90) {
            clearInterval(interval);
            return 90;
          }
          return prev + Math.random() * 10;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [shouldShow, reviewType]);

  console.log('[ReviewStatusOverlay] shouldShow:', shouldShow, 'reviewType:', reviewType);

  const handleBackClick = async () => {
    // Open the popup to show the list of reviews
    try {
      await fetch(`${serverUrl}/bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenParam}`,
        },
        body: JSON.stringify({
          action: 'openPopup',
          payload: {},
          pid: pidParam ? Number(pidParam) : 0,
          wid: widParam
        }),
      });
    } catch (err) {
      console.error('[ReviewStatusOverlay] Failed to open popup:', err);
    }
  };

  const handleCloseClick = async () => {
    // Clear the review state when closing, which dismisses the overlay
    try {
      await fetch(`${serverUrl}/bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenParam}`,
        },
        body: JSON.stringify({
          action: 'clearReview',
          payload: {},
          pid: pidParam ? Number(pidParam) : 0,
          wid: widParam
        }),
      });
    } catch (err) {
      console.error('[ReviewStatusOverlay] Failed to clear review:', err);
    }
  };

  if (!shouldShow || !reviewType) {
    return null;
  }

  const getReviewText = () => {
    switch (reviewType) {
      case 'full-paper':
        return 'Reviewing paper';
      case 'review-changes':
        return 'Reviewing changes';
      case 'selected-text':
      default:
        return 'Reviewing selection';
    }
  };

  return (
    <div className="review-status-overlay-container">
      <div className="review-status-card">
        <div className="review-status-header">
          <div className="review-status-header-left">
            <button
              className="review-status-back"
              onClick={handleBackClick}
              aria-label="Back"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M12 4L6 10L12 16"
                  stroke="#141413"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div className="review-status-title">{getReviewText()}</div>
          </div>
          <button
            className="review-status-close"
            onClick={handleCloseClick}
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M12 4L4 12M4 4L12 12"
                stroke="#141413"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="review-status-content">
          {selectedText ? (
            <>
              {isExpanded || selectedText.length <= 80
                ? selectedText
                : `${selectedText.substring(0, 80)}...`
              }{' '}
              {selectedText.length > 80 && (
                <button
                  className="review-see-more"
                  onClick={() => setIsExpanded(!isExpanded)}
                >
                  {isExpanded ? 'See less' : 'See more'}
                </button>
              )}
            </>
          ) : (
            'Reviewing...'
          )}
        </div>
        <div className="review-status-progress">
          <div className="review-progress-bar">
            <div className="review-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="review-progress-footer">
            <span className="review-progress-text">{Math.round(progress)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<ReviewStatusOverlay />);
} else {
  console.error('[ReviewStatusOverlay] Root element not found');
}

export default ReviewStatusOverlay;
