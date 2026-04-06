import { getDatabase } from '../db/database';

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
  app_version: string;
  snapshot_ulid: string | null;
}

let stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements() {
  const db = getDatabase();
  return {
    insert: db.prepare(`
      INSERT INTO file_sessions (document_url, app_name, app_bundle_id, window_title, session_date, first_seen, last_seen, poll_count, app_version, snapshot_ulid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE file_sessions SET last_seen = ?, poll_count = poll_count + 1, window_title = ? WHERE id = ?
    `),
    findByUrlAndDate: db.prepare(`
      SELECT * FROM file_sessions WHERE document_url = ? AND session_date = ?
    `),
    getAll: db.prepare('SELECT * FROM file_sessions ORDER BY last_seen DESC'),
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
    session.app_version,
    session.snapshot_ulid,
  );
  return result.lastInsertRowid as number;
}

export function updateFileSession(id: number, lastSeen: string, windowTitle: string | null): void {
  getStmts().update.run(lastSeen, windowTitle, id);
}

export function getAllFileSessions(): FileSession[] {
  return getStmts().getAll.all() as FileSession[];
}
