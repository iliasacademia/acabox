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
import { remoteFeatureFlags, REMOTE_FLAGS } from '../../remoteFeatureFlags';

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
  // Compute webview visibility from desired state
  const shouldShowButtonV2 = windowMonitorService.getDesiredWebviewVisibility('button-v2', wid);
  const shouldShowPopupV2 = windowMonitorService.getDesiredWebviewVisibility('popup-v2', wid);
  const shouldShowReviewButton = windowMonitorService.getDesiredWebviewVisibility('review-button', wid);
  const shouldShowReviewStatusOverlay = windowMonitorService.getDesiredWebviewVisibility('review-status-overlay', wid);

  // 1. Resolve documentPath from window monitor state
  const documentPath = windowMonitorService.getDocumentPathForWindow(wid);

  // 2. Resolve project file from V2 data store
  const projectFile = documentPath
    ? wordIntegrationDataStoreV2.getProjectFileForPath(documentPath)
    : null;

  // Read reviewing state
  const reviewState = windowMonitorService.getSelectedTextReviewState(wid);

  // Check if selection review completed: if there's a local review state but a notification exists for it, clear the local state
  if (reviewState && reviewState.reviewType === 'selected-text' && notificationManager && currentUserId) {
    const userId = currentUserId();
    if (userId) {
      try {
        const allNotifications = notificationManager.getNotificationsByStatus(userId);
        const completedReview = allNotifications.find(
          (n: CachedNotification) =>
            n.project_file_id === projectFile?.project_file_id &&
            // Check both review_type and agent_name to detect selection reviews
            (n.data?.review_type === 'selected-text' || n.data?.agent_name === 'selected_text_review') &&
            n.data?.conversation_id != null &&
            // Notification was created after the review started
            (typeof n.created_at === 'number' ? n.created_at : new Date(n.created_at).getTime()) > reviewState.startedAt
        );

        if (completedReview) {
          logger.info(`[WORD-POLL-V2] Selection review completed for window ${wid}, clearing local state`);
          windowMonitorService.clearSelectedTextReviewState(wid);
          // Return fresh response without in-progress review
          return buildWordPollResponseV2(wid, notificationManager, currentUserId);
        }
      } catch (err) {
        logger.error(`[WORD-POLL-V2] Error checking for completed review for wid ${wid}:`, err);
      }
    }
  }

  // If no document path at all (unsaved file), hide the button
  if (!documentPath) {
    return {
      shouldShow: false,
      notificationCount: 0,
      isActive: true,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      selectedTextReviewStartedAt: undefined,
      activeDocumentPath: documentPath,
      shouldShowButtonV2: false,
      shouldShowPopupV2,
      shouldShowReviewButton,
      shouldShowReviewStatusOverlay,
    };
  }

  // If document path exists but no project file, show "Enable feedback" button
  if (!projectFile) {
    if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
      logger.info(`[VERBOSE] [WORD-POLL-V2] No project file found for path: "${documentPath}" (cache size: ${wordIntegrationDataStoreV2.getCacheSize()}, keys: ${wordIntegrationDataStoreV2.getCacheKeys().join(', ')})`);
    }
    return {
      shouldShow: false,
      isEnableFeedback: true,
      notificationCount: 0,
      isActive: true,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      selectedTextReviewStartedAt: undefined,
      activeDocumentPath: documentPath,
      shouldShowButtonV2: true,
      shouldShowPopupV2,
      shouldShowReviewButton,
      shouldShowReviewStatusOverlay,
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
    selected_text?: string;
    review_type?: 'full-paper' | 'selected-text' | 'review-changes';
    isInProgress?: boolean;
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
          selected_text: n.data?.selected_text,
          review_type: n.data?.review_type,
        }));
      } catch (err) {
        logger.error(`[WORD-POLL-V2] Error fetching notifications for wid ${wid}:`, err);
      }
    }
  }

  // Add in-progress review to the notification list
  if (reviewState && reviewState.reviewType === 'selected-text') {
    const inProgressReview = {
      id: -1, // Temporary ID for in-progress review
      project_id: reviewState.projectId,
      conversation_id: -1, // No conversation yet
      created_at: reviewState.startedAt,
      title: 'Selection review',
      body_html: 'Review in progress...',
      isRead: true, // Shown as read since it's in progress
      selected_text: reviewState.selectedText,
      review_type: reviewState.reviewType,
      isInProgress: true,
    };

    // Add to front of list, limit total to 2 items
    recentReviewNotifications = [inProgressReview, ...recentReviewNotifications.slice(0, 1)];
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
    reviewType: reviewState?.reviewType,
    selectedText: reviewState?.selectedText,
    activeDocumentPath: documentPath,
    shouldShowButtonV2,
    shouldShowPopupV2,
    shouldShowReviewButton,
    shouldShowReviewStatusOverlay,
  };
}
