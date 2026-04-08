import { getObservationsDatabase } from '../db/observationsDatabase';
import type { ReadingSession } from './types';

let stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements() {
  const db = getObservationsDatabase();
  return {
    upsert: db.prepare(`
      INSERT INTO browser_sessions
        (url, title, referrer, meta_tags, full_text, text_hash, first_seen, last_snapshot,
         total_dwell, max_scroll_depth, snapshot_count, triage_state, app_version, session_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, session_date) DO UPDATE SET
        title = excluded.title,
        referrer = excluded.referrer,
        meta_tags = excluded.meta_tags,
        full_text = excluded.full_text,
        text_hash = excluded.text_hash,
        last_snapshot = excluded.last_snapshot,
        total_dwell = excluded.total_dwell,
        max_scroll_depth = excluded.max_scroll_depth,
        snapshot_count = excluded.snapshot_count,
        triage_state = excluded.triage_state,
        app_version = excluded.app_version
    `),
    getIdByUrlAndDate: db.prepare(`
      SELECT id FROM browser_sessions WHERE url = ? AND session_date = ?
    `),
    getAll: db.prepare('SELECT * FROM browser_sessions'),
    deleteByUrl: db.prepare('DELETE FROM browser_sessions WHERE url = ?'),
    getByTimeRange: db.prepare(`
      SELECT id, url, title, session_date, first_seen, last_snapshot,
             total_dwell, max_scroll_depth, snapshot_count
      FROM browser_sessions
      WHERE last_snapshot >= ? AND last_snapshot <= ?
      ORDER BY last_snapshot DESC
    `),
    getByTimeRangeWithSearch: db.prepare(`
      SELECT id, url, title, session_date, first_seen, last_snapshot,
             total_dwell, max_scroll_depth, snapshot_count
      FROM browser_sessions
      WHERE last_snapshot >= ? AND last_snapshot <= ?
        AND (title LIKE '%' || ? || '%' ESCAPE '\' OR url LIKE '%' || ? || '%' ESCAPE '\')
      ORDER BY last_snapshot DESC
    `),
  };
}

function getStmts() {
  if (!stmts) stmts = prepareStatements();
  return stmts;
}

export function upsertSession(session: ReadingSession): number {
  getStmts().upsert.run(
    session.url,
    session.title,
    session.referrer,
    JSON.stringify(session.meta_tags),
    null, // full_text stored in session files on disk
    session.text_hash,
    session.first_seen,
    session.last_snapshot,
    session.total_dwell,
    session.max_scroll_depth,
    session.snapshot_count,
    session.triage_state,
    session.app_version,
    session.session_date,
  );
  const row = getStmts().getIdByUrlAndDate.get(session.url, session.session_date) as { id: number };
  return row.id;
}

export function getAllSessions(): ReadingSession[] {
  const rows = getStmts().getAll.all() as any[];
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    referrer: row.referrer,
    meta_tags: JSON.parse(row.meta_tags),
    full_text: null, // full_text stored in session files on disk
    text_hash: row.text_hash,
    first_seen: row.first_seen,
    last_snapshot: row.last_snapshot,
    total_dwell: row.total_dwell,
    max_scroll_depth: row.max_scroll_depth,
    snapshot_count: row.snapshot_count,
    triage_state: row.triage_state,
    app_version: row.app_version,
    session_date: row.session_date,
  }));
}

export function deleteSession(url: string): void {
  getStmts().deleteByUrl.run(url);
}

export interface BrowserSessionSummary {
  id: number;
  url: string;
  title: string;
  session_date: string;
  first_seen: string;
  last_snapshot: string;
  total_dwell: number;
  max_scroll_depth: number;
  snapshot_count: number;
}

export function getBrowserSessionsByTimeRange(
  since: string,
  until: string,
  search?: string,
): BrowserSessionSummary[] {
  let rows: any[];
  const escapedSearch = search ? search.replace(/[%_\\]/g, '\\$&') : undefined;
  if (escapedSearch) {
    rows = getStmts().getByTimeRangeWithSearch.all(since, until, escapedSearch, escapedSearch) as any[];
  } else {
    rows = getStmts().getByTimeRange.all(since, until) as any[];
  }
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    session_date: row.session_date,
    first_seen: row.first_seen,
    last_snapshot: row.last_snapshot,
    total_dwell: row.total_dwell,
    max_scroll_depth: row.max_scroll_depth,
    snapshot_count: row.snapshot_count,
  }));
}
