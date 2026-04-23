/**
 * Builds the WordPollResponse for a given window ID (wid).
 *
 * Cobuild version — returns project mapping, visibility, and docking state.
 * Conversations are fetched directly by the popup via the proxy API.
 */

import { windowMonitorService } from '../../windowMonitorService';
import { wordIntegrationDataStoreV2 } from '../../wordIntegrationDataStoreV2';
import { WordPollResponse } from '../types';
import { defaultLogger as logger } from '../../utils/logger';
import { remoteFeatureFlags, REMOTE_FLAGS } from '../../remoteFeatureFlags';

/**
 * Build a WordPollResponse for the given window ID.
 *
 * @param wid                 Window ID from window-monitor
 * @param notificationManager NotificationManager instance (unused on cobuild, kept for API compat)
 * @param currentUserId       Function returning the current user ID (unused on cobuild, kept for API compat)
 */
export function buildWordPollResponseV2(
  wid: string,
  _notificationManager?: any,
  _currentUserId?: () => number | null
): WordPollResponse {
  // Compute webview visibility from desired state
  const shouldShowButtonV2 = windowMonitorService.getDesiredWebviewVisibility('button-v2', wid);
  const shouldShowPopupV2 = windowMonitorService.getDesiredWebviewVisibility('popup-v2', wid);

  // 1. Resolve documentPath from window monitor state
  const documentPath = windowMonitorService.getDocumentPathForWindow(wid);

  // 2. Resolve project file from V2 data store
  const projectFile = documentPath
    ? wordIntegrationDataStoreV2.getProjectFileForPath(documentPath)
    : null;

  const isDockedActive = windowMonitorService.isDockedActive(wid);

  // If no document path at all (unsaved file)
  if (!documentPath) {
    return {
      isEnableFeedback: true,
      isUnsavedDocument: true,
      notificationCount: 0,
      isActive: true,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      activeDocumentPath: documentPath,
      shouldShowButtonV2: true,
      shouldShowPopupV2,
      shouldShowReviewButton: false,
      hasSelectedText: false,
      isDockedActive,
    };
  }

  // Check if the document is within the cobuilding workspace directory
  const workspaceDir = windowMonitorService.getWorkspaceDirectory();
  if (workspaceDir) {
    if (documentPath.startsWith(workspaceDir + '/')) {
      const sessions = windowMonitorService.getWorkspaceSessions();
      const selectedTextContent = wid
        ? windowMonitorService.getSelectedTextContent(wid)
        : windowMonitorService.getLastSelectedText();
      return {
        isInWorkspace: true,
        workspaceSessions: sessions,
        notificationCount: 0,
        isActive: true,
        recentReviewNotifications: [],
        isReviewingSelectedText: false,
        activeDocumentPath: documentPath,
        shouldShowButtonV2,
        shouldShowPopupV2,
        shouldShowReviewButton: false,
        hasSelectedText: !!selectedTextContent,
        selectedText: selectedTextContent ?? undefined,
        isDockedActive,
      };
    }
    // Cobuilding mode: document is outside the workspace — hide overlay entirely
    return {
      notificationCount: 0,
      isActive: false,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      activeDocumentPath: documentPath,
      shouldShowButtonV2: false,
      shouldShowPopupV2: false,
      shouldShowReviewButton: false,
      hasSelectedText: false,
      isDockedActive: false,
    };
  }

  // If document path exists but no project file mapping
  if (!projectFile) {
    if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
      logger.info(`[VERBOSE] [WORD-POLL-V2] No project file found for path: "${documentPath}" (cache size: ${wordIntegrationDataStoreV2.getCacheSize()}, keys: ${wordIntegrationDataStoreV2.getCacheKeys().join(', ')})`);
    }
    return {
      isEnableFeedback: true,
      notificationCount: 0,
      isActive: true,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      activeDocumentPath: documentPath,
      shouldShowButtonV2: true,
      shouldShowPopupV2,
      shouldShowReviewButton: false,
      hasSelectedText: false,
      isDockedActive,
    };
  }

  // Document is mapped to a project — return project info for conversation fetching
  return {
    projectId: projectFile.project_id,
    projectFileId: projectFile.project_file_id,
    notificationCount: 0,
    isActive: true,
    recentReviewNotifications: [],
    isReviewingSelectedText: false,
    activeDocumentPath: documentPath,
    shouldShowButtonV2,
    shouldShowPopupV2,
    shouldShowReviewButton: false,
    hasSelectedText: false,
    isDockedActive,
  };
}
