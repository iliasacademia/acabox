import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChatStreamMessage } from '../../cobuilding/shared/types';
import {
  WordPollResponse,
  ServerWebSocketMessage,
  ClientWebSocketMessage,
  popupInstanceId,
  setV4FocusedWid,
} from './shared';

const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_TIMEOUT_MS = 30_000;

type ChatEventCallback = (msg: ChatStreamMessage) => void;
type ChatDoneCallback = () => void;
type ChatErrorCallback = (error: string) => void;

interface ChatSessionCallbacks {
  onEvent: ChatEventCallback;
  onDone: ChatDoneCallback;
  onError: ChatErrorCallback;
}

export interface OverlayWebSocket {
  pollData: WordPollResponse | null;
  connected: boolean;
  sendChatMessage: (sessionId: string, text: string, documentPath?: string, selectedText?: string) => void;
  subscribeToChatSession: (sessionId: string, callbacks: ChatSessionCallbacks) => () => void;
  sendBridgeCommand: (action: string, payload?: Record<string, unknown>) => void;
}

/**
 * Unified WebSocket hook for all overlay↔main communication.
 * Handles polling, chat streaming, and bridge commands over a single connection.
 */
export function useOverlayWebSocket(
  wid: string | null,
  token: string | null,
  apiBaseUrl: string
): OverlayWebSocket {
  const [pollData, setPollData] = useState<WordPollResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Chat session callbacks: sessionId → callbacks
  const chatCallbacksRef = useRef<Map<string, ChatSessionCallbacks>>(new Map());

  useEffect(() => {
    if (!token) {
      setPollData(null);
      setConnected(false);
      return;
    }

    let cleanedUp = false;
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let usingFallback = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

    function applyPollData(data: WordPollResponse) {
      if (cleanedUp) return;
      if (data.wid) setV4FocusedWid(data.wid);
      setPollData(data);
    }

    function resetHeartbeat() {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        console.warn('[WS] Heartbeat timeout — closing for reconnect');
        ws?.close();
      }, HEARTBEAT_TIMEOUT_MS);
    }

    // --- HTTP polling fallback (poll-only, no chat/bridge) ---
    function startFallbackPolling() {
      if (fallbackInterval || cleanedUp) return;
      usingFallback = true;
      setConnected(false);
      console.log('[WS] WebSocket unavailable, falling back to HTTP polling');

      const poll = async () => {
        if (cleanedUp) return;
        try {
          const headers: Record<string, string> = {
            'Accept': 'application/json',
            'X-Instance-Id': popupInstanceId,
            'Authorization': `Bearer ${token}`,
          };
          const pollUrl = `${apiBaseUrl}/word/v4/focused/poll`;
          const res = await fetch(pollUrl, { headers });
          if (!res.ok) {
            setPollData(prev => prev ? { ...prev, shouldShowPopupV2: false } : null);
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

      const wsUrl = `${apiBaseUrl.replace(/^http/, 'ws')}/ws/word/v4/focused?token=${encodeURIComponent(token!)}`;

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        console.log('[WS] WebSocket connected');
        reconnectAttempt = 0;
        stopFallbackPolling();
        setConnected(true);
        wsRef.current = ws;
        resetHeartbeat();
      };

      ws.onmessage = (event) => {
        try {
          const msg: ServerWebSocketMessage = JSON.parse(event.data as string);
          resetHeartbeat();
          handleServerMessage(msg, applyPollData, chatCallbacksRef.current);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        ws = null;
        wsRef.current = null;
        setConnected(false);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        console.log('[WS] WebSocket closed', event);
        if (cleanedUp || usingFallback) return;
        if (event.code === 4401) {
          console.warn('[WS] WebSocket auth failed, falling back to HTTP polling');
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
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
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
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (ws) {
        ws.onclose = null; // prevent onclose from triggering reconnect
        ws.close();
        ws = null;
      }
      wsRef.current = null;
      setConnected(false);
      stopFallbackPolling();
      chatCallbacksRef.current.clear();
    };
  }, [wid, token, apiBaseUrl]);

  const sendChatMessage = useCallback((
    sessionId: string,
    text: string,
    documentPath?: string,
    selectedText?: string,
  ) => {
    const msg: ClientWebSocketMessage = {
      type: 'chat:send',
      sessionId,
      text,
      ...(documentPath ? { documentPath } : {}),
      ...(selectedText ? { selectedText } : {}),
    };
    sendToServer(wsRef.current, msg);
  }, []);

  const subscribeToChatSession = useCallback((
    sessionId: string,
    callbacks: ChatSessionCallbacks,
  ): (() => void) => {
    chatCallbacksRef.current.set(sessionId, callbacks);
    sendToServer(wsRef.current, { type: 'chat:subscribe', sessionId });
    return () => {
      chatCallbacksRef.current.delete(sessionId);
      sendToServer(wsRef.current, { type: 'chat:unsubscribe', sessionId });
    };
  }, []);

  const sendBridgeCommand = useCallback((
    action: string,
    payload: Record<string, unknown> = {},
  ) => {
    sendToServer(wsRef.current, { type: 'bridge', action, payload });
  }, []);

  return { pollData, connected, sendChatMessage, subscribeToChatSession, sendBridgeCommand };
}

function handleServerMessage(
  msg: ServerWebSocketMessage,
  applyPollData: (data: WordPollResponse) => void,
  chatCallbacks: Map<string, ChatSessionCallbacks>,
): void {
  switch (msg.type) {
    case 'poll':
      applyPollData(msg.data);
      break;

    case 'chat:event': {
      const cb = chatCallbacks.get(msg.sessionId);
      cb?.onEvent(msg.data);
      break;
    }

    case 'chat:done': {
      const cb = chatCallbacks.get(msg.sessionId);
      cb?.onDone();
      break;
    }

    case 'chat:error': {
      const cb = chatCallbacks.get(msg.sessionId);
      cb?.onError(msg.error);
      break;
    }

    case 'heartbeat':
      // Heartbeat resets the timeout — handled by the caller before dispatching
      break;

    case 'bridge:ack':
      // Bridge acks could be handled via a promise map if needed
      break;
  }
}

function sendToServer(ws: WebSocket | null, msg: ClientWebSocketMessage): void {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection dead — will be cleaned up on close
  }
}

/**
 * Original poll-only WebSocket hook used by existing overlay consumers.
 * Kept as an independent implementation (not wrapping useOverlayWebSocket)
 * to avoid introducing extra React hooks into existing component trees.
 */
export function useWordPollWebSocket(
  wid: string | null,
  token: string | null,
  apiBaseUrl: string
): WordPollResponse | null {
  const [pollData, setPollData] = useState<WordPollResponse | null>(null);

  useEffect(() => {
    if (!token) {
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
      if (data.wid) setV4FocusedWid(data.wid);
      setPollData(data);
    }

    function startFallbackPolling() {
      if (fallbackInterval || cleanedUp) return;
      usingFallback = true;
      console.log('[WS] WebSocket unavailable, falling back to HTTP polling');
      const poll = async () => {
        if (cleanedUp) return;
        try {
          const headers: Record<string, string> = {
            'Accept': 'application/json',
            'X-Instance-Id': popupInstanceId,
            'Authorization': `Bearer ${token}`,
          };
          const res = await fetch(`${apiBaseUrl}/word/v4/focused/poll`, { headers });
          if (!res.ok) {
            setPollData(prev => prev ? { ...prev, shouldShowPopupV2: false } : null);
            return;
          }
          const data: WordPollResponse = await res.json();
          applyPollData(data);
        } catch { /* ignore */ }
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
        console.log('[WS] WebSocket connected');
        reconnectAttempt = 0;
        stopFallbackPolling();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'poll') {
            applyPollData(msg.data);
          }
        } catch { /* ignore */ }
      };

      ws.onclose = (event) => {
        ws = null;
        if (cleanedUp || usingFallback) return;
        if (event.code === 4401) {
          startFallbackPolling();
          return;
        }
        scheduleReconnect();
      };

      ws.onerror = () => {};
    }

    function scheduleReconnect() {
      if (cleanedUp || usingFallback) return;
      reconnectAttempt += 1;
      if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
        startFallbackPolling();
        return;
      }
      const delay = Math.pow(2, reconnectAttempt - 1) * 1000;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      cleanedUp = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      stopFallbackPolling();
    };
  }, [wid, token, apiBaseUrl]);

  return pollData;
}
