/**
 * Review routes for triggering full paper and diff reviews
 *
 * These routes handle:
 * - POST /api/full-paper-review/:wid - Trigger a full paper review
 * - POST /api/diff-review/:wid - Trigger a diff/changes review
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import axios, { AxiosError } from 'axios';
import { APIclient, getCsrfToken } from '../../apiClient';
import { windowMonitorService } from '../../windowMonitorService';
import { wordIntegrationDataStoreV2 } from '../../wordIntegrationDataStoreV2';
import { defaultLogger as logger } from '../../utils/logger';
import { wordPollEventBus } from '../events/wordPollEventBus';

/**
 * Register review routes on a Fastify instance
 */
export async function registerReviewRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/full-paper-review/:wid
   *
   * Triggers a full paper review:
   * 1. Resolve window -> document path -> project file
   * 2. Call backend API to trigger full review
   * 3. Set reviewing state with 'full-paper' type
   * 4. Return result
   */
  fastify.post<{
    Params: { wid: string };
  }>(
    '/api/full-paper-review/:wid',
    async (
      request: FastifyRequest<{ Params: { wid: string } }>,
      reply: FastifyReply
    ) => {
      const { wid } = request.params;

      try {
        // Step 1: Resolve window to project file
        const documentPath = windowMonitorService.getDocumentPathForWindow(wid);
        if (!documentPath) {
          reply.code(404).send({
            error: 'NotFound',
            message: 'Window not found in monitor state',
            statusCode: 404,
          });
          return;
        }

        const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(documentPath);
        if (!projectFile) {
          reply.code(404).send({
            error: 'NotFound',
            message: 'No project file mapped for this document',
            statusCode: 404,
          });
          return;
        }

        const { project_id, project_file_id } = projectFile;

        logger.info(`[FullPaperReview] Triggering full paper review for window ${wid}, project ${project_id}, file ${project_file_id}`);

        // Set reviewing state early so UI updates immediately (before network calls)
        windowMonitorService.setSelectedTextReviewState(wid, project_id, project_file_id, 'full-paper');
        wordPollEventBus.emit('change', 'reviewing-state-changed');

        // Step 2: Trigger review on backend
        let triggerResponse: any;
        try {
          const client = await APIclient();
          const csrfToken = await getCsrfToken();

          triggerResponse = await client.post(
            `v0/co_scientist/projects/${project_id}/files/${project_file_id}/trigger_full_review`,
            {},
            {
              headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
            }
          );
        } catch (err) {
          const axiosErr = err as AxiosError;
          logger.error('[FullPaperReview] Trigger review failed:', axiosErr.message);
          windowMonitorService.clearSelectedTextReviewState(wid);
          wordPollEventBus.emit('change', 'reviewing-state-changed');
          reply.code(502).send({
            error: 'BadGateway',
            message: 'Failed to trigger review on backend',
            statusCode: 502,
          });
          return;
        }

        const agentRunId = triggerResponse.data.agent_run_id;
        const status = triggerResponse.data.status;

        logger.info(`[FullPaperReview] Review triggered for window ${wid}, agentRunId: ${agentRunId}`);

        // Step 3: Return result
        reply.send({
          success: true,
          agentRunId,
          status,
          projectId: project_id,
          projectFileId: project_file_id,
          reviewType: 'full-paper',
        });
      } catch (err) {
        logger.error('[FullPaperReview] Unexpected error:', err);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'An unexpected error occurred',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * POST /api/diff-review/:wid
   *
   * Triggers a diff/changes review:
   * 1. Resolve window -> document path -> project file
   * 2. Call backend API to trigger diff review
   * 3. Set reviewing state with 'review-changes' type
   * 4. Return result
   */
  fastify.post<{
    Params: { wid: string };
  }>(
    '/api/diff-review/:wid',
    async (
      request: FastifyRequest<{ Params: { wid: string } }>,
      reply: FastifyReply
    ) => {
      const { wid } = request.params;

      try {
        // Step 1: Resolve window to project file
        const documentPath = windowMonitorService.getDocumentPathForWindow(wid);
        if (!documentPath) {
          reply.code(404).send({
            error: 'NotFound',
            message: 'Window not found in monitor state',
            statusCode: 404,
          });
          return;
        }

        const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(documentPath);
        if (!projectFile) {
          reply.code(404).send({
            error: 'NotFound',
            message: 'No project file mapped for this document',
            statusCode: 404,
          });
          return;
        }

        const { project_id, project_file_id } = projectFile;

        logger.info(`[DiffReview] Triggering diff review for window ${wid}, project ${project_id}, file ${project_file_id}`);

        // Set reviewing state early so UI updates immediately (before network calls)
        windowMonitorService.setSelectedTextReviewState(wid, project_id, project_file_id, 'review-changes');
        wordPollEventBus.emit('change', 'reviewing-state-changed');

        // Step 2: Trigger review on backend
        let triggerResponse: any;
        try {
          const client = await APIclient();
          const csrfToken = await getCsrfToken();

          triggerResponse = await client.post(
            `v0/co_scientist/projects/${project_id}/files/${project_file_id}/trigger_diff_review`,
            {},
            {
              headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
            }
          );
        } catch (err) {
          const axiosErr = err as AxiosError;
          logger.error('[DiffReview] Trigger review failed:', axiosErr.message);
          windowMonitorService.clearSelectedTextReviewState(wid);
          wordPollEventBus.emit('change', 'reviewing-state-changed');
          reply.code(502).send({
            error: 'BadGateway',
            message: 'Failed to trigger review on backend',
            statusCode: 502,
          });
          return;
        }

        const agentRunId = triggerResponse.data.agent_run_id;
        const status = triggerResponse.data.status;

        logger.info(`[DiffReview] Review triggered for window ${wid}, agentRunId: ${agentRunId}`);

        // Step 3: Return result
        reply.send({
          success: true,
          agentRunId,
          status,
          projectId: project_id,
          projectFileId: project_file_id,
          reviewType: 'review-changes',
        });
      } catch (err) {
        logger.error('[DiffReview] Unexpected error:', err);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'An unexpected error occurred',
          statusCode: 500,
        });
      }
    }
  );

  logger.debug('[ReviewRoutes] Registered routes at /api/full-paper-review/:wid and /api/diff-review/:wid');
}
