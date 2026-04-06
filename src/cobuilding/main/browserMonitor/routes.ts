import type { FastifyInstance } from 'fastify';
import type { SessionAccumulator } from './sessionAccumulator';
import type { SnapshotPayload } from './types';

export async function registerReactionRoutes(
  fastify: FastifyInstance,
  accumulator: SessionAccumulator,
): Promise<void> {
  fastify.post('/snapshot', async (request, reply) => {
    const payload = request.body as SnapshotPayload;
    if (!payload || !payload.url) {
      return reply.code(400).send({ error: 'Missing url' });
    }
    accumulator.ingestSnapshot(payload);
    return reply.send({ ok: true });
  });

  fastify.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: Date.now() });
  });

  fastify.get('/sessions', async (_request, reply) => {
    return reply.send(accumulator.getSessions());
  });
}
