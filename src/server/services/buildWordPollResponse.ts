/**
 * Builds the WordPollResponse for a given PID.
 *
 * Pure function shared by the HTTP GET /word/:pid/poll route
 * and the WebSocket push handler.
 */

import { wordIntegrationDataStore } from '../../wordIntegrationDataStore';
import { WordPollResponse } from '../types';
import { CachedNotification } from '../../notificationManager';
import { defaultLogger as logger } from '../../utils/logger';
import { wordIntegrationService } from '../../wordIntegrationService';

/**
 * Build a WordPollResponse for the given PID.
 *
 * @param pid            Word process ID
 * @param notificationManager  NotificationManager instance (optional)
 * @param currentUserId  Function returning the current user ID (optional)
 */
export function buildWordPollResponse(
  pid: number,
  notificationManager?: any,
  currentUserId?: () => number | null
): WordPollResponse {
  // 1. Get Active Document Path from Native
  const activePath = wordIntegrationService.getActiveDocumentPath(pid);

  // 2. Resolve Project Info based on Path
  let projectFile = null;
  if (activePath) {
    projectFile = wordIntegrationDataStore.getProjectFileForPath(activePath);
  } else {
    projectFile = wordIntegrationDataStore.getProjectFileForPID(pid);
  }

  const trackedPIDs = wordIntegrationDataStore.getTrackedPIDs();
  const tracked = trackedPIDs.find(p => p.pid === pid);

  // If not tracked or no project file, hide the button
  if (!projectFile || !tracked) {
    return {
      shouldShow: false,
      notificationCount: 0,
      isActive: false,
      fullReviewNotification: null,
      diffReviewNotification: null,
      activeDocumentPath: activePath,
    };
  }

  // Calculate notification count and find review notifications if user is logged in
  let count = 0;
  let fullReviewNotification = null;
  let diffReviewNotification = null;

  if (notificationManager && currentUserId) {
    const userId = currentUserId();
    if (userId) {
      try {
        const allNotifications = notificationManager.getNotificationsByStatus(userId);
        const filtered = allNotifications.filter(
          (n: CachedNotification) => n.project_file_id === projectFile.project_file_id
        );

        count = filtered.filter((n: CachedNotification) => n.status === 'unread').length;

        const getTimestamp = (createdAt: number | string): number => {
          return typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime();
        };

        const fullReviewNotif = filtered
          .filter((n: any) => n.data?.conversation_id != null && n.data?.agent_name?.includes('full'))
          .sort(
            (a: CachedNotification, b: CachedNotification) =>
              getTimestamp(b.created_at) - getTimestamp(a.created_at)
          )[0];

        const diffReviewNotif = filtered
          .filter((n: any) => n.data?.conversation_id != null && n.data?.agent_name?.includes('diff'))
          .sort(
            (a: CachedNotification, b: CachedNotification) =>
              getTimestamp(b.created_at) - getTimestamp(a.created_at)
          )[0];

        if (fullReviewNotif) {
          fullReviewNotification = {
            id: fullReviewNotif.id,
            project_id: fullReviewNotif.project_id,
            conversation_id: fullReviewNotif.data.conversation_id,
            conversation_title: fullReviewNotif.data.conversation_title,
            created_at: fullReviewNotif.created_at,
            title: fullReviewNotif.title,
            body_html: fullReviewNotif.body_html,
            isRead: fullReviewNotif.status !== 'unread',
          };
        }

        if (diffReviewNotif) {
          diffReviewNotification = {
            id: diffReviewNotif.id,
            project_id: diffReviewNotif.project_id,
            conversation_id: diffReviewNotif.data.conversation_id,
            conversation_title: diffReviewNotif.data.conversation_title,
            created_at: diffReviewNotif.created_at,
            title: diffReviewNotif.title,
            body_html: diffReviewNotif.body_html,
            isRead: diffReviewNotif.status !== 'unread',
          };
        }
      } catch (err) {
        logger.error(`[WORD-POLL] Error fetching notifications for PID ${pid}:`, err);
      }
    }
  }

  return {
    shouldShow: true,
    projectId: projectFile.project_id,
    projectFileId: projectFile.project_file_id,
    notificationCount: count,
    isActive: tracked.isActive,
    fullReviewNotification,
    diffReviewNotification,
    activeDocumentPath: activePath,
  };
}
