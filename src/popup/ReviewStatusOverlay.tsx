import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { onVisibilityChanged, cacheFullStoryConfig, FullStoryConfig } from './utils/fullstory';
import { ReviewInputView } from './popupV2/ReviewInputView';
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
  wid?: string;
}

interface WebSocketMessage {
  type: 'poll';
  data: WordPollResponse;
}

const MAX_RECONNECT_ATTEMPTS = 5;

function postBridge(action: string, payload: Record<string, unknown> = {}, widOverride?: string | null) {
  const effectiveWid = widOverride ?? widParam;
  return fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: pidParam ? Number(pidParam) : 0, wid: effectiveWid }),
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
  focusedWid: string | null;
} {
  const [reviewType, setReviewType] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [shouldShowReviewStatusOverlay, setShouldShowReviewStatusOverlay] = useState(false);
  const [isAwaitingReviewInput, setIsAwaitingReviewInput] = useState(false);
  const [focusedWid, setFocusedWid] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
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
      if (data.wid) setFocusedWid(data.wid);
    }

    function startFallbackPolling() {
      if (fallbackInterval || cleanedUp) return;
      usingFallback = true;
      console.log('[ReviewStatusOverlay] WebSocket unavailable, falling back to HTTP polling');

      const poll = async () => {
        if (cleanedUp) return;
        try {
          const pollUrl = `${apiBaseUrl}/word/v4/focused/poll`;
          const res = await fetch(pollUrl, {
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

      const wsUrl = `${apiBaseUrl.replace(/^http/, 'ws')}/ws/word/v4/focused?token=${encodeURIComponent(token!)}`;

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

  return { reviewType, selectedText, shouldShowReviewStatusOverlay, isAwaitingReviewInput, focusedWid };
}

const ReviewStatusOverlay: React.FC = () => {
  const { reviewType, selectedText, shouldShowReviewStatusOverlay, isAwaitingReviewInput, focusedWid } = useWordPoll(widParam, tokenParam, serverUrl);

  useEffect(() => {
    onVisibilityChanged('review-status-overlay', shouldShowReviewStatusOverlay);
  }, [shouldShowReviewStatusOverlay]);

  if (!shouldShowReviewStatusOverlay || (!isAwaitingReviewInput && !reviewType)) {
    return null;
  }

  const handleBackClick = async () => {
    try {
      await postBridge('openPopup', {}, focusedWid);
    } catch (err) {
      console.error('[ReviewStatusOverlay] Failed to open popup:', err);
    }
  };

  const handleCloseClick = async () => {
    try {
      await postBridge('clearReview', {}, focusedWid);
    } catch (err) {
      console.error('[ReviewStatusOverlay] Failed to clear review:', err);
    }
  };

  return (
    <div className="review-status-overlay-container">
      <ReviewInputView
        selectedText={selectedText}
        reviewType={reviewType}
        isAwaitingReviewInput={isAwaitingReviewInput}
        effectiveWid={focusedWid}
        onBack={handleBackClick}
        onClose={handleCloseClick}
      />
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
