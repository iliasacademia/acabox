import { getObservationsDatabase } from '../db/observationsDatabase';

export interface FileSession {
  id?: number;
  document_url: string;
  app_name: string;
  app_bundle_id: string;
  window_title: string | null;
  session_date: string;
  first_seen: string;
  last_seen: string;
  poll_count: number;
  total_dwell: number;
  app_version: string;
  snapshot_ulid: string | null;
}

let stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements() {
  const db = getObservationsDatabase();
  return {
    insert: db.prepare(`
      INSERT INTO file_sessions (document_url, app_name, app_bundle_id, window_title, session_date, first_seen, last_seen, poll_count, total_dwell, app_version, snapshot_ulid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE file_sessions SET last_seen = ?, poll_count = poll_count + 1, window_title = ?, total_dwell = total_dwell + ? WHERE id = ?
    `),
    findByUrlAndDate: db.prepare(`
      SELECT * FROM file_sessions WHERE document_url = ? AND session_date = ?
    `),
    getAll: db.prepare('SELECT * FROM file_sessions ORDER BY last_seen DESC'),
    getByTimeRange: db.prepare(`
      SELECT id, document_url, app_name, window_title, session_date, first_seen, last_seen, poll_count, total_dwell
      FROM file_sessions
      WHERE last_seen >= ? AND last_seen <= ?
      ORDER BY last_seen DESC
    `),
    getByTimeRangeWithSearch: db.prepare(`
      SELECT id, document_url, app_name, window_title, session_date, first_seen, last_seen, poll_count, total_dwell
      FROM file_sessions
      WHERE last_seen >= ? AND last_seen <= ?
        AND (window_title LIKE '%' || ? || '%' OR document_url LIKE '%' || ? || '%')
      ORDER BY last_seen DESC
    `),
  };
}

function getStmts() {
  if (!stmts) stmts = prepareStatements();
  return stmts;
}

export function findFileSession(documentUrl: string, sessionDate: string): FileSession | undefined {
  return getStmts().findByUrlAndDate.get(documentUrl, sessionDate) as FileSession | undefined;
}

export function createFileSession(session: Omit<FileSession, 'id'>): number {
  const result = getStmts().insert.run(
    session.document_url,
    session.app_name,
    session.app_bundle_id,
    session.window_title,
    session.session_date,
    session.first_seen,
    session.last_seen,
    session.poll_count,
    session.total_dwell,
    session.app_version,
    session.snapshot_ulid,
  );
  return result.lastInsertRowid as number;
}

export function updateFileSession(id: number, lastSeen: string, windowTitle: string | null, dwellIncrement: number): void {
  getStmts().update.run(lastSeen, windowTitle, dwellIncrement, id);
}

export function getAllFileSessions(): FileSession[] {
  return getStmts().getAll.all() as FileSession[];
}

export interface FileSessionSummary {
  id: number;
  document_url: string;
  app_name: string;
  window_title: string | null;
  session_date: string;
  first_seen: string;
  last_seen: string;
  poll_count: number;
  total_dwell: number;
}

export function getFileSessionsByTimeRange(
  since: string,
  until: string,
  search?: string,
): FileSessionSummary[] {
  if (search) {
    return getStmts().getByTimeRangeWithSearch.all(since, until, search, search) as FileSessionSummary[];
  }
  return getStmts().getByTimeRange.all(since, until) as FileSessionSummary[];
}
