import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './ReviewButton.css';

const serverUrl = window.location.origin;

const urlParams = new URLSearchParams(window.location.search);
const widParam = urlParams.get('wid');
const tokenParam = urlParams.get('token');

interface WordPollResponse {
  shouldShow: boolean;
  isReviewingSelectedText?: boolean;
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
): { shouldShow: boolean; isReviewing: boolean } {
  const [shouldShow, setShouldShow] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);

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
      setShouldShow(data.shouldShow);
      setIsReviewing(data.isReviewingSelectedText ?? false);
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

  return { shouldShow, isReviewing };
}

const ReviewButton: React.FC = () => {
  const { shouldShow, isReviewing: serverIsReviewing } = useWordPoll(widParam, tokenParam, serverUrl);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isSubmitting || serverIsReviewing || !widParam) {
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch(`${serverUrl}/api/selected-text-review/${widParam}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenParam}` },
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('[ReviewButton] Review request failed:', data);
        setIsSubmitting(false);
        return;
      }
      console.log('[ReviewButton] Review triggered successfully');
      // Keep isSubmitting true - let serverIsReviewing take over
    } catch (err) {
      console.error('[ReviewButton] Review request error:', err);
      setIsSubmitting(false);
    }
  };

  // Hide if not showing or if review is in progress
  if (!shouldShow || isSubmitting || serverIsReviewing) {
    return null;
  }

  return (
    <div className="review-button-container">
      <button
        className="review-button"
        onClick={handleClick}
        onMouseDown={(e) => e.stopPropagation()}
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
