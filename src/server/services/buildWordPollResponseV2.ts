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

  // Read reviewing state
  const reviewState = windowMonitorService.getSelectedTextReviewState(wid);

  // If no document path or no project file, hide the button
  if (!projectFile) {
    return {
      shouldShow: false,
      notificationCount: 0,
      isActive: true,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      selectedTextReviewStartedAt: undefined,
      activeDocumentPath: documentPath,
    };
  }

  // Calculate notification count and find review notifications if user is logged in
  let count = 0;
  let recentReviewNotifications: Array<{
    id: number;
    project_id: number;
    conversation_id: number;
    conversation_title?: string;
    created_at: number;
    title: string;
    body_html?: string;
    isRead: boolean;
  }> = [];

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

        // Get 2 most recent review notifications (any type: full, diff, selected_text)
        const recentReviewNotifs = filtered
          .filter((n: any) => n.data?.conversation_id != null)
          .sort(
            (a: CachedNotification, b: CachedNotification) =>
              getTimestamp(b.created_at) - getTimestamp(a.created_at)
          )
          .slice(0, 2);

        recentReviewNotifications = recentReviewNotifs.map((n: any) => ({
          id: n.id,
          project_id: n.project_id,
          conversation_id: n.data.conversation_id,
          conversation_title: n.data.conversation_title,
          created_at: n.created_at,
          title: n.title,
          body_html: n.body_html,
          isRead: n.status !== 'unread',
        }));
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
    recentReviewNotifications,
    isReviewingSelectedText: reviewState !== null,
    selectedTextReviewStartedAt: reviewState?.startedAt,
    activeDocumentPath: documentPath,
  };
}
