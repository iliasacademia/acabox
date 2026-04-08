import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import log from 'electron-log';
import WebSocket from 'ws';
import type { SessionAccumulator } from './sessionAccumulator';
import { registerBrowserMonitorRoutes } from './routes';
import { BROWSER_MONITOR_CONFIG } from './config';
import { browserExtensionServer } from '../../../server/browserExtensionServer';

let fastify: FastifyInstance | null = null;
let wss: WebSocket.Server | null = null;

export async function startServer(accumulator: SessionAccumulator): Promise<number> {
  if (fastify) {
    throw new Error('Browser Monitor server already running');
  }

  fastify = Fastify({ logger: false, disableRequestLogging: true });

  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        /^chrome-extension:\/\//.test(origin)
      ) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed'), false);
      }
    },
  });
  await registerBrowserMonitorRoutes(fastify, accumulator);

  const port = BROWSER_MONITOR_CONFIG.server_port;
  await fastify.listen({ port, host: '127.0.0.1' });

  // Attach WebSocket server to the same HTTP server for browser extension communication
  wss = new WebSocket.Server({ server: fastify.server });
  wss.on('connection', (ws) => {
    browserExtensionServer.handleConnection(ws);
  });

  log.info(`[Browser Monitor] Server listening on http://127.0.0.1:${port}`);
  return port;
}

export async function stopServer(): Promise<void> {
  if (!fastify) return;

  browserExtensionServer.stop();
  if (wss) {
    wss.close();
    wss = null;
  }

  log.info('[Browser Monitor] Stopping server...');
  try {
    await Promise.race([
      fastify.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Server close timeout')), 5000),
      ),
    ]);
  } catch (err) {
    log.error('[Browser Monitor] Error stopping server:', err);
    if (fastify?.server) {
      fastify.server.close();
      fastify.server.unref();
    }
  }
  fastify = null;
  log.info('[Browser Monitor] Server stopped');
}
