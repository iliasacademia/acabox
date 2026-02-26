import { app } from 'electron';
import { ulid } from 'ulid';
import { wordIntegrationDataStoreV2 } from './wordIntegrationDataStoreV2';
import { defaultLogger as logger } from './utils/logger';
import { getDeviceId } from './utils/deviceId';
import { WindowMonitorEvent } from './windowMonitor/types';
import type { SessionDb } from './sessionDbFactory';

export interface SessionRow {
  session_id: string;
  session_type: string;
  user_id: number | null;
  start_time: string;
  end_time: string;
  data: string;
  device_id: string;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  app_version: string;
}

export interface SessionsTracker {
  recordAppStarted(): void;
  recordUserLoggedIn(userId: number): void;
  recordUserLoggedOut(): void;
  recordAppStopping(): void;
  processEvent(event: WindowMonitorEvent): void;
  startPeriodicFlush(intervalMs: number): void;
  stopPeriodicFlush(): void;
  fetchSessionsToSync(): SessionRow[];
  updateSessionSyncTime(sessionIds: string[]): void;
}

const SESSION_RETENTION_DAYS = 14;

export function createSessionsTracker(sessionDb: SessionDb): SessionsTracker {
  let currentUserId: number | null = null;
  let appSessionId: string | null = null;

  /** The current word_window_focused session */
  let focusedSessionId: string | null = null;

  /** The window ID of the current focused session */
  let focusedWindowId: string | null = null;

  /** The document path of the current focused window (for null→path vs path→path detection) */
  let focusedDocumentPath: string | null = null;

  /** windowId → appPid (for cleanup on APP_TERMINATED) */
  const windowToApp = new Map<string, number>();

  const TEXT_CHANGE_SESSION_GAP_MS = 60_000; // 1 minute

  /** windowId → { sessionId, lastEventTime } */
  const textChangeSessions = new Map<string, { sessionId: string; lastEventTime: number }>();

  let flushInterval: ReturnType<typeof setInterval> | null = null;

  // --- Helpers ---

  function now(): string {
    return new Date().toISOString();
  }

  function createSession(
    sessionType: 'desktop_app' | 'word_window_focused' | 'document_text_change',
    data: Record<string, unknown> = {}
  ): string {
    const id = ulid();
    const startMs = Date.now();
    const timestamp = new Date(startMs).toISOString();
    const minEndTime = new Date(startMs + 1000).toISOString();
    sessionDb.insertSession.run(id, sessionType, currentUserId, timestamp, minEndTime, JSON.stringify(data), getDeviceId(), timestamp, timestamp, app.getVersion());
    return id;
  }

  function closeSession(sessionId: string): void {
    const timestamp = now();
    sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
  }

  function purgeExpiredSessions(): void {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const row = sessionDb.getMetadata.get('last_cleanup_date') as { value: string } | undefined;

    if (row?.value === today) return;

    const cutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = sessionDb.deleteOldSessions.run(cutoff);
    sessionDb.setMetadata.run('last_cleanup_date', today);
    logger.info('[SessionsTracker] Purged expired sessions:', result.changes, 'rows deleted');
  }

  function lookupProjectFile(documentPath: string | null) {
    if (!documentPath) return null;
    // AXDocument reports file:// URLs; the cache uses plain filesystem paths.
    const normalizedPath = documentPath.startsWith('file://')
      ? decodeURIComponent(documentPath.slice(7))
      : documentPath;
    return wordIntegrationDataStoreV2.getProjectFileForPath(normalizedPath);
  }

  function closeFocusedSession(): void {
    if (focusedSessionId) {
      closeSession(focusedSessionId);
      logger.info('[SessionsTracker] Focused session closed:', focusedSessionId);
      focusedSessionId = null;
      focusedWindowId = null;
      focusedDocumentPath = null;
    }
  }

  // --- App lifecycle ---

  function recordAppStarted(): void {
    purgeExpiredSessions();
    appSessionId = createSession('desktop_app');
    logger.info('[SessionsTracker] App session started:', appSessionId);
  }

  function recordUserLoggedIn(userId: number): void {
    currentUserId = userId;
    const timestamp = now();
    if (appSessionId) {
      sessionDb.setUserId.run(userId, timestamp, appSessionId);
    }
    if (focusedSessionId) {
      sessionDb.setUserId.run(userId, timestamp, focusedSessionId);
    }
    for (const { sessionId } of textChangeSessions.values()) {
      sessionDb.setUserId.run(userId, timestamp, sessionId);
    }
    logger.info('[SessionsTracker] User logged in:', userId);
  }

  function recordUserLoggedOut(): void {
    if (appSessionId) {
      closeSession(appSessionId);
      appSessionId = null;
    }
    closeFocusedSession();
    for (const { sessionId } of textChangeSessions.values()) {
      closeSession(sessionId);
    }
    textChangeSessions.clear();
    windowToApp.clear();

    currentUserId = null;

    appSessionId = createSession('desktop_app');
    logger.info('[SessionsTracker] User logged out. New app session:', appSessionId);
  }

  function recordAppStopping(): void {
    const timestamp = now();
    if (appSessionId) {
      sessionDb.updateEndTime.run(timestamp, timestamp, appSessionId);
      appSessionId = null;
    }
    if (focusedSessionId) {
      sessionDb.updateEndTime.run(timestamp, timestamp, focusedSessionId);
      focusedSessionId = null;
      focusedWindowId = null;
      focusedDocumentPath = null;
    }
    for (const { sessionId } of textChangeSessions.values()) {
      sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
    }
    textChangeSessions.clear();
    windowToApp.clear();
    logger.info('[SessionsTracker] App stopping — all sessions closed');
  }

  // --- Window monitor events ---

  function processEvent(event: WindowMonitorEvent): void {
    switch (event.event) {
      case 'APP_LAUNCHED':
      case 'APP_EXISTING': {
        // No-op: focused sessions are created by WINDOW_FOCUSED
        break;
      }

      case 'WINDOW_FOCUSED': {
        const windowId = event.window.id;
        const documentPath = event.window.documentPath;

        // Close previous focused session (if any)
        closeFocusedSession();

        // Create new word_window_focused session
        const projectFile = lookupProjectFile(documentPath);
        const data: Record<string, unknown> = {
          document_path: documentPath ?? null,
          project_id: projectFile?.project_id ?? null,
          project_file_id: projectFile?.project_file_id ?? null,
          window_id: windowId,
        };
        focusedSessionId = createSession('word_window_focused', data);
        focusedWindowId = windowId;
        focusedDocumentPath = documentPath ?? null;
        logger.info('[SessionsTracker] Focused session started:', focusedSessionId, 'window:', windowId);
        break;
      }

      case 'APP_UNFOCUSED': {
        closeFocusedSession();
        break;
      }

      case 'APP_TERMINATED': {
        const pid = event.app.pid;

        // Close focused session if the focused window belongs to this app
        if (focusedWindowId) {
          const focusedPid = windowToApp.get(focusedWindowId);
          if (focusedPid === pid) {
            closeFocusedSession();
          }
        }

        // Close text_change sessions and clean up windowToApp for this pid
        for (const [windowId, appPid] of windowToApp) {
          if (appPid === pid) {
            const textChangeEntry = textChangeSessions.get(windowId);
            if (textChangeEntry) {
              closeSession(textChangeEntry.sessionId);
              textChangeSessions.delete(windowId);
            }
            windowToApp.delete(windowId);
          }
        }
        break;
      }

      case 'WINDOW_CREATED':
      case 'WINDOW_EXISTING': {
        const windowId = event.window.id;
        const pid = event.app.pid;
        windowToApp.set(windowId, pid);
        break;
      }

      case 'WINDOW_DOCUMENT_PATH_CHANGED': {
        const windowId = event.window.id;
        const newDocumentPath = event.window.documentPath;

        // Only act if this is the focused window
        if (windowId === focusedWindowId && focusedSessionId) {
          if (focusedDocumentPath === null && newDocumentPath) {
            // null → path: update existing session's data
            const projectFile = lookupProjectFile(newDocumentPath);
            const data = JSON.stringify({
              document_path: newDocumentPath,
              project_id: projectFile?.project_id ?? null,
              project_file_id: projectFile?.project_file_id ?? null,
              window_id: windowId,
            });
            sessionDb.updateSessionData.run(data, now(), focusedSessionId);
            focusedDocumentPath = newDocumentPath;
            logger.info('[SessionsTracker] Focused session data updated (null→path):', focusedSessionId);
          } else if (focusedDocumentPath !== null && newDocumentPath) {
            // path → path: close + reopen
            closeFocusedSession();

            const projectFile = lookupProjectFile(newDocumentPath);
            const data: Record<string, unknown> = {
              document_path: newDocumentPath,
              project_id: projectFile?.project_id ?? null,
              project_file_id: projectFile?.project_file_id ?? null,
              window_id: windowId,
            };
            focusedSessionId = createSession('word_window_focused', data);
            focusedWindowId = windowId;
            focusedDocumentPath = newDocumentPath;
            logger.info('[SessionsTracker] Focused session reopened (path→path):', focusedSessionId);
          }
        }
        break;
      }

      case 'WINDOW_DESTROYED': {
        const windowId = event.window.id;

        // Close focused session if it was the destroyed window
        if (windowId === focusedWindowId) {
          closeFocusedSession();
        }

        const textChangeEntry = textChangeSessions.get(windowId);
        if (textChangeEntry) {
          closeSession(textChangeEntry.sessionId);
          textChangeSessions.delete(windowId);
        }
        windowToApp.delete(windowId);
        break;
      }

      case 'WINDOW_DOCUMENT_TEXT_CHANGED': {
        const windowId = event.window.id;
        const eventTime = Date.now();
        const existing = textChangeSessions.get(windowId);

        if (existing && (eventTime - existing.lastEventTime) < TEXT_CHANGE_SESSION_GAP_MS) {
          // Extend existing session
          closeSession(existing.sessionId);
          textChangeSessions.set(windowId, { sessionId: existing.sessionId, lastEventTime: eventTime });
        } else {
          // Gap exceeded or no existing session — start new session
          const documentPath = event.window.documentPath;
          const projectFile = lookupProjectFile(documentPath);
          const data: Record<string, unknown> = {
            document_path: documentPath ?? null,
            project_id: projectFile?.project_id ?? null,
            project_file_id: projectFile?.project_file_id ?? null,
            window_id: windowId,
          };
          const sessionId = createSession('document_text_change', data);
          textChangeSessions.set(windowId, { sessionId, lastEventTime: eventTime });
          logger.info('[SessionsTracker] Document text change session started:', sessionId, 'window:', windowId);
        }
        break;
      }

      default:
        break;
    }
  }

  // --- Periodic flush ---

  function startPeriodicFlush(intervalMs: number): void {
    if (flushInterval) {
      clearInterval(flushInterval);
    }
    flushInterval = setInterval(() => {
      extendActiveSessions();
    }, intervalMs);
  }

  function stopPeriodicFlush(): void {
    if (flushInterval) {
      clearInterval(flushInterval);
      flushInterval = null;
    }
  }

  function fetchSessionsToSync(): SessionRow[] {
    return sessionDb.getUnsyncedSessions.all() as SessionRow[];
  }

  function updateSessionSyncTime(sessionIds: string[]): void {
    const timestamp = now();
    for (const id of sessionIds) {
      sessionDb.markSynced.run(timestamp, id);
    }
  }

  function extendActiveSessions(): void {
    const timestamp = now();
    if (appSessionId) {
      sessionDb.updateEndTime.run(timestamp, timestamp, appSessionId);
    }
    if (focusedSessionId) {
      sessionDb.updateEndTime.run(timestamp, timestamp, focusedSessionId);
    }
  }

  return {
    recordAppStarted,
    recordUserLoggedIn,
    recordUserLoggedOut,
    recordAppStopping,
    processEvent,
    startPeriodicFlush,
    stopPeriodicFlush,
    fetchSessionsToSync,
    updateSessionSyncTime,
  };
}
