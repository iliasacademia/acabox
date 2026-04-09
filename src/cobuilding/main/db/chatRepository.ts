import { getDatabase } from './database';

export interface Session {
  id: string;
  sdk_session_id: string | null;
  title: string;
  source: string | null;
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

export function createSession(id: string, workspaceId: string, source: string | null = null): void {
  getDatabase()
    .prepare('INSERT OR IGNORE INTO sessions (id, workspace_id, source) VALUES (?, ?, ?)')
    .run(id, workspaceId, source);
}

export function getSession(id: string): Session | undefined {
  return getDatabase()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as Session | undefined;
}

export function listSessions(workspaceId: string, source?: string): Session[] {
  if (source !== undefined) {
    return getDatabase()
      .prepare('SELECT * FROM sessions WHERE workspace_id = ? AND source = ? ORDER BY updated_at DESC')
      .all(workspaceId, source) as Session[];
  }
  return getDatabase()
    .prepare('SELECT * FROM sessions WHERE workspace_id = ? AND source IS NULL ORDER BY updated_at DESC')
    .all(workspaceId) as Session[];
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
