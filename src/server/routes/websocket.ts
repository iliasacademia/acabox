/**
 * WebSocket route handler for real-time Word poll updates.
 *
 * Route: GET /ws/word/v2/:wid (upgraded to WebSocket)
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

interface V2ClientInfo {
  wid: string;
}

const v2Clients = new Map<WebSocket, V2ClientInfo>();

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
    for (const [ws] of v2Clients) {
      ws.close(1001, 'Server shutting down');
    }
    v2Clients.clear();
  });

  // V2 WebSocket route (wid-based)
  fastify.get<{
    Params: { wid: string };
    Querystring: { token?: string };
  }>(
    '/ws/word/v2/:wid',
    { websocket: true },
    (socket: WebSocket, request) => {
      // --- Auth ---
      const token = (request.query as any).token as string | undefined;
      if (!token || !tokenManager.isValidToken(token)) {
        logger.warn('[WS-V2] Unauthorized connection attempt');
        socket.close(4401, 'Unauthorized');
        return;
      }

      const wid = (request.params as any).wid as string;

      // Track client
      v2Clients.set(socket, { wid });
      logger.debug(`[WS-V2] Client connected for wid ${wid} (total: ${v2Clients.size})`);

      // Send initial poll response immediately
      sendPollToV2Client(socket, wid, notificationManager, currentUserId, fullStoryStaticConfig);

      // Handle incoming messages
      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (msg.type === 'refresh') {
            sendPollToV2Client(socket, wid, notificationManager, currentUserId, fullStoryStaticConfig);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Cleanup on disconnect
      socket.on('close', () => {
        v2Clients.delete(socket);
        logger.debug(`[WS-V2] Client disconnected for wid ${wid} (total: ${v2Clients.size})`);
      });

      socket.on('error', (err) => {
        logger.error(`[WS-V2] Socket error for wid ${wid}:`, err);
        v2Clients.delete(socket);
      });
    }
  );
}

/**
 * Send a V2 poll response to a single client.
 */
function sendPollToV2Client(
  ws: WebSocket,
  wid: string,
  notificationManager?: any,
  currentUserId?: () => number | null,
  fullStoryStaticConfig?: FullStoryStaticConfig
): void {
  if (ws.readyState !== 1) return;
  try {
    const response = buildWordPollResponseV2(wid, notificationManager, currentUserId);
    let data: any = response;
    if (fullStoryStaticConfig) {
      const cached = getCachedUserData();
      data = {
        ...response,
        fullStoryConfig: {
          ...fullStoryStaticConfig,
          userId: cached?.userId ?? (currentUserId ? currentUserId() : null),
          email: cached?.email ?? '',
          displayName: cached?.displayName ?? '',
        },
      };
    }
    ws.send(JSON.stringify({ type: 'poll', data }));
  } catch (err) {
    logger.error(`[WS-V2] Error building poll response for wid ${wid}:`, err);
  }
}

/**
 * Broadcast updated poll responses to all connected V2 clients.
 */
function broadcastToAll(
  notificationManager?: any,
  currentUserId?: () => number | null,
  fullStoryStaticConfig?: FullStoryStaticConfig
): void {
  for (const [ws, info] of v2Clients) {
    sendPollToV2Client(ws, info.wid, notificationManager, currentUserId, fullStoryStaticConfig);
  }
}
