import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import academiaLogos from '../assets/academia-logos.svg';
import './AcademiaNotificationsButton.css';

// Get serverUrl from window.location.origin
const serverUrl = window.location.origin;

// Parse URL params
const urlParams = new URLSearchParams(window.location.search);
const pidParam = urlParams.get('pid');
const tokenParam = urlParams.get('token');

// Define response type locally to avoid importing server types in client code
interface WordPollResponse {
  shouldShow: boolean;
  projectId?: number;
  projectFileId?: number;
  notificationCount: number;
  isActive: boolean;
}

interface WebSocketMessage {
  type: 'poll';
  data: WordPollResponse;
}

const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Custom hook: connects to /ws/word/:pid via WebSocket for real-time updates.
 * Falls back to HTTP polling (3s) if WebSocket fails permanently.
 *
 * All connection logic lives inside a single useEffect to avoid
 * useCallback dependency cycles that cause infinite reconnect loops.
 */
function useWordPollWebSocket(
  pid: string | null,
  token: string | null,
  apiBaseUrl: string
): { shouldShow: boolean; badgeCount: number } {
  const [shouldShow, setShouldShow] = useState(false);
  const [badgeCount, setBadgeCount] = useState(0);

  useEffect(() => {
    if (!pid || !token) {
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
      setBadgeCount(data.notificationCount);
    }

    // --- HTTP polling fallback (same as V1) ---
    function startFallbackPolling() {
      if (fallbackInterval || cleanedUp) return;
      usingFallback = true;
      console.log('[V2] WebSocket unavailable, falling back to HTTP polling');

      const poll = async () => {
        if (cleanedUp) return;
        try {
          const headers: Record<string, string> = { Accept: 'application/json' };
          headers['Authorization'] = `Bearer ${token}`;
          const res = await fetch(`${apiBaseUrl}/word/${pid}/poll`, { headers });
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

    // --- WebSocket connection ---
    function connect() {
      if (cleanedUp || usingFallback) return;

      const wsUrl = `${apiBaseUrl.replace(/^http/, 'ws')}/ws/word/${pid}?token=${encodeURIComponent(token!)}`;

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

    console.log({pid, token, apiBaseUrl});
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
  }, [pid, token, apiBaseUrl]);

  return { shouldShow, badgeCount };
}

const AcademiaNotificationsButtonV2: React.FC = () => {
  const [loading, setLoading] = useState(false);

  const { shouldShow, badgeCount } = useWordPollWebSocket(
    pidParam,
    tokenParam,
    serverUrl
  );

  const handleClick = async () => {
    setLoading(true);
    try {
      await fetch(`${serverUrl}/bridge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenParam}`,
        },
        body: JSON.stringify({ action: 'buttonClicked', payload: {}, pid: Number(pidParam) }),
      });
    } catch (err) {
      console.error('[AcademiaNotificationsButtonV2] Click failed:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!shouldShow) {
    return null;
  }

  const displayCount = badgeCount > 9 ? '9+' : badgeCount.toString();

  return (
    <div className="button-container">
      <button
        className="button"
        onClick={handleClick}
        disabled={loading}
        data-node-id="1630:6725"
      >
        <div className="logo-section" data-node-id="1630:6720">
          <img src={academiaLogos} alt="Academia" className="logo" data-node-id="1630:6721" />
        </div>
        <span className="feedback-text" data-node-id="1630:6722">Feedback</span>
        {badgeCount > 0 && (
          <div className="badge" data-node-id="1630:6723">
            <span className="badge-text" data-node-id="1630:6724">
              {displayCount}
            </span>
          </div>
        )}
      </button>
    </div>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<AcademiaNotificationsButtonV2 />);
} else {
  console.error('[AcademiaNotificationsButtonV2] Root element not found');
}

export default AcademiaNotificationsButtonV2;
