import type { FastifyInstance } from 'fastify';
import type { SessionAccumulator } from './sessionAccumulator';
import type { SnapshotPayload } from './types';
import { queryActivity, type ActivityQueryParams } from '../activityQuery';

export async function registerBrowserMonitorRoutes(
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

  fastify.get<{ Querystring: ActivityQueryParams }>('/activity', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          since: { type: 'string' },
          until: { type: 'string' },
          period: { type: 'string', enum: ['today', 'last_2h', 'last_24h', 'this_week'] },
          search: { type: 'string' },
          source: { type: 'string', enum: ['browser', 'file', 'all'] },
        },
      },
    },
  }, async (request, reply) => {
    const result = queryActivity(request.query);
    if ('error' in result) {
      return reply.code(400).send({ error: result.error });
    }
    return reply.send(result);
  });
}
