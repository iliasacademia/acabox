/**
 * Builds the overlay poll response for a given window ID (wid).
 *
 * Originally Word-specific; now host-agnostic — works for any HostApp whose
 * `documentPath` is normalized into the workspace directory. Word path uses
 * the project-file mapping; non-Word hosts (e.g. Obsidian) skip that lookup.
 *
 * Conversations are fetched directly by the popup via the proxy API.
 *
 * The legacy export name `buildWordPollResponseV2` is kept for back-compat;
 * `buildOverlayPollResponseV2` is the preferred name for new callers.
 */

import { windowMonitorService } from '../../windowMonitorService';
import { getRegisteredHostApps } from '../../cobuilding/main/hostApps';
import { wordIntegrationDataStoreV2 } from '../../wordIntegrationDataStoreV2';
import { OverlayPollResponse } from '../types';
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
): OverlayPollResponse {
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
  // Cobuilding mode is active when a workspace has been selected. The check
  // below uses the *active* workspace's directory; documents in non-active
  // workspaces are treated the same as documents outside any workspace.
  const activeWorkspaceDir = windowMonitorService.getActiveWorkspaceDirectory();
  const isCobuildingMode = !!activeWorkspaceDir;

  // If no document path at all (unsaved file)
  if (!documentPath) {
    // For Obsidian (and other non-Word hosts), the overlay should still appear
    // when the user is in cobuilding mode and the workspace is the vault, even
    // if no specific .md file is currently active. When the host has declared
    // a `sessionDocumentPathLikePattern` (Apple Notes does), fall back to
    // listing every chat tied to that host so the user can pick from previous
    // conversations even before the active document resolves.
    const hostAppId = windowMonitorService.getHostAppIdForWindow(wid);
    // Google Docs is doc-rooted — we explicitly do NOT show the overlay over a
    // Chrome window that isn't on a Google Doc tab. The host has no
    // `sessionDocumentPathLikePattern` for that reason; without an active
    // gdocs:// path resolved by the extension, hide the overlay entirely so
    // the user doesn't see Academia floating over Twitter / Reddit / Github.
    if (hostAppId === 'google-docs') {
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
    if (isCobuildingMode && hostAppId && hostAppId !== 'word') {
      const host = getRegisteredHostApps().find((h) => h.id === hostAppId);
      const fallbackPattern = host?.sessionDocumentPathLikePattern;
      const sessions = fallbackPattern
        ? windowMonitorService.getWorkspaceSessionsByDocPathLike(fallbackPattern)
        : [];
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
        hasSelectedText: false,
        isDockedActive,
      };
    }
    if (isCobuildingMode) {
      // Cobuilding mode + unsaved Word doc — hide overlay entirely.
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

  // Synthetic-scheme document paths (e.g. `applenotes://<id>`, `gdocs://<id>`)
  // come from hosts whose documents don't live in the workspace folder (Apple
  // Notes is in the OS database, Google Docs is in the cloud). Treat them like
  // an in-workspace doc for overlay purposes: show the overlay, scope sessions
  // to the synthetic id, surface the host-supplied display title and any
  // selection text the host has captured (canvas-interception for Docs, AX for
  // Apple Notes when applicable).
  const isSyntheticDocPath = /^[a-z][a-z0-9+.-]*:\/\//i.test(documentPath) && !documentPath.startsWith('file://');
  if (isCobuildingMode && isSyntheticDocPath) {
    const sessions = windowMonitorService.getWorkspaceSessions(documentPath);
    let displayName: string | null = null;
    let selectedTextOut: string | undefined;
    if (documentPath.startsWith('gdocs://')) {
      displayName = windowMonitorService.getGoogleDocsTitle();
      const sel = windowMonitorService.getGoogleDocsSelectedText();
      if (sel) selectedTextOut = sel;
    }
    return {
      isInWorkspace: true,
      workspaceSessions: sessions,
      notificationCount: 0,
      isActive: true,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      activeDocumentPath: documentPath,
      activeDocumentDisplayName: displayName,
      shouldShowButtonV2,
      shouldShowPopupV2,
      shouldShowReviewButton: false,
      hasSelectedText: !!selectedTextOut,
      selectedText: selectedTextOut,
      isDockedActive,
    };
  }

  // Check if the document is within the active cobuilding workspace directory
  if (activeWorkspaceDir) {
    if (documentPath.startsWith(activeWorkspaceDir + '/')) {
      const sessions = windowMonitorService.getWorkspaceSessions(documentPath);
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
        hasSelectedText: false,
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

/** Preferred name for new callers. Host-agnostic alias for buildWordPollResponseV2. */
export const buildOverlayPollResponseV2 = buildWordPollResponseV2;
