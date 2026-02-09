/**
 * Builds the WordPollResponse for a given window ID (wid).
 *
 * V2 equivalent of buildWordPollResponse — uses window monitor state
 * instead of tracked PIDs / wordIntegrationService.
 */

import { windowMonitorService } from '../../windowMonitorService';
import { wordIntegrationDataStoreV2 } from '../../wordIntegrationDataStoreV2';
import { WordPollResponse } from '../types';
import { CachedNotification } from '../../notificationManager';
import { defaultLogger as logger } from '../../utils/logger';

/**
 * Build a WordPollResponse for the given window ID.
 *
 * @param wid                 Window ID from window-monitor
 * @param notificationManager NotificationManager instance (optional)
 * @param currentUserId       Function returning the current user ID (optional)
 */
export function buildWordPollResponseV2(
  wid: string,
  notificationManager?: any,
  currentUserId?: () => number | null
): WordPollResponse {
  // 1. Resolve documentPath from window monitor state
  const documentPath = windowMonitorService.getDocumentPathForWindow(wid);

  // 2. Resolve project file from V2 data store
  const projectFile = documentPath
    ? wordIntegrationDataStoreV2.getProjectFileForPath(documentPath)
    : null;

  // If no document path or no project file, hide the button
  if (!projectFile) {
    return {
      shouldShow: false,
      notificationCount: 0,
      isActive: true,
      fullReviewNotification: null,
      diffReviewNotification: null,
      activeDocumentPath: documentPath,
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
        logger.error(`[WORD-POLL-V2] Error fetching notifications for wid ${wid}:`, err);
      }
    }
  }

  return {
    shouldShow: true,
    projectId: projectFile.project_id,
    projectFileId: projectFile.project_file_id,
    notificationCount: count,
    isActive: true,
    fullReviewNotification,
    diffReviewNotification,
    activeDocumentPath: documentPath,
  };
}
