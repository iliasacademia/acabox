import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { onVisibilityChanged, cacheFullStoryConfig, FullStoryConfig } from './utils/fullstory';
import './ReviewButton.css';

const serverUrl = window.location.origin;

const urlParams = new URLSearchParams(window.location.search);
const widParam = urlParams.get('wid');
const tokenParam = urlParams.get('token');

function postBridge(action: string, payload: Record<string, unknown> = {}) {
  return fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: 0, wid: widParam }),
  });
}

function getUserFriendlyError(serverMessage: string | undefined, statusCode: number | undefined): string {
  if (serverMessage) {
    if (serverMessage.includes('No text selected')) {
      return 'Could not detect your text selection. Try selecting the text again.';
    }
    if (serverMessage.includes('No document text') || serverMessage.includes('Document text is empty')) {
      return 'Could not read the document text. Try saving and reopening the document.';
    }
    if (serverMessage.includes('Cannot read selected text') || serverMessage.includes('Cannot read document text')) {
      return 'Could not read the text files. Try selecting the text again.';
    }
    if (serverMessage.includes('Window not found')) {
      return 'Lost track of the document window. Try clicking on the document and selecting text again.';
    }
    if (serverMessage.includes('No project file mapped')) {
      return 'This document is not linked to a project. Please share it with Writing Agent first.';
    }
  }
  if (statusCode === 502) {
    return 'Could not connect to the review service. Please check your internet connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

interface WordPollResponse {
  isReviewingSelectedText?: boolean;
  shouldShowReviewButton?: boolean;
  fullStoryConfig?: FullStoryConfig;
}

interface WebSocketMessage {
  type: 'poll';
  data: WordPollResponse;
}

const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Custom hook: connects to /ws/word/v2/:wid via WebSocket for real-time updates.
 * Falls back to HTTP polling if WebSocket fails permanently.
 */
function useWordPoll(
  wid: string | null,
  token: string | null,
  apiBaseUrl: string
): { isReviewing: boolean; shouldShowReviewButton: boolean } {
  const [isReviewing, setIsReviewing] = useState(false);
  const [shouldShowReviewButton, setShouldShowReviewButton] = useState(false);

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
      setIsReviewing(data.isReviewingSelectedText ?? false);
      setShouldShowReviewButton(data.shouldShowReviewButton ?? false);
    }

    function startFallbackPolling() {
      if (fallbackInterval || cleanedUp) return;
      usingFallback = true;
      console.log('[ReviewButton] WebSocket unavailable, falling back to HTTP polling');

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
        console.log('[ReviewButton] WebSocket connected');
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
          console.warn('[ReviewButton] WebSocket auth failed, falling back to HTTP polling');
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
      console.log(`[ReviewButton] Reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
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

  return { isReviewing, shouldShowReviewButton };
}

const ReviewButton: React.FC = () => {
  const { isReviewing: serverIsReviewing, shouldShowReviewButton } = useWordPoll(widParam, tokenParam, serverUrl);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    onVisibilityChanged('review-button', shouldShowReviewButton);
  }, [shouldShowReviewButton]);

  // Reset isSubmitting once server confirms review is in progress
  useEffect(() => {
    if (serverIsReviewing) {
      setIsSubmitting(false);
    }
  }, [serverIsReviewing]);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isSubmitting || serverIsReviewing || !widParam) return;

    setIsSubmitting(true);

    try {
      const res = await fetch(`${serverUrl}/api/selected-text-review/${widParam}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenParam}` },
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('[ReviewButton] Review request failed:', data);
        const friendlyError = getUserFriendlyError(data?.message, res.status);
        postBridge('showReviewError', { message: friendlyError }).catch(() => {});
        setIsSubmitting(false);
        return;
      }
      console.log('[ReviewButton] Review triggered successfully');
      // Keep isSubmitting true - let serverIsReviewing take over
    } catch (err) {
      console.error('[ReviewButton] Review request error:', err);
      postBridge('showReviewError', { message: 'Could not connect to the review service. Please check your internet connection and try again.' }).catch(() => {});
      setIsSubmitting(false);
    }
  };

  // Hide if not showing or if review is in progress
  if (!shouldShowReviewButton || isSubmitting || serverIsReviewing) {
    return null;
  }

  return (
    <div className="review-button-container">
      <button
        className="review-button"
        onMouseDown={handleClick}
      >
        Review
      </button>
    </div>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<ReviewButton />);
} else {
  console.error('[ReviewButton] Root element not found');
}

export default ReviewButton;
