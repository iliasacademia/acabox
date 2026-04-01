/**
 * Pre-review check and save routes
 *
 * V4 endpoints (no :wid param — server resolves focused window):
 * - POST /api/review-pre-check — Check duplicate names and unsaved changes
 * - POST /api/word-save — Save the focused document by name (no focus stealing)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { defaultLogger as logger } from '../../utils/logger';
import { windowMonitorService } from '../../windowMonitorService';
import { reviewPreCheck, wordSave } from '../wordActions';

function getFocusedWindowNumericId(): number | null {
  const wid = windowMonitorService.getFocusedWindowId();
  if (!wid) return null;
  const num = parseInt(wid, 10);
  return isNaN(num) ? null : num;
}

export async function registerReviewPreCheckRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/review-pre-check',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const windowId = getFocusedWindowNumericId();
      if (windowId === null) {
        reply.code(404).send({
          error: 'NotFound',
          message: 'No focused window',
          statusCode: 404,
        });
        return;
      }

      const result = await reviewPreCheck(windowId);
      reply.send(result);
    }
  );

  fastify.post(
    '/api/word-save',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const windowId = getFocusedWindowNumericId();
      if (windowId === null) {
        reply.code(404).send({
          success: false,
          error: 'No focused window',
        });
        return;
      }

      const result = await wordSave(windowId);
      if (!result.success) {
        reply.code(500).send(result);
        return;
      }
      reply.send(result);
    }
  );

  logger.debug('[ReviewPreCheck] Registered routes at /api/review-pre-check and /api/word-save');
}
