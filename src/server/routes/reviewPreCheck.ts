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
import { store } from '../../appStore';
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

      // Auto-save if "always save before review" is enabled
      if (!result.canProceed && result.reason === 'unsaved_changes' && store.get('alwaysSaveBeforeReview', false)) {
        logger.info('[ReviewPreCheck] Auto-saving before review (alwaysSaveBeforeReview is enabled)');
        const saveResult = await wordSave(windowId);
        if (saveResult.success) {
          reply.send({ canProceed: true });
          return;
        }
        // If auto-save failed, fall through to show the prompt
      }

      reply.send(result);
    }
  );

  fastify.post(
    '/api/word-save',
    async (request: FastifyRequest<{ Querystring: { alwaysSave?: string } }>, reply: FastifyReply) => {
      const windowId = getFocusedWindowNumericId();
      if (windowId === null) {
        reply.code(404).send({
          success: false,
          error: 'No focused window',
        });
        return;
      }

      // Persist "always save" preference if requested
      if (request.query.alwaysSave === 'true') {
        store.set('alwaysSaveBeforeReview', true);
        logger.info('[ReviewPreCheck] Setting alwaysSaveBeforeReview to true');
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
