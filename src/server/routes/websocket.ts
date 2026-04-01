/**
 * WebSocket route handler for real-time Word poll updates.
 *
 * Route: GET /ws/word/v4/focused (upgraded to WebSocket)
 *
 * Protocol:
 *   Server → Client: { type: "poll", data: WordPollResponse }
 *   Client → Server: { type: "refresh" }
 *
 * Auth: token passed via ?token=TOKEN query param
 * (browsers cannot set custom headers on WebSocket connections)
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

const v4FocusedClients = new Set<WebSocket>();

/**
 * Register WebSocket routes on a Fastify instance.
 *
 * @param fastify             Fastify instance (with @fastify/websocket registered)
 * @param tokenManager        TokenManager for auth validation
 * @param notificationManager NotificationManager instance
 * @param currentUserId       Function returning current user ID
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

  // Cleanup hook: when the server closes, remove event listener and clear timer
  fastify.addHook('onClose', async () => {
    wordPollEventBus.off('change', onBusChange);
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    // Close all connected clients
    for (const ws of v4FocusedClients) {
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
      logger.debug(`[WS-V4] Focused client connected (total: ${v4FocusedClients.size})`);

      // Send initial poll response for the currently focused window
      sendPollToV4Client(socket, notificationManager, currentUserId, fullStoryStaticConfig);

      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (msg.type === 'refresh') {
            sendPollToV4Client(socket, notificationManager, currentUserId, fullStoryStaticConfig);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      socket.on('close', () => {
        v4FocusedClients.delete(socket);
        logger.debug(`[WS-V4] Focused client disconnected (total: ${v4FocusedClients.size})`);
      });

      socket.on('error', (err) => {
        logger.error('[WS-V4] Socket error:', err);
        v4FocusedClients.delete(socket);
      });
    }
  );
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
