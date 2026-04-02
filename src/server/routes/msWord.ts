import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { defaultLogger as logger } from '../../utils/logger';
import { insertParagraphInWord, InsertMethod } from '../wordActions';

interface InsertParagraphBody {
  action: 'insert_paragraph';
  content: string;
  method?: InsertMethod;
}

export async function registerMsWordRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: InsertParagraphBody }>(
    '/api/ms-word/insert-paragraph',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'content'],
          properties: {
            action: { type: 'string', enum: ['insert_paragraph'] },
            content: { type: 'string' },
            method: { type: 'string', enum: ['applescript', 'keyboard'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { content, method } = request.body;
      logger.info('[MsWord API] POST /api/ms-word/insert-paragraph', { method: method || 'applescript' });

      try {
        const result = await insertParagraphInWord(content, method);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true });
      } catch (error) {
        logger.error('[MsWord API] Error:', error);
        reply.code(500).send({ success: false, error: 'Failed to insert paragraph' });
      }
    }
  );
}
