/**
 * Word integration routes for the HTTP server
 *
 * Provides REST API endpoints for Word process integration:
 * - GET /word/:pid/project_file - Get project file info for a Word PID
 * - GET /word/:pid/poll - Poll status and notifications for a Word PID
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { wordIntegrationDataStore } from '../../wordIntegrationDataStore';
import { WordProjectFileResponse } from '../types';
import { defaultLogger as logger } from '../../utils/logger';
import { wordIntegrationService } from '../../wordIntegrationService';
import { buildWordPollResponse } from '../services/buildWordPollResponse';

/**
 * Register Word integration routes on a Fastify instance
 *
 * @param fastify Fastify instance
 * @param notificationManager NotificationManager instance (optional)
 * @param currentUserId Function returning current user ID (optional)
 */
export async function registerWordRoutes(
  fastify: FastifyInstance,
  notificationManager?: any,
  currentUserId?: () => number | null
): Promise<void> {
  /**
   * GET /word/:pid/project_file
   *
   * Get project file information for a Word process by PID
   *
   * Path parameters:
   * - pid: Word process ID (number)
   *
   * Returns:
   * {
   *   project_id: number,
   *   project_file_id: number
   * }
   *
   * Errors:
   * - 400: Invalid PID format
   * - 404: PID not tracked or no project file info
   */
  fastify.get<{
    Params: { pid: string };
  }>(
    '/word/:pid/project_file',
    {
      schema: {
        params: {
          type: 'object',
          required: ['pid'],
          properties: {
            pid: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { pid: string } }>,
      reply: FastifyReply
    ) => {
      const pid = parseInt(request.params.pid, 10);

      if (isNaN(pid)) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'Invalid PID format',
          statusCode: 400,
        });
        return;
      }

      // Check active document path first
      const activePath = wordIntegrationService.getActiveDocumentPath(pid);
      let projectFile = null;

      if (activePath) {
        projectFile = wordIntegrationDataStore.getProjectFileForPath(activePath);
      } else {
        // Fallback to PID mapping (legacy/startup)
        projectFile = wordIntegrationDataStore.getProjectFileForPID(pid);
      }

      if (!projectFile) {
        reply.code(404).send({
          error: 'NotFound',
          message: `No project file found for PID ${pid}`,
          statusCode: 404,
        });
        return;
      }

      const response: WordProjectFileResponse = {
        project_id: projectFile.project_id,
        project_file_id: projectFile.project_file_id,
      };

      reply.send(response);
    }
  );

  /**
   * GET /word/:pid/poll
   *
   * Poll status for a Word PID.
   * Returns visibility status, project info, and notification count.
   */
  fastify.get<{
    Params: { pid: string };
  }>(
    '/word/:pid/poll',
    {
      schema: {
        params: {
          type: 'object',
          required: ['pid'],
          properties: {
            pid: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { pid: string } }>,
      reply: FastifyReply
    ) => {
      const pid = parseInt(request.params.pid, 10);

      if (isNaN(pid)) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'Invalid PID format',
          statusCode: 400,
        });
        return;
      }

      const response = buildWordPollResponse(pid, notificationManager, currentUserId);
      reply.send(response);
    }
  );
}
