import { defaultLogger as logger } from './utils/logger';
import { APIclient, getCsrfToken } from './apiClient';
import type { SessionsTracker } from './sessionsTrackerFactory';

const MAX_BATCH_SIZE = 1000;

let syncInterval: ReturnType<typeof setInterval> | null = null;

async function syncSessions(tracker: SessionsTracker): Promise<void> {
  try {
    const sessions = tracker.fetchSessionsToSync();
    if (sessions.length === 0) return;

    // Sort by start_time ascending, take first batch
    const sorted = [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    const batch = sorted.slice(0, MAX_BATCH_SIZE);

    const payload = batch.map((s) => ({
      session_id: s.session_id,
      session_type: s.session_type,
      start_time: s.start_time,
      end_time: s.end_time,
      data: JSON.parse(s.data),
      device_id: s.device_id,
      app_version: s.app_version,
      client_created_at: s.created_at,
      client_updated_at: s.updated_at,
    }));

    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    await client.post('/v0/co_scientist/sessions/sync', { sessions: payload }, {
      headers: { 'x-csrf-token': csrfToken },
    });

    const syncedIds = batch.map((s) => s.session_id);
    tracker.updateSessionSyncTime(syncedIds);
    logger.info(`[SessionSync] Synced ${batch.length} session(s)`);

    if (sessions.length > MAX_BATCH_SIZE) {
      logger.warn(`[SessionSync] ${sessions.length} sessions pending — only synced first ${MAX_BATCH_SIZE}. This is anomalous.`);
    }
  } catch (error) {
    logger.error('[SessionSync] Sync failed:', error);
  }
}

function start(tracker: SessionsTracker, intervalMs: number): void {
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
