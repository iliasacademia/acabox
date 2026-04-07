import { app } from 'electron';
import log from 'electron-log';
import type { SnapshotPayload, ReadingSession } from './types';
import { upsertSession, getAllSessions } from './repository';

function toSessionDate(timestamp: string | number): string {
  const d = new Date(typeof timestamp === 'number' ? timestamp * 1000 : timestamp);
  return d.toISOString().slice(0, 10);
}

function sessionKey(url: string, sessionDate: string): string {
  return `${url}|${sessionDate}`;
}

export class SessionAccumulator {
  private sessions = new Map<string, ReadingSession>();

  constructor() {
    try {
      const persisted = getAllSessions();
      for (const session of persisted) {
        this.sessions.set(sessionKey(session.url, session.session_date), session);
      }
      log.info(`[Reactions] Restored ${persisted.length} sessions from DB`);
    } catch (err) {
      log.error('[Reactions] Failed to restore sessions from DB:', err);
    }
  }

  ingestSnapshot(payload: SnapshotPayload): void {
    const date = toSessionDate(payload.timestamp);
    const key = sessionKey(payload.url, date);
    const existing = this.sessions.get(key);

    if (!existing) {
      const session: ReadingSession = {
        url: payload.url,
        title: payload.title,
        referrer: payload.referrer,
        meta_tags: payload.meta_tags,
        full_text: payload.full_text,
        text_hash: payload.text_hash,
        first_seen: payload.timestamp,
        last_snapshot: payload.timestamp,
        total_dwell: payload.dwell_seconds,
        max_scroll_depth: payload.scroll.depth,
        selections: payload.selection ? [payload.selection] : [],
        snapshot_count: 1,
        triage_state: 'pending',
        app_version: app.getVersion(),
        session_date: date,
      };
      this.sessions.set(key, session);
      upsertSession(session);
      log.info('[Reactions] New session:', payload.url);
      return;
    }

    if (payload.full_text !== null) {
      existing.full_text = payload.full_text;
      existing.text_hash = payload.text_hash;
    }

    existing.last_snapshot = payload.timestamp;
    existing.total_dwell = payload.dwell_seconds;
    existing.max_scroll_depth = Math.max(existing.max_scroll_depth, payload.scroll.depth);
    existing.snapshot_count++;

    if (payload.selection) {
      existing.selections.push(payload.selection);
    }

    upsertSession(existing);
  }

  getSessions(): ReadingSession[] {
    return Array.from(this.sessions.values());
  }
}
