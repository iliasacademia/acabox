/**
 * Analytics routes for the HTTP server
 *
 * Provides REST API endpoint for sending analytics events from popup/overlay:
 * - POST /api/analytics - Send analytics event to backend
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { APIclient, getCsrfToken } from '../../apiClient';
import { AxiosError } from 'axios';
import { defaultLogger as logger } from '../../utils/logger';

/**
 * Analytics event payload from popup
 */
interface AnalyticsEventPayload {
  event_name: string;
  action: string;
  source: 'desktop' | 'overlay';
  metadata?: Record<string, unknown>;
  project_id?: number;
}

/**
 * Register analytics routes on a Fastify instance
 *
 * @param fastify Fastify instance
 */
export async function registerAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/analytics
   *
   * Send an analytics event to Academia.edu backend
   *
   * Body:
   * {
   *   event_name: string,
   *   action: string,
   *   source: 'desktop' | 'overlay',
   *   metadata?: object,
   *   project_id?: number
   * }
   *
   * Returns:
   * { success: true }
   *
   * Errors:
   * - 400: Invalid request body
   * - 500: Failed to send event
   */
  fastify.post<{
    Body: AnalyticsEventPayload;
  }>(
    '/api/analytics',
    {
      schema: {
        body: {
          type: 'object',
          required: ['event_name', 'action', 'source'],
          properties: {
            event_name: { type: 'string' },
            action: { type: 'string' },
            source: { type: 'string', enum: ['desktop', 'overlay'] },
            metadata: { type: 'object' },
            project_id: { type: 'number' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: AnalyticsEventPayload }>,
      reply: FastifyReply
    ) => {
      try {
        const { event_name, action, source, metadata = {}, project_id } = request.body;

        logger.debug(`[Analytics API] Sending event: ${event_name}.${action} (source: ${source})`);

        // Build event data
        const eventData: Record<string, unknown> = {
          event_name,
          action,
          source,
          metadata,
        };

        if (project_id !== undefined) {
          eventData.project_id = project_id;
        }

        // Get authenticated API client
        const client = await APIclient();

        // Send to Academia.edu arbitrary events API
        await client.post('v0/arbitrary_event', {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: eventData,
          },
        }, {
          headers: {
            'x-csrf-token': await getCsrfToken(),
            'content-type': 'application/json',
          },
        });

        logger.debug(`[Analytics API] Event sent successfully: ${event_name}.${action}`);

        reply.send({ success: true });
      } catch (error) {
        // Handle errors from Academia.edu API
        if (error && typeof error === 'object' && 'isAxiosError' in error) {
          const axiosError = error as AxiosError;

          if (axiosError.response) {
            const status = axiosError.response.status;
            logger.error(`[Analytics API] Error: ${status} - ${request.body.event_name}`);

            reply.status(status).send({
              error: 'AnalyticsError',
              message: 'Failed to send analytics event',
              statusCode: status,
            });
          } else if (axiosError.request) {
            logger.error('[Analytics API] No response received:', axiosError.message);
            reply.code(503).send({
              error: 'ServiceUnavailable',
              message: 'No response from Academia.edu API',
              statusCode: 503,
            });
          } else {
            logger.error('[Analytics API] Request setup error:', axiosError.message);
            reply.code(500).send({
              error: 'InternalServerError',
              message: 'Failed to setup request',
              statusCode: 500,
            });
          }
        } else {
          logger.error('[Analytics API] Unexpected error:', error);
          reply.code(500).send({
            error: 'InternalServerError',
            message: 'An unexpected error occurred',
            statusCode: 500,
          });
        }
      }
    }
  );

  logger.debug('[Analytics API] Registered analytics routes at /api/analytics');
}
