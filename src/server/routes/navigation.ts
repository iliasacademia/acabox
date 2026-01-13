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
   * Navigate to a page in the main window or open an external URL
   *
   * Body:
   * {
   *   page: 'conversation' | 'conversations' | 'external',
   *   projectId?: number,  // Required for conversation/conversations
   *   conversationId?: number,
   *   openDiffModal?: boolean,
   *   url?: string  // Required for external
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
          required: ['page'],
          properties: {
            page: {
              type: 'string',
              enum: ['conversation', 'conversations', 'external'],
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
            url: {
              type: 'string',
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: NavigateRequestBody }>,
      reply: FastifyReply
    ) => {
      const { page, projectId, conversationId, openDiffModal, url } = request.body;

      // Validate projectId is provided for conversation/conversations pages
      if ((page === 'conversation' || page === 'conversations') && projectId === undefined) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'projectId is required when page is "conversation" or "conversations"',
          statusCode: 400,
        });
        return;
      }

      // Validate conversationId is provided when navigating to conversation page
      if (page === 'conversation' && conversationId === undefined) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'conversationId is required when page is "conversation"',
          statusCode: 400,
        });
        return;
      }

      // Validate url is provided when navigating to external page
      if (page === 'external' && !url) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'url is required when page is "external"',
          statusCode: 400,
        });
        return;
      }

      logger.info('[Navigation API] POST /api/navigate request', {
        page,
        projectId,
        conversationId,
        openDiffModal,
        url: page === 'external' ? url : undefined,
      });

      try {
        await navigationHandler({
          page,
          projectId,
          conversationId,
          openDiffModal,
          url,
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
