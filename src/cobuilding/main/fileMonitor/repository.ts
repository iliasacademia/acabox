import { getDatabase } from '../db/database';

export interface FileSession {
  id?: number;
  document_url: string;
  app_name: string;
  app_bundle_id: string;
  window_title: string | null;
  first_seen: string;
  last_seen: string;
  poll_count: number;
}

let stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements() {
  const db = getDatabase();
  return {
    insert: db.prepare(`
      INSERT INTO file_sessions (document_url, app_name, app_bundle_id, window_title, first_seen, last_seen, poll_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE file_sessions SET last_seen = ?, poll_count = ?, window_title = ? WHERE id = ?
    `),
    getAll: db.prepare('SELECT * FROM file_sessions ORDER BY last_seen DESC'),
  };
}

function getStmts() {
  if (!stmts) stmts = prepareStatements();
  return stmts;
}

export function createFileSession(session: Omit<FileSession, 'id'>): number {
  const result = getStmts().insert.run(
    session.document_url,
    session.app_name,
    session.app_bundle_id,
    session.window_title,
    session.first_seen,
    session.last_seen,
    session.poll_count,
  );
  return result.lastInsertRowid as number;
}

export function updateFileSession(id: number, lastSeen: string, pollCount: number, windowTitle: string | null): void {
  getStmts().update.run(lastSeen, pollCount, windowTitle, id);
}

export function getAllFileSessions(): FileSession[] {
  return getStmts().getAll.all() as FileSession[];
}
