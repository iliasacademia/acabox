import { defaultLogger as logger } from './utils/logger';
import type { ActivityTracker } from './activityTrackerFactory';

let syncInterval: ReturnType<typeof setInterval> | null = null;

function syncSessions(tracker: ActivityTracker): void {
  const sessions = tracker.fetchSessionsToSync();
  if (sessions.length === 0) return;

  // TODO: Replace with actual API call when backend endpoint is ready
  logger.info(`[SessionSync] ${sessions.length} session(s) pending sync`);
}

function start(tracker: ActivityTracker, intervalMs: number): void {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(() => { syncSessions(tracker); }, intervalMs);
}

function stop(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

export const sessionSyncService = {
  start,
  stop,
  syncNow: syncSessions,
};
