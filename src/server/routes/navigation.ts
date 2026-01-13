/**
 * Navigation routes for the HTTP server
 *
 * Provides REST API endpoint for triggering navigation in the main window:
 * - POST /api/navigate - Navigate to a specific page in the main window
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { NavigateRequestBody } from '../types';
import { defaultLogger as logger } from '../../utils/logger';
import { NavigateToPagePayload } from '../../shared/types';

/**
 * Navigation handler callback type
 * Called to perform navigation in the main window
 */
export type NavigationHandler = (payload: NavigateToPagePayload) => Promise<void>;

/**
 * Register navigation routes on a Fastify instance
 *
 * @param fastify Fastify instance
 * @param navigationHandler Function to handle navigation requests
 */
export async function registerNavigationRoutes(
  fastify: FastifyInstance,
  navigationHandler: NavigationHandler
): Promise<void> {
  /**
   * POST /api/navigate
   *
   * Navigate to a page in the main window
   *
   * Body:
   * {
   *   page: 'conversation' | 'conversations',
   *   projectId: number,
   *   conversationId?: number,
   *   openDiffModal?: boolean
   * }
   *
   * Returns:
   * { success: boolean }
   */
  fastify.post<{
    Body: NavigateRequestBody;
  }>(
    '/api/navigate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['page', 'projectId'],
          properties: {
            page: {
              type: 'string',
              enum: ['conversation', 'conversations'],
            },
            projectId: {
              type: 'number',
            },
            conversationId: {
              type: 'number',
            },
            openDiffModal: {
              type: 'boolean',
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: NavigateRequestBody }>,
      reply: FastifyReply
    ) => {
      const { page, projectId, conversationId, openDiffModal } = request.body;

      // Validate conversationId is provided when navigating to conversation page
      if (page === 'conversation' && conversationId === undefined) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'conversationId is required when page is "conversation"',
          statusCode: 400,
        });
        return;
      }

      logger.info('[Navigation API] POST /api/navigate request', {
        page,
        projectId,
        conversationId,
        openDiffModal,
      });

      try {
        await navigationHandler({
          page,
          projectId,
          conversationId,
          openDiffModal,
        });

        reply.send({ success: true });
      } catch (error) {
        logger.error('[Navigation API] Error navigating:', error);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'Failed to navigate to page',
          statusCode: 500,
        });
      }
    }
  );
}
