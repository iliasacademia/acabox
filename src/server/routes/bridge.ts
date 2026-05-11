/**
 * Bridge routes for the HTTP server
 *
 * Provides REST API endpoint for popup V2 bridge actions:
 * - POST /bridge - Receive bridge action from popup (replaces native WKWebView MessageBridge)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { defaultLogger as logger } from '../../utils/logger';
import { windowMonitorService } from '../../windowMonitorService';
import { enableFeedback } from '../services/enableFeedbackService';
import { NavigationHandler } from './navigation';

/**
 * Bridge request payload from popup
 */
interface BridgeRequestPayload {
  action: string;
  payload: Record<string, unknown>;
  pid: number;
  wid?: string;
}

/**
 * Register bridge routes on a Fastify instance
 *
 * @param fastify Fastify instance
 */
export async function registerBridgeRoutes(
  fastify: FastifyInstance,
  navigationHandler?: NavigationHandler | null,
): Promise<void> {
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
            wid: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: BridgeRequestPayload }>,
      reply: FastifyReply
    ) => {
      const { action, payload, pid, wid: clientWid } = request.body;
      // The client's wid may be stale due to async WebSocket timing.
      // Use the server's known focused window instead.
      // When the overlay is docked outside Word, clicking inside it causes Word to lose
      // focus, so getFocusedWindowId() returns null. Fall back to the docked window so
      // all bridge actions work regardless of focus state.
      const wid = windowMonitorService.getFocusedWindowId() ?? clientWid ?? windowMonitorService.getDockedWindowId();

      if (isNaN(pid)) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'pid must be a valid number',
          statusCode: 400,
        });
        return;
      }

      logger.info(`[Bridge API] Received action: ${action}, pid: ${pid}, wid: ${wid}, payload: ${JSON.stringify(payload)}`);

      // When the overlay is clicked and the host app isn't focused,
      // bring the host app to front so overlay + host move together.
      if (wid && !windowMonitorService.getFocusedWindowId()) {
        windowMonitorService.activateHostAppForWindow(wid);
      }

      if (action === 'buttonClicked' && wid) {
        windowMonitorService.togglePopupForWindow(wid);
      } else if (action === 'closeWindow' && wid) {
        const clearReviewState = payload.clearReviewState !== false; // Default to true
        windowMonitorService.closePopupForWindow(wid, clearReviewState);
      } else if (action === 'resizeWindow' && wid) {
        const height = payload.height;
        if (typeof height === 'number' && height > 0) {
          windowMonitorService.setPopupHeight(wid, height);
        }
      } else if (action === 'setDragOffset' && wid) {
        const { dx, dy } = payload;
        if (typeof dx === 'number' && typeof dy === 'number') {
          windowMonitorService.setButtonDragOffset(wid, dx, dy);
        }
      } else if (action === 'setPopupSize' && wid) {
        const { width, height } = payload;
        if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
          windowMonitorService.setPopupSize(wid, width, height);
        }
      } else if (action === 'clearPopupSize' && wid) {
        windowMonitorService.clearPopupSize(wid);
      } else if (action === 'openPopup' && wid) {
        logger.info(`[Bridge API] Dispatching openPopup for wid: ${wid}`);
        windowMonitorService.openPopupForWindow(wid);
      } else if (action === 'setReviewState' && wid) {
        const { projectId, reviewType, selectedText } = payload;
        if (projectId && reviewType) {
          // Get project file ID from the backend data (we need this for the review state)
          // For now, we'll use a placeholder - the overlay doesn't strictly need it
          windowMonitorService.setSelectedTextReviewState(
            wid,
            projectId as number,
            0, // projectFileId placeholder
            reviewType as 'full-paper' | 'selected-text' | 'review-changes',
            selectedText as string | undefined
          );
        }
      } else if (action === 'enableFeedbackClicked' && wid) {
        logger.info(`[Bridge API] Enable feedback clicked for wid: ${wid}`);
        windowMonitorService.openPopupForWindow(wid);
      } else if (action === 'shareToEnableFeedback' && wid) {
        logger.info(`[Bridge API] Share to enable feedback clicked for wid: ${wid}`);
        try {
          const result = await enableFeedback(wid, navigationHandler);
          if (!result.success) {
            logger.error(`[Bridge API] Enable feedback failed: ${result.error}`);
            reply.send({ success: false, error: result.error });
            return;
          }
          reply.send({ success: true, projectId: result.projectId, projectFileId: result.projectFileId });
          return;
        } catch (error: any) {
          logger.error(`[Bridge API] Enable feedback error:`, error);
          reply.send({ success: false, error: error.message || 'Unknown error' });
          return;
        }
      } else if (action === 'showReviewError' && wid) {
        const message = payload.message;
        if (typeof message === 'string') {
          windowMonitorService.setReviewErrorMessage(wid, message);
          windowMonitorService.openPopupForWindow(wid);
        }
      } else if (action === 'showReviewInputOverlay' && wid) {
        windowMonitorService.openReviewInput(wid);
        windowMonitorService.openPopupForWindow(wid);
      } else if (action === 'openReviewPanelV3' && wid) {
        windowMonitorService.openReviewPanelV3(wid);
      } else if (action === 'closeReviewPanelV3' && wid) {
        windowMonitorService.closeReviewPanelV3(wid);
      } else if (action === 'setDockRight' && wid) {
        windowMonitorService.setDockRight(wid, payload.docked === true);
      } else if (action === 'toggleDockRight' && wid) {
        windowMonitorService.toggleDockRight(wid);
      } else if (action === 'clearKickoff') {
        const kickoffId = typeof payload.kickoffId === 'string' ? payload.kickoffId : '';
        if (kickoffId) windowMonitorService.clearPendingKickoff(kickoffId);
      } else if (action === 'clearReview' && wid) {
        // Clear review state when user dismisses the overlay
        windowMonitorService.clearSelectedTextReviewState(wid);
        windowMonitorService.closeReviewInput(wid);
      } else {
        logger.info(`[Bridge API] Unhandled action: ${action}, wid: ${wid}`);
      }

      reply.send({ success: true });
    }
  );

  fastify.get<{ Querystring: { wid: string } }>(
    '/api/drag-offset',
    async (request, reply) => {
      const { wid } = request.query;
      reply.send(windowMonitorService.getButtonDragOffset(wid));
    }
  );

  logger.debug('[Bridge API] Registered bridge routes at /bridge');
}
