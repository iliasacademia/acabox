/**
 * Selected text review routes for the HTTP server
 *
 * Orchestrates the full flow for reviewing selected text in Word:
 * - POST /api/selected-text-review/:wid - Trigger a selected text review
 * - GET /api/selected-text-review/:wid/cache - Get cached review context
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { promises as fs } from 'fs';
import axios, { AxiosError } from 'axios';
import { APIclient, getCsrfToken } from '../../apiClient';
import { windowMonitorService } from '../../windowMonitorService';
import { wordIntegrationDataStoreV2 } from '../../wordIntegrationDataStoreV2';
import { defaultLogger as logger } from '../../utils/logger';
import { wordPollEventBus } from '../events/wordPollEventBus';
import { notificationManager } from '../../notificationManager';

interface ReviewCache {
  selectedText: string;
  fullDocumentText: string;
  projectId: number;
  projectFileId: number;
  agentRunId: number;
  timestamp: number;
}

const reviewCache = new Map<string, ReviewCache>();

/**
 * Register selected text review routes on a Fastify instance
 */
export async function registerSelectedTextReviewRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/selected-text-review/:wid
   *
   * Orchestrates the full selected text review flow:
   * 1. Resolve window -> document path -> project file
   * 2. Read selected text and document text from temp files
   * 3. Get presigned S3 URLs from backend
   * 4. Upload text to S3
   * 5. Trigger review on backend
   * 6. Cache text and return result
   */
  fastify.post<{
    Params: { wid: string };
  }>(
    '/api/selected-text-review/:wid',
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

        // Step 2: Read text from temp files
        const selectedTextInfo = windowMonitorService.getSelectedTextForWindow(wid);
        if (!selectedTextInfo) {
          reply.code(400).send({
            error: 'BadRequest',
            message: 'No text selected',
            statusCode: 400,
          });
          return;
        }

        const documentTextInfo = windowMonitorService.getDocumentTextForWindow(wid);
        if (!documentTextInfo) {
          reply.code(400).send({
            error: 'BadRequest',
            message: 'No document text available',
            statusCode: 400,
          });
          return;
        }

        let selectedText: string;
        let fullDocumentText: string;
        try {
          [selectedText, fullDocumentText] = await Promise.all([
            fs.readFile(selectedTextInfo.filePath, 'utf-8'),
            fs.readFile(documentTextInfo.filePath, 'utf-8'),
          ]);
        } catch (err) {
          logger.error('[SelectedTextReview] Failed to read temp files:', err);
          reply.code(500).send({
            error: 'InternalServerError',
            message: 'Cannot read temp file',
            statusCode: 500,
          });
          return;
        }

        // Set reviewing state early so UI updates immediately (before network calls)
        windowMonitorService.setSelectedTextReviewState(wid, project_id, project_file_id);
        wordPollEventBus.emit('change', 'reviewing-state-changed');

        // Step 3: Get presigned S3 URLs
        const client = await APIclient();
        const csrfToken = await getCsrfToken();
        const presignedUrlPath = `v0/co_scientist/projects/${project_id}/files/${project_file_id}/request_temp_file_presigned_s3_url`;

        let selectedTextPresigned: any;
        let fullDocumentPresigned: any;
        try {
          [selectedTextPresigned, fullDocumentPresigned] = await Promise.all([
            client.post(presignedUrlPath, { filename: 'selected_text' }, {
              headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
            }),
            client.post(presignedUrlPath, { filename: 'full_document' }, {
              headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
            }),
          ]);
        } catch (err) {
          const axiosErr = err as AxiosError;
          logger.error('[SelectedTextReview] Failed to get presigned URLs:', axiosErr.message);
          windowMonitorService.clearSelectedTextReviewState(wid);
          wordPollEventBus.emit('change', 'reviewing-state-changed');
          reply.code(502).send({
            error: 'BadGateway',
            message: 'Failed to get presigned S3 URLs from backend',
            statusCode: 502,
          });
          return;
        }

        const selectedTextUrl = selectedTextPresigned.data.presigned_url;
        const selectedTextS3Path = selectedTextPresigned.data.s3_key;
        const fullDocumentUrl = fullDocumentPresigned.data.presigned_url;
        const fullDocumentS3Path = fullDocumentPresigned.data.s3_key;

        // Step 4: Upload to S3 (plain axios, no cookie jar)
        try {
          await Promise.all([
            axios.put(selectedTextUrl, selectedText, {
              headers: { 'Content-Type': 'text/plain' },
            }),
            axios.put(fullDocumentUrl, fullDocumentText, {
              headers: { 'Content-Type': 'text/plain' },
            }),
          ]);
        } catch (err) {
          const axiosErr = err as AxiosError;
          logger.error('[SelectedTextReview] S3 upload failed:', axiosErr.message);
          windowMonitorService.clearSelectedTextReviewState(wid);
          wordPollEventBus.emit('change', 'reviewing-state-changed');
          reply.code(502).send({
            error: 'BadGateway',
            message: 'Failed to upload to S3',
            statusCode: 502,
          });
          return;
        }

        // Step 5: Trigger review
        let triggerResponse: any;
        try {
          triggerResponse = await client.post(
            `v0/co_scientist/projects/${project_id}/files/${project_file_id}/trigger_selected_text_review`,
            {
              selected_text_s3_path: selectedTextS3Path,
              full_document_s3_path: fullDocumentS3Path,
            },
            {
              headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
            }
          );
        } catch (err) {
          const axiosErr = err as AxiosError;
          logger.error('[SelectedTextReview] Trigger review failed:', axiosErr.message);
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

        // Step 6: Cache text
        reviewCache.set(wid, {
          selectedText,
          fullDocumentText,
          projectId: project_id,
          projectFileId: project_file_id,
          agentRunId,
          timestamp: Date.now(),
        });

        logger.info(`[SelectedTextReview] Review triggered for window ${wid}, agentRunId: ${agentRunId}`);

        // Step 7: Return result
        reply.send({
          success: true,
          agentRunId,
          status,
          projectId: project_id,
          projectFileId: project_file_id,
        });
      } catch (err) {
        logger.error('[SelectedTextReview] Unexpected error:', err);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'An unexpected error occurred',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * GET /api/selected-text-review/:wid/cache
   *
   * Returns cached review context for a window.
   */
  fastify.get<{
    Params: { wid: string };
  }>(
    '/api/selected-text-review/:wid/cache',
    async (
      request: FastifyRequest<{ Params: { wid: string } }>,
      reply: FastifyReply
    ) => {
      const { wid } = request.params;
      const cached = reviewCache.get(wid);

      if (!cached) {
        reply.code(404).send({
          error: 'NotFound',
          message: 'No cached review data for this window',
          statusCode: 404,
        });
        return;
      }

      reply.send(cached);
    }
  );

  // Auto-clear reviewing state when a matching notification arrives
  wordPollEventBus.on('change', (reason) => {
    if (reason !== 'notifications-synced') return;

    const activeReviews = windowMonitorService.getAllSelectedTextReviewStates();
    if (activeReviews.size === 0) return;

    const userId = notificationManager.getCurrentUserId();
    if (!userId) return;

    const allNotifications = notificationManager.getNotificationsByStatus(userId);

    for (const [wid, reviewState] of activeReviews) {
      const matchingNotif = allNotifications.find(
        (n) =>
          n.project_file_id === reviewState.projectFileId &&
          n.data?.conversation_id != null &&
          (typeof n.created_at === 'number' ? n.created_at : new Date(n.created_at as any).getTime()) > reviewState.startedAt
      );

      if (matchingNotif) {
        logger.info(`[SelectedTextReview] Review completed for window ${wid}, notification ${matchingNotif.id}`);

        // 1. Clear in-memory state (no native webview change yet)
        windowMonitorService.clearSelectedTextReviewState(wid);

        // 2. Trigger WebSocket broadcast so clients get isReviewingSelectedText: false
        //    via the existing (undisrupted) connection
        wordPollEventBus.emit('change', 'reviewing-state-changed');

        // 3. After broadcast delivery (~200ms debounce), update native webview
        //    (resize button + show popup) — this may cause webview reload
        setTimeout(() => {
          windowMonitorService.openPopupForWindow(wid);
        }, 300);
      }
    }
  });

  logger.debug('[SelectedTextReview] Registered routes at /api/selected-text-review/:wid');
}
