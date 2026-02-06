/**
 * WebSocket route handler for real-time Word poll updates.
 *
 * Route: GET /ws/word/:pid (upgraded to WebSocket)
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
import { buildWordPollResponse } from '../services/buildWordPollResponse';
import { TokenManager } from '../middleware/auth';
import { defaultLogger as logger } from '../../utils/logger';

interface ClientInfo {
  pid: number;
}

const clients = new Map<WebSocket, ClientInfo>();

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
  currentUserId?: () => number | null
): Promise<void> {
  // Debounced broadcast: coalesce rapid events into a single push
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleBroadcast() {
    if (broadcastTimer) return; // already scheduled
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastToAll(notificationManager, currentUserId);
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
    for (const [ws] of clients) {
      ws.close(1001, 'Server shutting down');
    }
    clients.clear();
  });

  // WebSocket route
  fastify.get<{
    Params: { pid: string };
    Querystring: { token?: string };
  }>(
    '/ws/word/:pid',
    { websocket: true },
    (socket: WebSocket, request) => {
      // --- Auth ---
      const token = (request.query as any).token as string | undefined;
      if (!token || !tokenManager.isValidToken(token)) {
        logger.warn('[WS] Unauthorized connection attempt');
        socket.close(4401, 'Unauthorized');
        return;
      }

      // --- Parse PID ---
      const pid = parseInt((request.params as any).pid, 10);
      if (isNaN(pid)) {
        socket.close(4400, 'Invalid PID');
        return;
      }

      // Track client
      clients.set(socket, { pid });
      logger.debug(`[WS] Client connected for PID ${pid} (total: ${clients.size})`);

      // Send initial poll response immediately
      sendPollToClient(socket, pid, notificationManager, currentUserId);

      // Handle incoming messages
      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (msg.type === 'refresh') {
            sendPollToClient(socket, pid, notificationManager, currentUserId);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Cleanup on disconnect
      socket.on('close', () => {
        clients.delete(socket);
        logger.debug(`[WS] Client disconnected for PID ${pid} (total: ${clients.size})`);
      });

      socket.on('error', (err) => {
        logger.error(`[WS] Socket error for PID ${pid}:`, err);
        clients.delete(socket);
      });
    }
  );
}

/**
 * Send a poll response to a single client.
 */
function sendPollToClient(
  ws: WebSocket,
  pid: number,
  notificationManager?: any,
  currentUserId?: () => number | null
): void {
  if (ws.readyState !== 1) return; // 1 === WebSocket.OPEN
  try {
    const data = buildWordPollResponse(pid, notificationManager, currentUserId);
    ws.send(JSON.stringify({ type: 'poll', data }));
  } catch (err) {
    logger.error(`[WS] Error building poll response for PID ${pid}:`, err);
  }
}

/**
 * Broadcast updated poll responses to all connected clients.
 */
function broadcastToAll(
  notificationManager?: any,
  currentUserId?: () => number | null
): void {
  for (const [ws, info] of clients) {
    sendPollToClient(ws, info.pid, notificationManager, currentUserId);
  }
}
