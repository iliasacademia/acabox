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
import { FEATURES } from '../../shared/types';
import { reviewPreCheck, wordSave } from '../wordActions';
import { projectSyncService } from '../../projectSyncService';

interface ReviewCache {
  selectedText: string;
  fullDocumentText?: string;
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
      const { userPrompt } = (request.body as { userPrompt?: string }) ?? {};
      logger.info(`[SelectedTextReview] Review requested for window ${wid}, userPrompt=${userPrompt ? `"${userPrompt.substring(0, 80)}..."` : 'none'}`);
      logger.info(`[SelectedTextReview] Window ${wid} state snapshot`, {
        documentTextInfo: windowMonitorService.getDocumentTextForWindow(wid),
        hasDocumentTextContent: windowMonitorService.getDocumentTextContent(wid) !== null,
        selectedTextInfo: windowMonitorService.getSelectedTextForWindow(wid),
        hasSelectedTextContent: windowMonitorService.getSelectedTextContent(wid) !== null,
        documentPath: windowMonitorService.getDocumentPathForWindow(wid),
      });

      try {
        // Step 1: Resolve window to project file
        const documentPath = windowMonitorService.getDocumentPathForWindow(wid);
        if (!documentPath) {
          logger.warn(`[SelectedTextReview] Window ${wid} not found in monitor state`);
          reply.code(404).send({
            error: 'NotFound',
            message: 'Window not found in monitor state',
            statusCode: 404,
          });
          return;
        }

        const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(documentPath);
        if (!projectFile) {
          logger.warn(`[SelectedTextReview] No project file mapped for document: ${documentPath}`);
          reply.code(404).send({
            error: 'NotFound',
            message: 'No project file mapped for this document',
            statusCode: 404,
          });
          return;
        }

        const { project_id, project_file_id } = projectFile;

        // Step 2: Read selected text — prefer in-memory cache, fall back to file
        let selectedText: string;
        const cachedSelectedText = windowMonitorService.getSelectedTextContent(wid);

        if (cachedSelectedText) {
          selectedText = cachedSelectedText;
          logger.info(`[SelectedTextReview] Using cached selected text for window ${wid}: ${selectedText.length} bytes`);
        } else {
          const selectedTextInfo = windowMonitorService.getSelectedTextForWindow(wid);
          if (!selectedTextInfo) {
            logger.warn(`[SelectedTextReview] No selected text info for window ${wid}`);
            reply.code(400).send({
              error: 'BadRequest',
              message: 'No text selected',
              statusCode: 400,
            });
            return;
          }
          try {
            selectedText = await fs.readFile(selectedTextInfo.filePath, 'utf-8');
            logger.info(`[SelectedTextReview] Using file selected text for window ${wid}: ${selectedText.length} bytes`);
          } catch (err) {
            logger.error('[SelectedTextReview] Failed to read selected text temp file:', err);
            reply.code(500).send({
              error: 'InternalServerError',
              message: 'Cannot read selected text temp file',
              statusCode: 500,
            });
            return;
          }
        }

        let fullDocumentText: string | undefined;

        if (FEATURES.SELECTION_REVIEW_V2_ENABLED) {
          // V2: Backend reads the document file from S3, so we need to ensure it's saved and synced

          // Step 2.5: Save check + save + sync
          const numericWid = parseInt(wid, 10);
          if (!isNaN(numericWid)) {
            const preCheck = await reviewPreCheck(numericWid);
            if (!preCheck.canProceed) {
              if (preCheck.reason === 'unsaved_changes') {
                logger.info(`[SelectedTextReview] V2: Document has unsaved changes, saving for window ${wid}`);
                const saveResult = await wordSave(numericWid);
                if (!saveResult.success) {
                  logger.error(`[SelectedTextReview] V2: Failed to save document for window ${wid}: ${saveResult.error}`);
                  reply.code(400).send({
                    error: 'BadRequest',
                    message: saveResult.error || 'Failed to save document before review',
                    statusCode: 400,
                  });
                  return;
                }
                // Sync saved file to backend S3
                try {
                  await projectSyncService.syncFileOnce(project_id, documentPath);
                  logger.info(`[SelectedTextReview] V2: File synced to backend for window ${wid}`);
                } catch (syncErr) {
                  logger.error('[SelectedTextReview] V2: Post-save sync error (non-fatal):', syncErr);
                }
              } else if (preCheck.reason === 'permission_denied') {
                logger.warn(`[SelectedTextReview] V2: Permission denied for window ${wid}`);
                reply.code(403).send({
                  error: 'Forbidden',
                  message: preCheck.message || 'Unable to check for unsaved changes. Remember to save before reviewing.',
                  reason: 'permission_denied',
                  statusCode: 403,
                });
                return;
              }
            }
          }

          // V2: Don't append user prompt to selected text — it's sent as user_instruction separately
          logger.info(`[SelectedTextReview] V2: Uploading selectedText=${selectedText.length} bytes (no full document upload)`);
        } else {
          // V1: Read document text — prefer in-memory cache, fall back to file
          const documentTextInfo = windowMonitorService.getDocumentTextForWindow(wid);
          if (!documentTextInfo) {
            logger.warn(`[SelectedTextReview] No document text available for window ${wid}, documentPath: ${documentPath}`);
            reply.code(400).send({
              error: 'BadRequest',
              message: 'No document text available',
              statusCode: 400,
            });
            return;
          }

          const cachedDocContent = windowMonitorService.getDocumentTextContent(wid);
          if (cachedDocContent) {
            fullDocumentText = cachedDocContent;
            logger.info(`[SelectedTextReview] Using cached document text for window ${wid}: ${fullDocumentText.length} bytes`);
          } else {
            try {
              fullDocumentText = await fs.readFile(documentTextInfo.filePath, 'utf-8');
              logger.info(`[SelectedTextReview] Using file document text for window ${wid}: ${fullDocumentText.length} bytes`);
            } catch (err) {
              logger.error('[SelectedTextReview] Failed to read document text temp file:', err);
              reply.code(500).send({
                error: 'InternalServerError',
                message: 'Cannot read document text temp file',
                statusCode: 500,
              });
              return;
            }
          }

          if (fullDocumentText.length <= 1) {
            logger.error(`[SelectedTextReview] Document text is trivially small (${fullDocumentText.length} bytes) for window ${wid}, aborting`);
            reply.code(400).send({
              error: 'BadRequest',
              message: 'Document text is empty or trivially small',
              statusCode: 400,
            });
            return;
          }

          // V1: Append user prompt to selected text
          if (userPrompt) {
            selectedText = selectedText + '\n\nUser Query:\n' + userPrompt;
            logger.info(`[SelectedTextReview] Appended user prompt, new selectedText length=${selectedText.length} bytes`);
          }

          logger.info(`[SelectedTextReview] Uploading: selectedText=${selectedText.length} bytes, fullDocumentText=${fullDocumentText.length} bytes`);
        }

        // Close the review input and set reviewing state so UI transitions to progress mode
        windowMonitorService.closeReviewInput(wid);
        windowMonitorService.clearReviewErrorMessage(wid);
        windowMonitorService.setSelectedTextReviewState(wid, project_id, project_file_id, 'selected-text', selectedText);
        wordPollEventBus.emit('change', 'reviewing-state-changed');

        // Step 3–5: Get presigned URLs, upload to S3, trigger review
        const client = await APIclient();
        const csrfToken = await getCsrfToken();
        const presignedUrlPath = `v0/co_scientist/projects/${project_id}/files/${project_file_id}/request_temp_file_presigned_s3_url`;

        let agentRunId: number;
        let status: string;

        if (FEATURES.SELECTION_REVIEW_V2_ENABLED) {
          // V2: Only upload selected text, backend reads full document from S3

          // Step 3 (V2): Get presigned URL for selected text only
          let selectedTextPresigned: any;
          try {
            selectedTextPresigned = await client.post(presignedUrlPath, { filename: 'selected_text' }, {
              headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
            });
          } catch (err) {
            const axiosErr = err as AxiosError;
            logger.error('[SelectedTextReview] V2: Failed to get presigned URL:', axiosErr.message);
            windowMonitorService.clearSelectedTextReviewState(wid);
            wordPollEventBus.emit('change', 'reviewing-state-changed');
            reply.code(502).send({
              error: 'BadGateway',
              message: 'Failed to get presigned S3 URL from backend',
              statusCode: 502,
            });
            return;
          }

          const selectedTextUrl = selectedTextPresigned.data.presigned_url;
          const selectedTextS3Path = selectedTextPresigned.data.s3_key;
          logger.info(`[SelectedTextReview] V2: Got presigned URL, S3 path: ${selectedTextS3Path}`);

          // Step 4 (V2): Upload selected text only
          try {
            await axios.put(selectedTextUrl, selectedText, {
              headers: { 'Content-Type': 'text/plain' },
            });
          } catch (err) {
            const axiosErr = err as AxiosError;
            logger.error('[SelectedTextReview] V2: S3 upload failed:', axiosErr.message);
            windowMonitorService.clearSelectedTextReviewState(wid);
            wordPollEventBus.emit('change', 'reviewing-state-changed');
            reply.code(502).send({
              error: 'BadGateway',
              message: 'Failed to upload to S3',
              statusCode: 502,
            });
            return;
          }

          logger.info(`[SelectedTextReview] V2: S3 upload complete for window ${wid}`);

          // Step 5 (V2): Trigger review with V2 endpoint
          let triggerResponse: any;
          try {
            const triggerBody: Record<string, string> = {
              selected_text_s3_path: selectedTextS3Path,
            };
            if (userPrompt) {
              triggerBody.user_instruction = userPrompt;
            }
            triggerResponse = await client.post(
              `v0/co_scientist/projects/${project_id}/files/${project_file_id}/trigger_selected_text_review_v2`,
              triggerBody,
              {
                headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
              }
            );
          } catch (err) {
            const axiosErr = err as AxiosError;
            logger.error('[SelectedTextReview] V2: Trigger review failed:', axiosErr.message);
            windowMonitorService.clearSelectedTextReviewState(wid);
            wordPollEventBus.emit('change', 'reviewing-state-changed');
            reply.code(502).send({
              error: 'BadGateway',
              message: 'Failed to trigger review on backend',
              statusCode: 502,
            });
            return;
          }

          agentRunId = triggerResponse.data.agent_run_id;
          status = triggerResponse.data.status;
        } else {
          // V1: Upload both selected text and full document

          // Step 3 (V1): Get presigned S3 URLs
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

          logger.info(`[SelectedTextReview] Got presigned URLs for window ${wid}`);
          logger.info(`[SelectedTextReview] S3 paths: selectedText=${selectedTextS3Path}, fullDocument=${fullDocumentS3Path}`);

          // Step 4 (V1): Upload to S3 (plain axios, no cookie jar)
          try {
            await Promise.all([
              axios.put(selectedTextUrl, selectedText, {
                headers: { 'Content-Type': 'text/plain' },
              }),
              axios.put(fullDocumentUrl, fullDocumentText!, {
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

          logger.info(`[SelectedTextReview] S3 upload complete for window ${wid}`);

          // Step 5 (V1): Trigger review
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

          agentRunId = triggerResponse.data.agent_run_id;
          status = triggerResponse.data.status;
        }

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

        // Fire analytics event (fire-and-forget, don't block the response)
        client.post('v0/arbitrary_event', {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'trigger_selected_text_review',
              action: 'click',
              source: 'overlay',
              metadata: { file_id: project_file_id },
              project_id,
            },
          },
        }, {
          headers: {
            'x-csrf-token': csrfToken,
            'content-type': 'application/json',
          },
        }).catch((err: unknown) => {
          logger.error('[SelectedTextReview] Analytics event failed:', err);
        });

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
