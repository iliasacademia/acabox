/**
 * Word integration routes for the HTTP server
 *
 * Provides REST API endpoints for Word process integration:
 * - GET /word/:pid/project_file - Get project file info for a Word PID
 * - GET /word/:pid/poll - Poll status and notifications for a Word PID
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { wordIntegrationDataStore } from '../../wordIntegrationDataStore';
import { WordProjectFileResponse, WordPollResponse } from '../types';
import { CachedNotification } from '../../notificationManager';
import { defaultLogger as logger } from '../../utils/logger';
import { wordIntegrationService } from '../../wordIntegrationService';

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

      // 1. Get Active Document Path from Native
      const activePath = wordIntegrationService.getActiveDocumentPath(pid);
      
      // 2. Resolve Project Info based on Path
      let projectFile = null;
      if (activePath) {
        projectFile = wordIntegrationDataStore.getProjectFileForPath(activePath);
      } else {
        // Fallback: If no active path (maybe window not ready), check if PID is tracked at all
        // This handles cases where we know the PID but can't get path yet
        projectFile = wordIntegrationDataStore.getProjectFileForPID(pid);
      }

      const trackedPIDs = wordIntegrationDataStore.getTrackedPIDs();
      const tracked = trackedPIDs.find(p => p.pid === pid);

      // If not tracked or no project file, hide the button
      if (!projectFile || !tracked) {
        const response: WordPollResponse = {
          shouldShow: false,
          notificationCount: 0,
          isActive: false,
          fullReviewNotification: null,
          diffReviewNotification: null,
          activeDocumentPath: activePath
        };
        reply.send(response);
        return;
      }

      // Calculate notification count and find review notifications if user is logged in
      let count = 0;
      let fullReviewNotification = null;
      let diffReviewNotification = null;

      if (notificationManager && currentUserId) {
        const userId = currentUserId();
        if (userId) {
          try {
            // Get ALL notifications (including dismissed) so we can always show the latest review
            const allNotifications = notificationManager.getNotificationsByStatus(userId);
            const filtered = allNotifications.filter((n: CachedNotification) => n.project_file_id === projectFile.project_file_id);

            // Count only unread notifications for the badge
            count = filtered.filter((n: CachedNotification) => n.status === 'unread').length;

            // Helper to get timestamp from created_at (handles both number and ISO string)
            const getTimestamp = (createdAt: number | string): number => {
              return typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime();
            };

            // Find latest full review notification (sorted by created_at descending)
            const fullReviewNotif = filtered
              .filter((n: any) => n.data?.conversation_id != null && n.data?.agent_name?.includes("full"))
              .sort((a: CachedNotification, b: CachedNotification) => getTimestamp(b.created_at) - getTimestamp(a.created_at))[0];

            // Find latest diff review notification (sorted by created_at descending)
            const diffReviewNotif = filtered
              .filter((n: any) => n.data?.conversation_id != null && n.data?.agent_name?.includes("diff"))
              .sort((a: CachedNotification, b: CachedNotification) => getTimestamp(b.created_at) - getTimestamp(a.created_at))[0];

            if (fullReviewNotif) {
              fullReviewNotification = {
                id: fullReviewNotif.id,
                project_id: fullReviewNotif.project_id,
                conversation_id: fullReviewNotif.data.conversation_id,
                created_at: fullReviewNotif.created_at,
                title: fullReviewNotif.title,
                isRead: fullReviewNotif.status !== 'unread',
              };
            }

            if (diffReviewNotif) {
              diffReviewNotification = {
                id: diffReviewNotif.id,
                project_id: diffReviewNotif.project_id,
                conversation_id: diffReviewNotif.data.conversation_id,
                created_at: diffReviewNotif.created_at,
                title: diffReviewNotif.title,
                isRead: diffReviewNotif.status !== 'unread',
              };
            }

          } catch (err) {
            logger.error(`[WORD-POLL] Error fetching notifications for PID ${pid}:`, err);
          }
        }
      }

      const response: WordPollResponse = {
        shouldShow: true,
        projectId: projectFile.project_id,
        projectFileId: projectFile.project_file_id,
        notificationCount: count,
        isActive: tracked.isActive,
        fullReviewNotification,
        diffReviewNotification,
        activeDocumentPath: activePath
      };

      reply.send(response);
    }
  );
}
