import type { FastifyInstance } from 'fastify';
import type { SessionAccumulator } from './sessionAccumulator';
import type { SnapshotPayload } from './types';
import { getBrowserSessionsByTimeRange } from './repository';
import { getFileSessionsByTimeRange } from '../fileMonitor/repository';

interface ActivityQuery {
  since: string;
  until?: string;
  search?: string;
  source?: 'browser' | 'file' | 'all';
  include_content?: boolean;
}

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

  fastify.get<{ Querystring: ActivityQuery }>('/activity', {
    schema: {
      querystring: {
        type: 'object',
        required: ['since'],
        properties: {
          since: { type: 'string' },
          until: { type: 'string' },
          search: { type: 'string' },
          source: { type: 'string', enum: ['browser', 'file', 'all'] },
          include_content: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { since, search, source = 'all', include_content = false } = request.query;
    const until = request.query.until || new Date().toISOString();

    const result: Record<string, unknown> = {
      query: { since, until },
    };

    if (source === 'all' || source === 'browser') {
      result.browser_sessions = getBrowserSessionsByTimeRange(since, until, search, include_content);
    }

    if (source === 'all' || source === 'file') {
      result.file_sessions = getFileSessionsByTimeRange(since, until, search);
    }

    return reply.send(result);
  });
}
