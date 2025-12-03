/**
 * Notification routes for the HTTP server
 *
 * Provides REST API endpoints for notification management:
 * - GET /api/notifications - List notifications with optional filters
 * - PATCH /api/notifications/:id - Update notification status
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CachedNotification } from '../../notificationManager';
import {
  GetNotificationsQuery,
  GetNotificationsResponse,
  UpdateNotificationBody,
  UpdateNotificationResponse,
  NotificationCountResponse,
} from '../types';

/**
 * Register notification routes on a Fastify instance
 *
 * @param fastify Fastify instance
 * @param notificationManager NotificationManager instance for data access
 * @param currentUserId Function that returns the current user ID
 */
export async function registerNotificationRoutes(
  fastify: FastifyInstance,
  notificationManager: any, // Type from notificationManager.ts
  currentUserId: () => number | null
): Promise<void> {
  /**
   * GET /api/notifications
   *
   * List notifications with optional filtering
   *
   * Query parameters:
   * - status: 'unread' | 'read' | 'dismissed' (optional)
   * - limit: number (optional, max 100)
   *
   * Returns:
   * {
   *   notifications: Notification[],
   *   count: number
   * }
   */
  fastify.get<{
    Querystring: GetNotificationsQuery;
  }>(
    '/api/notifications',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['unread', 'read', 'dismissed'],
            },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 100,
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: GetNotificationsQuery }>, reply: FastifyReply) => {
      const userId = currentUserId();

      if (!userId) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'No user logged in',
          statusCode: 400,
        });
        return;
      }

      const { status, limit } = request.query;

      console.log(`[Notifications API] GET /api/notifications - userId=${userId}, status=${status || 'all'}, limit=${limit || 'none'}`);

      try {
        // Get notifications from manager
        let notifications: CachedNotification[];

        if (status) {
          notifications = notificationManager.getNotificationsByStatus(userId, status);
        } else {
          // Get all undismissed notifications if no status specified
          notifications = notificationManager.getUndismissedNotifications(userId);
        }

        // Apply limit if specified
        if (limit && limit > 0) {
          notifications = notifications.slice(0, limit);
        }

        const response: GetNotificationsResponse = {
          notifications,
          count: notifications.length,
        };

        console.log(`[Notifications API] Returning ${notifications.length} notifications`);

        reply.send(response);
      } catch (error) {
        console.error('[Notifications API] Error fetching notifications:', error);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'Failed to fetch notifications',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * GET /api/notifications/count
   *
   * Get notification counts by status
   *
   * Returns:
   * {
   *   total: number,      // Total undismissed notifications
   *   unread: number,     // Unread notifications
   *   read: number        // Read (but not dismissed) notifications
   * }
   */
  fastify.get<{
    Querystring: { project_file_id?: string };
  }>(
    '/api/notifications/count',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            project_file_id: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { project_file_id?: string } }>, reply: FastifyReply) => {
      const userId = currentUserId();

      if (!userId) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'No user logged in',
          statusCode: 400,
        });
        return;
      }

      const { project_file_id } = request.query;
      const projectFileIdNum = project_file_id ? parseInt(project_file_id, 10) : undefined;

      console.log(`[Notifications API] GET /api/notifications/count - userId=${userId}, project_file_id=${projectFileIdNum ?? 'all'}`);

      try {
        // Get undismissed notifications (both unread and read)
        let undismissed = notificationManager.getUndismissedNotifications(userId);

        // Filter by project_file_id if provided
        if (projectFileIdNum !== undefined && !isNaN(projectFileIdNum)) {
          undismissed = undismissed.filter(
            (n: CachedNotification) => n.project_file_id === projectFileIdNum
          );
        }

        // Count by status
        const unreadCount = undismissed.filter((n: CachedNotification) => n.status === 'unread').length;
        const readCount = undismissed.filter((n: CachedNotification) => n.status === 'read').length;

        // Return full notification data along with counts for verification
        const response = {
          notifications: undismissed,
          total: undismissed.length,
          unread: unreadCount,
          read: readCount,
        };

        console.log(`[Notifications API] Returning ${undismissed.length} notifications - total: ${response.total}, unread: ${response.unread}, read: ${response.read}${projectFileIdNum !== undefined ? ` (filtered by project_file_id=${projectFileIdNum})` : ''}`);

        reply.send(response);
      } catch (error) {
        console.error('[Notifications API] Error fetching notification counts:', error);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'Failed to fetch notification counts',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * PATCH /api/notifications/:id
   *
   * Update notification status
   *
   * Path parameters:
   * - id: notification ID (number)
   *
   * Body:
   * {
   *   status: 'read' | 'dismissed'
   * }
   *
   * Returns:
   * {
   *   success: boolean,
   *   notification: Notification | null
   * }
   */
  fastify.patch<{
    Params: { id: string };
    Body: UpdateNotificationBody;
  }>(
    '/api/notifications/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['read', 'dismissed'],
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: UpdateNotificationBody;
      }>,
      reply: FastifyReply
    ) => {
      const userId = currentUserId();

      if (!userId) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'No user logged in',
          statusCode: 400,
        });
        return;
      }

      const notificationId = parseInt(request.params.id, 10);

      if (isNaN(notificationId)) {
        reply.code(400).send({
          error: 'BadRequest',
          message: 'Invalid notification ID',
          statusCode: 400,
        });
        return;
      }

      const { status } = request.body;

      console.log(`[Notifications API] PATCH /api/notifications/${notificationId} - status=${status}`);

      try {
        // Update notification status via manager
        if (status === 'read') {
          await notificationManager.markAsRead(notificationId);
        } else if (status === 'dismissed') {
          await notificationManager.dismissNotification(notificationId);
        } else {
          reply.code(400).send({
            error: 'BadRequest',
            message: 'Invalid status. Must be "read" or "dismissed"',
            statusCode: 400,
          });
          return;
        }

        // Get updated notification
        const notifications = notificationManager.getNotificationsByStatus(userId);
        const updatedNotification = notifications.find((n: CachedNotification) => n.id === notificationId);

        const response: UpdateNotificationResponse = {
          success: true,
          notification: updatedNotification || null,
        };

        console.log(`[Notifications API] Successfully updated notification ${notificationId} to ${status}`);

        reply.send(response);
      } catch (error) {
        console.error(`[Notifications API] Error updating notification ${notificationId}:`, error);
        reply.code(500).send({
          error: 'InternalServerError',
          message: 'Failed to update notification',
          statusCode: 500,
        });
      }
    }
  );

  console.log('[Notifications API] Registered notification routes');
}
