import { getDatabase } from './database';

export interface Session {
  id: string;
  sdk_session_id: string | null;
  title: string;
  source: string | null;
  document_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  session_id: string;
  type: string;
  content: string;
  created_at: string;
}

export function createSession(
  id: string,
  workspaceId: string,
  source: string | null = null,
  documentPath: string | null = null,
): void {
  getDatabase()
    .prepare('INSERT OR IGNORE INTO sessions (id, workspace_id, source, document_path) VALUES (?, ?, ?, ?)')
    .run(id, workspaceId, source, documentPath);
}

export function getSession(id: string): Session | undefined {
  return getDatabase()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as Session | undefined;
}

export function listSessions(workspaceId: string, source?: string, documentPath?: string): Session[] {
  const sourceClause = source !== undefined ? 'source = ?' : 'source IS NULL';
  const docClause = documentPath !== undefined ? ' AND document_path = ?' : '';
  const sql = `SELECT * FROM sessions WHERE workspace_id = ? AND ${sourceClause}${docClause} ORDER BY updated_at DESC`;
  const params: unknown[] = [workspaceId];
  if (source !== undefined) params.push(source);
  if (documentPath !== undefined) params.push(documentPath);
  return getDatabase().prepare(sql).all(...params) as Session[];
}

export function updateSessionTitle(id: string, title: string): void {
  getDatabase()
    .prepare(
      "UPDATE sessions SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?",
    )
    .run(title, id);
}

export function setSdkSessionId(id: string, sdkSessionId: string): void {
  getDatabase()
    .prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?')
    .run(sdkSessionId, id);
}

export function insertMessage(
  sessionId: string,
  type: string,
  content: string,
): number {
  const result = getDatabase()
    .prepare(
      'INSERT INTO messages (session_id, type, content) VALUES (?, ?, ?)',
    )
    .run(sessionId, type, content);

  // Touch the session's updated_at
  getDatabase()
    .prepare(
      "UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?",
    )
    .run(sessionId);

  return result.lastInsertRowid as number;
}

export function deleteSession(id: string): void {
  getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function getMessages(sessionId: string): Message[] {
  return getDatabase()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Message[];
}

/**
 * Find the most recent session associated with a mini app by searching for:
 * 1. Assistant messages with open_mini_application tool calls containing the dir_name
 * 2. User messages with the synthetic context message for the app
 * Returns the session ID or undefined if not found.
 */
export function findSessionForApp(workspaceId: string, dirName: string): string | undefined {
  const db = getDatabase();

  const marker = `connected to the application "${dirName}"`;
  const row = db.prepare(`
    SELECT m.session_id, m.id as message_id
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.workspace_id = ?
      AND (
        (m.type = 'assistant' AND m.content LIKE '%open_mini_application%' AND m.content LIKE ?)
        OR (m.type = 'user' AND m.content LIKE ?)
      )
    ORDER BY m.id DESC
    LIMIT 1
  `).get(workspaceId, `%${dirName}%`, `%${marker}%`) as { session_id: string; message_id: number } | undefined;

  return row?.session_id;
}
