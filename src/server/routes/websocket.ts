/**
 * Unified WebSocket route handler for overlay↔main communication.
 *
 * Route: GET /ws/word/v4/focused (upgraded to WebSocket)
 *
 * Multiplexed protocol — all overlay communication flows through this connection:
 *
 * Server → Client:
 *   { type: "poll", data: OverlayPollResponse }
 *   { type: "chat:event", sessionId, data: ChatStreamMessage }
 *   { type: "chat:done", sessionId }
 *   { type: "chat:error", sessionId, error }
 *   { type: "bridge:ack", requestId, data }
 *   { type: "heartbeat" }
 *
 * Client → Server:
 *   { type: "refresh" }
 *   { type: "chat:send", sessionId, text, documentPath?, selectedText? }
 *   { type: "chat:subscribe", sessionId }
 *   { type: "chat:unsubscribe", sessionId }
 *   { type: "bridge", action, payload, requestId? }
 *
 * Auth: token passed via ?token=TOKEN query param
 */

import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { wordPollEventBus, WordPollChangeReason } from '../events/wordPollEventBus';
import { buildWordPollResponseV2 } from '../services/buildWordPollResponseV2';
import { TokenManager } from '../middleware/auth';
import { defaultLogger as logger } from '../../utils/logger';
import { getCachedUserData } from '../../userDataCache';
import { FullStoryStaticConfig } from './wordV2';
import { windowMonitorService } from '../../windowMonitorService';
import { getOverlayChatSendHandler, getOverlayBridgeHandler } from '../../cobuilding/main/overlayHandlers';
import { getRegisteredSession } from '../../cobuilding/main/sessionRegistry';
import type { ChatStreamMessage } from '../../cobuilding/shared/types';

const v4FocusedClients = new Set<WebSocket>();

// Per-client session subscriptions for chat event forwarding
const clientSubscriptions = new Map<WebSocket, Map<string, () => void>>();

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Register WebSocket routes on a Fastify instance.
 */
export async function registerWebSocketRoutes(
  fastify: FastifyInstance,
  tokenManager: TokenManager,
  notificationManager?: any,
  currentUserId?: () => number | null,
  fullStoryStaticConfig?: FullStoryStaticConfig
): Promise<void> {
  // Debounced broadcast: coalesce rapid events into a single push
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleBroadcast() {
    if (broadcastTimer) return; // already scheduled
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastToAll(notificationManager, currentUserId, fullStoryStaticConfig);
    }, 200);
  }

  // Listen for poll-relevant state changes
  const onBusChange = (_reason: WordPollChangeReason) => {
    scheduleBroadcast();
  };
  wordPollEventBus.on('change', onBusChange);

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    for (const ws of v4FocusedClients) {
      sendToClient(ws, { type: 'heartbeat' });
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup hook: when the server closes, remove event listener and clear timer
  fastify.addHook('onClose', async () => {
    wordPollEventBus.off('change', onBusChange);
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    clearInterval(heartbeatInterval);
    // Close all connected clients
    for (const ws of v4FocusedClients) {
      cleanupClient(ws);
      ws.close(1001, 'Server shutting down');
    }
    v4FocusedClients.clear();
  });

  // V4 WebSocket route (focused window — no wid in URL)
  fastify.get<{
    Querystring: { token?: string };
  }>(
    '/ws/word/v4/focused',
    { websocket: true },
    (socket: WebSocket, request) => {
      const token = (request.query as any).token as string | undefined;
      if (!token || !tokenManager.isValidToken(token)) {
        logger.warn('[WS-V4] Unauthorized connection attempt');
        socket.close(4401, 'Unauthorized');
        return;
      }

      v4FocusedClients.add(socket);
      clientSubscriptions.set(socket, new Map());
      logger.debug(`[WS-V4] Focused client connected (total: ${v4FocusedClients.size})`);

      // Send initial poll response for the currently focused window
      sendPollToV4Client(socket, notificationManager, currentUserId, fullStoryStaticConfig);

      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          handleClientMessage(socket, msg, notificationManager, currentUserId, fullStoryStaticConfig);
        } catch {
          // Ignore malformed messages
        }
      });

      socket.on('close', () => {
        cleanupClient(socket);
        v4FocusedClients.delete(socket);
        logger.debug(`[WS-V4] Focused client disconnected (total: ${v4FocusedClients.size})`);
      });

      socket.on('error', (err) => {
        logger.error('[WS-V4] Socket error:', err);
        cleanupClient(socket);
        v4FocusedClients.delete(socket);
      });
    }
  );
}

/**
 * Handle an incoming client message (multiplexed protocol).
 */
function handleClientMessage(
  ws: WebSocket,
  msg: any,
  notificationManager?: any,
  currentUserId?: () => number | null,
  fullStoryStaticConfig?: FullStoryStaticConfig
): void {
  switch (msg.type) {
    case 'refresh':
      sendPollToV4Client(ws, notificationManager, currentUserId, fullStoryStaticConfig);
      break;

    case 'chat:send':
      handleChatSend(ws, msg);
      break;

    case 'chat:subscribe':
      handleChatSubscribe(ws, msg.sessionId);
      break;

    case 'chat:unsubscribe':
      handleChatUnsubscribe(ws, msg.sessionId);
      break;

    case 'bridge':
      handleBridge(ws, msg);
      break;
  }
}

