/**
 * Bridge routes for the HTTP server
 *
 * Provides REST API endpoint for popup V2 bridge actions:
 * - POST /bridge - Receive bridge action from popup (replaces native WKWebView MessageBridge)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { defaultLogger as logger } from '../../utils/logger';

/**
 * Bridge request payload from popup
 */
interface BridgeRequestPayload {
  action: string;
  payload: Record<string, unknown>;
  pid: number;
}

/**
 * Register bridge routes on a Fastify instance
 *
 * @param fastify Fastify instance
 */
export async function registerBridgeRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /bridge
   *
   * Receive a bridge action from a popup (V2).
   * For now, logs the action and returns success.
   * Handler dispatch to native code will be wired up later.
   *
   * Body:
   * {
   *   action: string,
   *   payload: object,
   *   pid: number
   * }
   *
   * Returns:
   * { success: true }
   *
   * Errors:
   * - 400: Invalid request body
   */
  fastify.post<{
    Body: BridgeRequestPayload;
  }>(
    '/bridge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'payload', 'pid'],
          properties: {
            action: { type: 'string' },
            payload: { type: 'object' },
            pid: { type: 'number' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: BridgeRequestPayload }>,
      reply: FastifyReply
    ) => {
      const { action, payload, pid } = request.body;

      if (isNaN(pid)) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'pid must be a valid number',
          statusCode: 400,
        });
        return;
      }

      logger.info(`[Bridge API] Received action: ${action}, pid: ${pid}, payload: ${JSON.stringify(payload)}`);

      reply.send({ success: true });
    }
  );

  logger.debug('[Bridge API] Registered bridge routes at /bridge');
}
