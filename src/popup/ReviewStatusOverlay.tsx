import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { onVisibilityChanged, cacheFullStoryConfig, FullStoryConfig } from './utils/fullstory';
import './ReviewStatusOverlay.css';

const serverUrl = window.location.origin;

const urlParams = new URLSearchParams(window.location.search);
const pidParam = urlParams.get('pid');
const widParam = urlParams.get('wid');
const tokenParam = urlParams.get('token');

interface WordPollResponse {
  isReviewingSelectedText?: boolean;
  isAwaitingReviewInput?: boolean;
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

function postBridge(action: string, payload: Record<string, unknown> = {}) {
  return fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: pidParam ? Number(pidParam) : 0, wid: widParam }),
  });
}

function useWordPoll(
  wid: string | null,
  token: string | null,
  apiBaseUrl: string
): {
  reviewType: string | null;
  selectedText: string | null;
  shouldShowReviewStatusOverlay: boolean;
  isAwaitingReviewInput: boolean;
} {
  const [reviewType, setReviewType] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [shouldShowReviewStatusOverlay, setShouldShowReviewStatusOverlay] = useState(false);
  const [isAwaitingReviewInput, setIsAwaitingReviewInput] = useState(false);

  useEffect(() => {
    if (!wid || !token) {
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
      setReviewType(isReviewing ? (data.reviewType || 'selected-text') : null);
      setSelectedText(data.selectedText || null);
      setShouldShowReviewStatusOverlay(data.shouldShowReviewStatusOverlay ?? false);
      setIsAwaitingReviewInput(data.isAwaitingReviewInput ?? false);
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
          if (!res.ok) { return; }
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

  return { reviewType, selectedText, shouldShowReviewStatusOverlay, isAwaitingReviewInput };
}

const ReviewStatusOverlay: React.FC = () => {
  const { reviewType, selectedText, shouldShowReviewStatusOverlay, isAwaitingReviewInput } = useWordPoll(widParam, tokenParam, serverUrl);
  const [progress, setProgress] = React.useState(0);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [showSelectedTextToggle, setShowSelectedTextToggle] = useState(false);
  const selectedTextRef = useRef<HTMLDivElement>(null);

  // Input mode state
  const [userPrompt, setUserPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = selectedTextRef.current;
    if (!el) return;
    setShowSelectedTextToggle(el.scrollHeight > el.clientHeight);
  }, [selectedText, isExpanded]);

  useEffect(() => {
    onVisibilityChanged('review-status-overlay', shouldShowReviewStatusOverlay);
  }, [shouldShowReviewStatusOverlay]);

  // Auto-focus textarea in input mode
  useEffect(() => {
    if (isAwaitingReviewInput && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isAwaitingReviewInput]);

  // Clear input state when overlay is hidden
  useEffect(() => {
    if (!shouldShowReviewStatusOverlay) {
      setUserPrompt('');
      setIsSubmitting(false);
      setIsExpanded(false);
    }
  }, [shouldShowReviewStatusOverlay]);

  // Simulate progress for reviewing mode
  React.useEffect(() => {
    if (shouldShowReviewStatusOverlay && reviewType) {
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
  }, [shouldShowReviewStatusOverlay, reviewType]);

  const handleBackClick = async () => {
    try {
      await postBridge('openPopup');
    } catch (err) {
      console.error('[ReviewStatusOverlay] Failed to open popup:', err);
    }
  };

  const handleCloseClick = async () => {
    try {
      await postBridge('clearReview');
    } catch (err) {
      console.error('[ReviewStatusOverlay] Failed to clear review:', err);
    }
  };

  const handleSend = async () => {
    if (!widParam || isSubmitting) return;
    setIsSubmitting(true);

    try {
      const res = await fetch(`${serverUrl}/api/selected-text-review/${widParam}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenParam}`,
        },
        body: JSON.stringify({ userPrompt: userPrompt.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('[ReviewStatusOverlay] Review request failed:', data);
        postBridge('showReviewError', { message: data?.message || 'Something went wrong. Please try again.' }).catch(() => {});
        setIsSubmitting(false);
        return;
      }
      console.log('[ReviewStatusOverlay] Review triggered successfully');
      // Transition to reviewing mode happens via poll data
    } catch (err) {
      console.error('[ReviewStatusOverlay] Review request error:', err);
      postBridge('showReviewError', { message: 'Could not connect to the review service. Please check your internet connection and try again.' }).catch(() => {});
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!shouldShowReviewStatusOverlay || (!isAwaitingReviewInput && !reviewType)) {
    return null;
  }

  const isInputMode = isAwaitingReviewInput && !reviewType;

  const getHeaderText = () => {
    if (isInputMode) return 'Review selection';
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
            <div className="review-status-title">{getHeaderText()}</div>
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
              <div
                ref={selectedTextRef}
                style={isExpanded
                  ? { maxHeight: '100px', overflowY: 'auto' }
                  : { display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
                }
              >
                {selectedText}
              </div>
              {showSelectedTextToggle && (
                <button
                  className="review-see-more"
                  onClick={() => setIsExpanded(!isExpanded)}
                >
                  {isExpanded ? 'See less' : 'See more'}
                </button>
              )}
            </>
          ) : (
            isInputMode ? 'Selected text' : 'Reviewing...'
          )}
        </div>

        {isInputMode ? (
          <div className="review-input-section">
            <textarea
              ref={textareaRef}
              className="review-input-area"
              placeholder="Add instructions (optional)"
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
              rows={2}
            />
            <button
              className="review-send-button"
              onClick={handleSend}
              disabled={isSubmitting}
              aria-label="Send"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 9L15 9M15 9L10 4M15 9L10 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="review-status-progress">
            <div className="review-progress-bar">
              <div className="review-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="review-progress-footer">
              <span className="review-progress-text">{Math.round(progress)}%</span>
            </div>
          </div>
        )}
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
