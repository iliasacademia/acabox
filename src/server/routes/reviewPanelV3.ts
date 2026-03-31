/**
 * Review Panel V3 routes
 *
 * GET /api/review-panel-v3/:wid/context - Get selected text and project context for the panel
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { windowMonitorService } from '../../windowMonitorService';
import { wordIntegrationDataStoreV2 } from '../../wordIntegrationDataStoreV2';
import { defaultLogger as logger } from '../../utils/logger';

export async function registerReviewPanelV3Routes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Params: { wid: string };
  }>(
    '/api/review-panel-v3/:wid/context',
    async (
      request: FastifyRequest<{ Params: { wid: string } }>,
      reply: FastifyReply
    ) => {
      const { wid } = request.params;
      logger.info(`[ReviewPanelV3] GET /context wid=${wid}`);

      const selectedText = windowMonitorService.getReviewPanelV3SelectedText(wid);
      logger.info(`[ReviewPanelV3] selectedText=${selectedText ? `"${selectedText.substring(0, 80)}..."` : 'null'}`);

      // Try to resolve projectId from document path
      let projectId: number | null = null;
      const docPath = windowMonitorService.getDocumentPathForWindow(wid);
      logger.info(`[ReviewPanelV3] docPath=${docPath ?? 'null'}`);
      if (docPath) {
        const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(docPath);
        logger.info(`[ReviewPanelV3] projectFile=${projectFile ? JSON.stringify({ project_id: projectFile.project_id }) : 'null'}`);
        if (projectFile) {
          projectId = projectFile.project_id;
        }
      }

      logger.info(`[ReviewPanelV3] responding with selectedText=${!!selectedText}, projectId=${projectId}`);
      reply.send({ selectedText, projectId });
    }
  );

  /**
   * GET /api/review-panel-v3/focused/context
   *
   * V4: Get context for the currently focused window.
   */
  fastify.get(
    '/api/review-panel-v3/focused/context',
    async (
      request: FastifyRequest,
      reply: FastifyReply
    ) => {
      const wid = windowMonitorService.getFocusedWindowId();
      if (!wid) {
        reply.code(404).send({ error: 'NotFound', message: 'No focused window' });
        return;
      }
      logger.info(`[ReviewPanelV3] GET /focused/context resolved wid=${wid}`);

      const selectedText = windowMonitorService.getReviewPanelV3SelectedText(wid);
      let projectId: number | null = null;
      const docPath = windowMonitorService.getDocumentPathForWindow(wid);
      if (docPath) {
        const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(docPath);
        if (projectFile) {
          projectId = projectFile.project_id;
        }
      }

      reply.send({ selectedText, projectId, wid });
    }
  );
}
