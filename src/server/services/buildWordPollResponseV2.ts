/**
 * Builds the overlay poll response for a given window ID (wid).
 *
 * Host-agnostic — works for any registered HostApp. Only shows the overlay
 * when a workspace is active (cobuilding mode) and the document is either
 * inside a workspace directory or uses a synthetic scheme (gdocs://, applenotes://).
 */

import { windowMonitorService } from '../../windowMonitorService';
import { getRegisteredHostApps } from '../../cobuilding/main/hostApps';
import { OverlayPollResponse } from '../types';
import { resolveFileId } from './resolveFileId';
import { getCacheEntry as getGoogleDriveCacheEntry } from '../../cobuilding/main/db/googleDriveCacheRepository';

/**
 * Check if a document is in the active workspace.
 * - Local files: path must be within a workspace directory
 * - Google Docs (gdocs://): doc ID must be in the Google Drive cache
 * - Other synthetic schemes (applenotes://): always considered in-workspace
 */
function isDocumentInWorkspace(documentPath: string, activeWorkspaceDirs: string[]): boolean {
  if (documentPath.startsWith('gdocs://')) {
    const docId = documentPath.slice('gdocs://'.length);
    return !!getGoogleDriveCacheEntry(docId);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(documentPath) && !documentPath.startsWith('file://')) {
    return true;
  }
  return activeWorkspaceDirs.some(dir => documentPath.startsWith(dir + '/'));
}

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

  // 1. Resolve documentPath and stable file identifier from window monitor state
  const documentPath = windowMonitorService.getDocumentPathForWindow(wid);
  const fileId = resolveFileId(documentPath);

  const isDockedActive = windowMonitorService.isDockedActive(wid);
  // Cobuilding mode is active when a workspace has been selected. The check
  // below uses the *active* workspace's directories; documents in non-active
  // workspaces are treated the same as documents outside any workspace.
  const activeWorkspaceDirs = windowMonitorService.getActiveWorkspaceDirectories();
  const isCobuildingMode = activeWorkspaceDirs.length > 0;

  // If no document path at all (unsaved file)
  if (!documentPath) {
    // For Obsidian (and other non-Word hosts), the overlay should still appear
    // when the user is in cobuilding mode and the workspace is the vault, even
    // if no specific .md file is currently active. When the host has declared
    // a `sessionDocumentPathLikePattern` (Apple Notes does), fall back to
    // listing every chat tied to that host so the user can pick from previous
    // conversations even before the active document resolves.
    const hostAppId = windowMonitorService.getHostAppIdForWindow(wid);
    // Google Docs is doc-rooted — only show the overlay when the active
    // browser tab is a Google Doc (gdocs:// path detected by the native
    // window monitor). When the tab is not a Docs page, hide everything.
    if (hostAppId === 'google-docs') {
      return {
        notificationCount: 0,
        isActive: false,
        recentReviewNotifications: [],
        isReviewingSelectedText: false,
        activeDocumentPath: documentPath,
        activeDocumentFileId: fileId,
        shouldShowButtonV2: false,
        shouldShowPopupV2: false,
        shouldShowReviewButton: false,
        hasSelectedText: false,
        isDockedActive: false,
        isInWorkspace: false,
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
        activeDocumentFileId: fileId,
        shouldShowButtonV2,
        shouldShowPopupV2,
        shouldShowReviewButton: false,
        hasSelectedText: false,
        isDockedActive,
      };
    }
    // No document path — hide overlay entirely.
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

  // Unified workspace membership check: local files must be in a workspace
  // directory, Google Docs must be in the Drive cache, other synthetic schemes
  // (Apple Notes) are always in-workspace.
  if (isCobuildingMode && isDocumentInWorkspace(documentPath, activeWorkspaceDirs)) {
    const sessions = windowMonitorService.getWorkspaceSessions(documentPath);
    const selectedTextContent = wid
      ? windowMonitorService.getSelectedTextContent(wid)
      : windowMonitorService.getLastSelectedText();
    const pendingKickoff = windowMonitorService.consumePendingKickoffForDocument(documentPath);
    const pendingNavigate = windowMonitorService.consumePendingNavigateSession();
    let displayName: string | null = null;
    if (documentPath.startsWith('gdocs://')) {
      displayName = windowMonitorService.getGoogleDocsTitle();
    }
    return {
      isInWorkspace: true,
      workspaceSessions: sessions,
      notificationCount: 0,
      isActive: true,
      recentReviewNotifications: [],
      isReviewingSelectedText: false,
      activeDocumentPath: documentPath,
      activeDocumentFileId: fileId,
      activeDocumentDisplayName: displayName,
      shouldShowButtonV2,
      shouldShowPopupV2,
      shouldShowReviewButton: false,
      hasSelectedText: false,
      selectedText: selectedTextContent ?? undefined,
      isDockedActive,
      ...(pendingKickoff
        ? {
            pendingKickoffId: pendingKickoff.kickoffId,
            ...(pendingKickoff.prompt !== null
              ? { pendingKickoffPrompt: pendingKickoff.prompt }
              : {}),
          }
        : {}),
      ...(pendingNavigate
        ? {
            pendingNavigateSessionId: pendingNavigate.sessionId,
            pendingNavigateNonce: pendingNavigate.nonce,
          }
        : {}),
    };
  }

  // Document is outside the workspace — hide overlay.
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

/** Preferred name for new callers. Host-agnostic alias for buildWordPollResponseV2. */
export const buildOverlayPollResponseV2 = buildWordPollResponseV2;
