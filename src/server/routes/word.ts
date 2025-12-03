/**
 * Word integration routes for the HTTP server
 *
 * Provides REST API endpoints for Word process integration:
 * - GET /word/:pid/project_file - Get project file info for a Word PID
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { wordIntegrationDataStore } from '../../wordIntegrationDataStore';
import { WordProjectFileResponse } from '../types';

/**
 * Register Word integration routes on a Fastify instance
 *
 * @param fastify Fastify instance
 */
export async function registerWordRoutes(fastify: FastifyInstance): Promise<void> {
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

      console.log(`[Word API] GET /word/${pid}/project_file`);

      const projectFile = wordIntegrationDataStore.getProjectFileForPID(pid);

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

      console.log(`[Word API] Returning project file for PID ${pid}: project_id=${response.project_id}, project_file_id=${response.project_file_id}`);

      reply.send(response);
    }
  );

  console.log('[Word API] Registered Word routes');
}
