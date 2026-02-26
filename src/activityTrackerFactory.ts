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
}

export interface ActivityTracker {
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

export function createActivityTracker(sessionDb: SessionDb): ActivityTracker {
  let currentUserId: number | null = null;
  let appSessionId: string | null = null;

  /** pid → word_app session_id */
  const wordAppSessions = new Map<number, string>();

  /** windowId → document session_id */
  const documentSessions = new Map<string, string>();

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
    sessionType: 'app' | 'word_app' | 'document' | 'document_text_change',
    data: Record<string, unknown> = {}
  ): string {
    const id = ulid();
    const timestamp = now();
    sessionDb.insertSession.run(id, sessionType, currentUserId, timestamp, timestamp, JSON.stringify(data), getDeviceId(), timestamp, timestamp);
    return id;
  }

  function closeSession(sessionId: string): void {
    const timestamp = now();
    sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
  }

  // --- App lifecycle ---

  function recordAppStarted(): void {
    appSessionId = createSession('app');
    logger.info('[ActivityTracker] App session started:', appSessionId);
  }

  function recordUserLoggedIn(userId: number): void {
    currentUserId = userId;
    const timestamp = now();
    if (appSessionId) {
      sessionDb.setUserId.run(userId, timestamp, appSessionId);
    }
    for (const sessionId of wordAppSessions.values()) {
      sessionDb.setUserId.run(userId, timestamp, sessionId);
    }
    for (const sessionId of documentSessions.values()) {
      sessionDb.setUserId.run(userId, timestamp, sessionId);
    }
    for (const { sessionId } of textChangeSessions.values()) {
      sessionDb.setUserId.run(userId, timestamp, sessionId);
    }
    logger.info('[ActivityTracker] User logged in:', userId);
  }

  function recordUserLoggedOut(): void {
    if (appSessionId) {
      closeSession(appSessionId);
      appSessionId = null;
    }
    for (const sessionId of wordAppSessions.values()) {
      closeSession(sessionId);
    }
    wordAppSessions.clear();
    for (const sessionId of documentSessions.values()) {
      closeSession(sessionId);
    }
    documentSessions.clear();
    for (const { sessionId } of textChangeSessions.values()) {
      closeSession(sessionId);
    }
    textChangeSessions.clear();
    windowToApp.clear();

    currentUserId = null;

    appSessionId = createSession('app');
    logger.info('[ActivityTracker] User logged out. New app session:', appSessionId);
  }

  function recordAppStopping(): void {
    const timestamp = now();
    if (appSessionId) {
      sessionDb.updateEndTime.run(timestamp, timestamp, appSessionId);
      appSessionId = null;
    }
    for (const sessionId of wordAppSessions.values()) {
      sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
    }
    wordAppSessions.clear();
    for (const sessionId of documentSessions.values()) {
      sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
    }
    documentSessions.clear();
    for (const { sessionId } of textChangeSessions.values()) {
      sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
    }
    textChangeSessions.clear();
    windowToApp.clear();
    logger.info('[ActivityTracker] App stopping — all sessions closed');
  }

  // --- Window monitor events ---

  function processEvent(event: WindowMonitorEvent): void {
    switch (event.event) {
      case 'APP_LAUNCHED':
      case 'APP_EXISTING': {
        const pid = event.app.pid;
        if (!wordAppSessions.has(pid)) {
          const sessionId = createSession('word_app');
          wordAppSessions.set(pid, sessionId);
          logger.info('[ActivityTracker] Word app session started:', sessionId, 'pid:', pid);
        }
        break;
      }

      case 'APP_TERMINATED': {
        const pid = event.app.pid;
        const wordSessionId = wordAppSessions.get(pid);
        if (wordSessionId) {
          closeSession(wordSessionId);
          wordAppSessions.delete(pid);
          logger.info('[ActivityTracker] Word app session closed:', wordSessionId);
        }
        for (const [windowId, appPid] of windowToApp) {
          if (appPid === pid) {
            const docSessionId = documentSessions.get(windowId);
            if (docSessionId) {
              closeSession(docSessionId);
              documentSessions.delete(windowId);
              logger.info('[ActivityTracker] Document session closed (app terminated):', docSessionId);
            }
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
        const documentPath = event.window.documentPath;
        const pid = event.app.pid;
        windowToApp.set(windowId, pid);

        if (documentPath) {
          openDocumentSession(windowId, documentPath);
        }
        break;
      }

      case 'WINDOW_DOCUMENT_PATH_CHANGED': {
        const windowId = event.window.id;
        const newDocumentPath = event.window.documentPath;

        const existingSessionId = documentSessions.get(windowId);
        if (existingSessionId) {
          closeSession(existingSessionId);
          documentSessions.delete(windowId);
          logger.info('[ActivityTracker] Document session closed (path changed):', existingSessionId);
        }

        if (newDocumentPath) {
          openDocumentSession(windowId, newDocumentPath);
        }
        break;
      }

      case 'WINDOW_DESTROYED': {
        const windowId = event.window.id;
        const docSessionId = documentSessions.get(windowId);
        if (docSessionId) {
          closeSession(docSessionId);
          documentSessions.delete(windowId);
          logger.info('[ActivityTracker] Document session closed (window destroyed):', docSessionId);
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
          const projectFile = documentPath
            ? wordIntegrationDataStoreV2.getProjectFileForPath(documentPath)
            : null;
          const data: Record<string, unknown> = {
            document_path: documentPath ?? null,
            project_id: projectFile?.project_id ?? null,
            project_file_id: projectFile?.project_file_id ?? null,
            window_id: windowId,
          };
          const sessionId = createSession('document_text_change', data);
          textChangeSessions.set(windowId, { sessionId, lastEventTime: eventTime });
          logger.info('[ActivityTracker] Document text change session started:', sessionId, 'window:', windowId);
        }
        break;
      }

      default:
        break;
    }
  }

  function openDocumentSession(windowId: string, documentPath: string): void {
    const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(documentPath);
    const data: Record<string, unknown> = {
      document_path: documentPath,
      project_id: projectFile?.project_id ?? null,
      project_file_id: projectFile?.project_file_id ?? null,
      window_id: windowId,
    };
    const sessionId = createSession('document', data);
    documentSessions.set(windowId, sessionId);
    logger.info('[ActivityTracker] Document session started:', sessionId, 'path:', documentPath);
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
    for (const sessionId of wordAppSessions.values()) {
      sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
    }
    for (const sessionId of documentSessions.values()) {
      sessionDb.updateEndTime.run(timestamp, timestamp, sessionId);
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