/**
 * Handle chat:send — delegate to the overlay chat-send handler.
 */
function handleChatSend(ws: WebSocket, msg: any): void {
  const handler = getOverlayChatSendHandler();
  if (!handler) {
    sendToClient(ws, { type: 'chat:error', sessionId: msg.sessionId, error: 'Chat handler not ready' });
    return;
  }

  const { sessionId, text, documentPath, selectedText } = msg;
  if (!sessionId || !text) {
    sendToClient(ws, { type: 'chat:error', sessionId: sessionId ?? '', error: 'sessionId and text are required' });
    return;
  }

  // Subscribe to the session so we receive events
  handleChatSubscribe(ws, sessionId);

  handler({
    sessionId,
    text,
    documentPath,
    selectedText,
    onEvent: (chatMsg: ChatStreamMessage) => {
      sendToClient(ws, { type: 'chat:event', sessionId, data: chatMsg });
    },
    onDone: () => {
      sendToClient(ws, { type: 'chat:done', sessionId });
    },
    onError: (err: string) => {
      sendToClient(ws, { type: 'chat:error', sessionId, error: err });
    },
  });
}

/**
 * Subscribe to streaming events for a session.
 */
function handleChatSubscribe(ws: WebSocket, sessionId: string): void {
  if (!sessionId) return;
  const subs = clientSubscriptions.get(ws);
  if (!subs) return;
  if (subs.has(sessionId)) return; // already subscribed

  const session = getRegisteredSession(sessionId);
  if (!session) {
    // Session doesn't exist yet — store a placeholder so chat:send can create it
    subs.set(sessionId, () => {});
    return;
  }

  const unsubscribe = session.addListener({
    onEvent: (msg: ChatStreamMessage) => {
      sendToClient(ws, { type: 'chat:event', sessionId, data: msg });
    },
    onDone: () => {
      sendToClient(ws, { type: 'chat:done', sessionId });
    },
    onError: (err: string) => {
      sendToClient(ws, { type: 'chat:error', sessionId, error: err });
    },
  });

  subs.set(sessionId, unsubscribe);
}

/**
 * Unsubscribe from a session's events.
 */
function handleChatUnsubscribe(ws: WebSocket, sessionId: string): void {
  if (!sessionId) return;
  const subs = clientSubscriptions.get(ws);
  if (!subs) return;
  const unsub = subs.get(sessionId);
  if (unsub) {
    unsub();
    subs.delete(sessionId);
  }
}

/**
 * Handle bridge command — delegate to the overlay bridge handler.
 */
async function handleBridge(ws: WebSocket, msg: any): Promise<void> {
  const handler = getOverlayBridgeHandler();
  if (!handler) {
    if (msg.requestId) {
      sendToClient(ws, { type: 'bridge:ack', requestId: msg.requestId, data: { error: 'Bridge handler not ready' } });
    }
    return;
  }

  const wid = windowMonitorService.getFocusedWindowId() ?? windowMonitorService.getDockedWindowId();

  try {
    const result = await handler({
      action: msg.action,
      payload: msg.payload ?? {},
      wid,
    });
    if (msg.requestId) {
      sendToClient(ws, { type: 'bridge:ack', requestId: msg.requestId, data: result });
    }
  } catch (err: any) {
    if (msg.requestId) {
      sendToClient(ws, { type: 'bridge:ack', requestId: msg.requestId, data: { error: err.message } });
    }
  }
}

/**
 * Cleanup all subscriptions for a disconnected client.
 */
function cleanupClient(ws: WebSocket): void {
  const subs = clientSubscriptions.get(ws);
  if (subs) {
    for (const unsub of subs.values()) {
      unsub();
    }
    subs.clear();
    clientSubscriptions.delete(ws);
  }
}

/**
 * Send a JSON message to a WebSocket client.
 */
function sendToClient(ws: WebSocket, msg: unknown): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Dead connection — will be cleaned up on close
  }
}

/**
 * Send a V4 poll response (focused window) to a single client.
 */
function sendPollToV4Client(
  ws: WebSocket,
  notificationManager?: any,
  currentUserId?: () => number | null,
  fullStoryStaticConfig?: FullStoryStaticConfig
): void {
  if (ws.readyState !== 1) return;
  const focusedWid = windowMonitorService.getFocusedWindowId();
  if (!focusedWid) return;
  try {
    const response = buildWordPollResponseV2(focusedWid, notificationManager, currentUserId);
    let data: any = { ...response, wid: focusedWid };
    if (fullStoryStaticConfig) {
      const cached = getCachedUserData();
      data.fullStoryConfig = {
        ...fullStoryStaticConfig,
        userId: cached?.id ?? (currentUserId ? currentUserId() : null),
        email: cached?.email ?? '',
        displayName: cached?.first_name || cached?.name || '',
      };
    }
    ws.send(JSON.stringify({ type: 'poll', data }));
  } catch (err) {
    logger.error('[WS-V4] Error building focused poll response:', err);
  }
}

/**
 * Broadcast updated poll responses to all connected V4 clients.
 */
function broadcastToAll(
  notificationManager?: any,
  currentUserId?: () => number | null,
  fullStoryStaticConfig?: FullStoryStaticConfig
): void {
  for (const ws of v4FocusedClients) {
    sendPollToV4Client(ws, notificationManager, currentUserId, fullStoryStaticConfig);
  }
}
