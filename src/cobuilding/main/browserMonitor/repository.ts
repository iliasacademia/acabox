import { getObservationsDatabase } from '../db/observationsDatabase';
import type { ReadingSession } from './types';

let stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements() {
  const db = getObservationsDatabase();
  return {
    upsert: db.prepare(`
      INSERT INTO browser_sessions
        (url, title, referrer, meta_tags, full_text, text_hash, first_seen, last_snapshot,
         total_dwell, max_scroll_depth, selections, snapshot_count, triage_state, app_version, session_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, session_date) DO UPDATE SET
        title = excluded.title,
        referrer = excluded.referrer,
        meta_tags = excluded.meta_tags,
        full_text = excluded.full_text,
        text_hash = excluded.text_hash,
        last_snapshot = excluded.last_snapshot,
        total_dwell = excluded.total_dwell,
        max_scroll_depth = excluded.max_scroll_depth,
        selections = excluded.selections,
        snapshot_count = excluded.snapshot_count,
        triage_state = excluded.triage_state,
        app_version = excluded.app_version
    `),
    getAll: db.prepare('SELECT * FROM browser_sessions'),
    deleteByUrl: db.prepare('DELETE FROM browser_sessions WHERE url = ?'),
    getByTimeRange: db.prepare(`
      SELECT id, url, title, session_date, first_seen, last_snapshot,
             total_dwell, max_scroll_depth, selections, snapshot_count
      FROM browser_sessions
      WHERE last_snapshot >= ? AND last_snapshot <= ?
      ORDER BY last_snapshot DESC
    `),
    getByTimeRangeWithSearch: db.prepare(`
      SELECT id, url, title, session_date, first_seen, last_snapshot,
             total_dwell, max_scroll_depth, selections, snapshot_count
      FROM browser_sessions
      WHERE last_snapshot >= ? AND last_snapshot <= ?
        AND (title LIKE '%' || ? || '%' OR url LIKE '%' || ? || '%')
      ORDER BY last_snapshot DESC
    `),
    getByTimeRangeWithContent: db.prepare(`
      SELECT id, url, title, session_date, first_seen, last_snapshot,
             total_dwell, max_scroll_depth, selections, snapshot_count, full_text
      FROM browser_sessions
      WHERE last_snapshot >= ? AND last_snapshot <= ?
      ORDER BY last_snapshot DESC
    `),
    getByTimeRangeWithSearchAndContent: db.prepare(`
      SELECT id, url, title, session_date, first_seen, last_snapshot,
             total_dwell, max_scroll_depth, selections, snapshot_count, full_text
      FROM browser_sessions
      WHERE last_snapshot >= ? AND last_snapshot <= ?
        AND (title LIKE '%' || ? || '%' OR url LIKE '%' || ? || '%')
      ORDER BY last_snapshot DESC
    `),
  };
}

function getStmts() {
  if (!stmts) stmts = prepareStatements();
  return stmts;
}

export function upsertSession(session: ReadingSession): void {
  getStmts().upsert.run(
    session.url,
    session.title,
    session.referrer,
    JSON.stringify(session.meta_tags),
    session.full_text,
    session.text_hash,
    session.first_seen,
    session.last_snapshot,
    session.total_dwell,
    session.max_scroll_depth,
    JSON.stringify(session.selections),
    session.snapshot_count,
    session.triage_state,
    session.app_version,
    session.session_date,
  );
}

export function getAllSessions(): ReadingSession[] {
  const rows = getStmts().getAll.all() as any[];
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    referrer: row.referrer,
    meta_tags: JSON.parse(row.meta_tags),
    full_text: row.full_text,
    text_hash: row.text_hash,
    first_seen: row.first_seen,
    last_snapshot: row.last_snapshot,
    total_dwell: row.total_dwell,
    max_scroll_depth: row.max_scroll_depth,
    selections: JSON.parse(row.selections),
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
  selections: string[];
  snapshot_count: number;
  full_text?: string | null;
}

export function getBrowserSessionsByTimeRange(
  since: string,
  until: string,
  search?: string,
  includeContent?: boolean,
): BrowserSessionSummary[] {
  let rows: any[];
  if (search && includeContent) {
    rows = getStmts().getByTimeRangeWithSearchAndContent.all(since, until, search, search) as any[];
  } else if (search) {
    rows = getStmts().getByTimeRangeWithSearch.all(since, until, search, search) as any[];
  } else if (includeContent) {
    rows = getStmts().getByTimeRangeWithContent.all(since, until) as any[];
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
    selections: JSON.parse(row.selections),
    snapshot_count: row.snapshot_count,
    ...(includeContent ? { full_text: row.full_text } : {}),
  }));
}
