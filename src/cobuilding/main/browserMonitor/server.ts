import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import log from 'electron-log';
import type { SessionAccumulator } from './sessionAccumulator';
import { registerReactionRoutes } from './routes';
import { REACTIONS_CONFIG } from './config';

let fastify: FastifyInstance | null = null;

export async function startServer(accumulator: SessionAccumulator): Promise<number> {
  if (fastify) {
    throw new Error('Reactions server already running');
  }

  fastify = Fastify({ logger: false, disableRequestLogging: true });

  await fastify.register(cors, { origin: '*' });
  await registerReactionRoutes(fastify, accumulator);

  const port = REACTIONS_CONFIG.server_port;
  await fastify.listen({ port, host: '127.0.0.1' });

  log.info(`[Reactions] Server listening on http://127.0.0.1:${port}`);
  return port;
}

export async function stopServer(): Promise<void> {
  if (!fastify) return;

  log.info('[Reactions] Stopping server...');
  try {
    await Promise.race([
      fastify.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Server close timeout')), 5000),
      ),
    ]);
  } catch (err) {
    log.error('[Reactions] Error stopping server:', err);
    if (fastify?.server) {
      fastify.server.close();
      fastify.server.unref();
    }
  }
  fastify = null;
  log.info('[Reactions] Server stopped');
}
