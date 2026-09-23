import { getDatabase } from './database';

/** Placeholder title a session row is created with (matches the schema default). */
export const DEFAULT_SESSION_TITLE = 'New Chat';

export interface Session {
  id: string;
  /** Owning workspace; every reader that resolves an id typed by a user or an agent must check it. */
  workspace_id: string;
  sdk_session_id: string | null;
  title: string;
  source: string | null;
  document_path: string | null;
  /** Mini-app this chat belongs to, or null for a general chat. */
  app_dir_name: string | null;
  /** Model the first turn actually ran on; null until that turn completes. */
  model: string | null;
  /** Reasoning-effort level sent on the first turn; null for pre-existing rows. */
  effort: string | null;
  /** 1 when a turn finished while nobody was looking at this chat. See `main/chatActivity.ts`. */
  unread: number;
  created_at: string;
  updated_at: string;
}

/** A session plus the timestamp of its most recent message (null when empty). */
export interface SessionWithActivity extends Session {
  last_message_at: string | null;
}

export interface Message {
  id: number;
  session_id: string;
  type: string;
  content: string;
  message_id: string | null;
  created_at: string;
}

export function createSession(
  id: string,
  workspaceId: string,
  source: string | null = null,
  documentPath: string | null = null,
  appDirName: string | null = null,
): void {
  getDatabase()
    .prepare(
      'INSERT OR IGNORE INTO sessions (id, workspace_id, source, document_path, app_dir_name) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, workspaceId, source, documentPath, appDirName);
}

/**
 * Link an existing session to a mini-app. Only fills a NULL `app_dir_name`, so
 * a chat can't be silently re-homed to a different tool — used both to link a
 * chat the moment it scaffolds/opens a tool, and to backfill the link for
 * chats created before `app_dir_name` was populated.
 *
 * Returns whether this call actually wrote the column (false when the row
 * already carried a different app_dir_name, or didn't exist).
 */
export function setSessionAppDirName(id: string, appDirName: string): boolean {
  const info = getDatabase()
    .prepare('UPDATE sessions SET app_dir_name = ? WHERE id = ? AND app_dir_name IS NULL')
    .run(appDirName, id);
  return info.changes > 0;
}

/**
 * Pin the model/effort a conversation runs on. Write-once per column: a value
 * already recorded is never overwritten, so later turns can't silently change
 * what the chat claims (and what it actually uses) mid-conversation.
 */
export function setSessionModelInfo(
  id: string,
  info: { model?: string | null; effort?: string | null },
): void {
  const db = getDatabase();
  if (info.model) {
    db.prepare('UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL').run(info.model, id);
  }
  if (info.effort) {
    db.prepare('UPDATE sessions SET effort = ? WHERE id = ? AND effort IS NULL').run(info.effort, id);
  }
}

/**
 * Flag a chat as having news its owner has not seen. Returns whether anything
 * changed, so the caller broadcasts only on a real transition.
 *
 * Limited to `source IS NULL` — the set the Chats list shows — on purpose: an
 * unread flag on a row no list renders would still light the sidebar's
 * "something is unread" dot, pointing at a chat nobody can find.
 */
export function markSessionUnread(id: string): boolean {
  return getDatabase()
    .prepare('UPDATE sessions SET unread = 1 WHERE id = ? AND source IS NULL AND unread = 0')
    .run(id).changes > 0;
}

/** Clear a chat's unread flag. Returns whether it was set. */
export function clearSessionUnread(id: string): boolean {
  return getDatabase()
    .prepare('UPDATE sessions SET unread = 0 WHERE id = ? AND unread = 1')
    .run(id).changes > 0;
}

/** Every chat the Chats list would show that carries unread news. */
export function listUnreadSessionIds(): string[] {
  return (getDatabase()
    .prepare('SELECT id FROM sessions WHERE unread = 1 AND source IS NULL')
    .all() as { id: string }[]).map((r) => r.id);
}

/**
 * Pre-create or upgrade a session row to be scoped to a document.
 * Used by surfaces that want a chat to appear in the per-document overlay
 * list (e.g. Writing Agent flow) before the agent has streamed a message.
 * - If the row doesn't exist: inserts it with the document path.
 * - If the row exists with no document_path: fills it in.
 * - If the row already has a different document_path: leaves it alone.
 */
export function setSessionDocumentPath(
  id: string,
  workspaceId: string,
  documentPath: string,
): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, workspace_id, document_path) VALUES (?, ?, ?)',
  ).run(id, workspaceId, documentPath);
  db.prepare(
    'UPDATE sessions SET document_path = ? WHERE id = ? AND document_path IS NULL',
  ).run(documentPath, id);
}

export function getSession(id: string): Session | undefined {
  return getDatabase()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as Session | undefined;
}

export function listSessions(workspaceId?: string, source?: string, documentPath?: string): Session[] {
  const sourceClause = source !== undefined ? 'source = ?' : 'source IS NULL';
  const docClause = documentPath !== undefined ? ' AND document_path = ?' : '';
  const workspaceClause = workspaceId !== undefined ? 'workspace_id = ? AND ' : '';
  const sql = `SELECT * FROM sessions WHERE ${workspaceClause}${sourceClause}${docClause} ORDER BY updated_at DESC`;
  const params: unknown[] = [];
  if (workspaceId !== undefined) params.push(workspaceId);
  if (source !== undefined) params.push(source);
  if (documentPath !== undefined) params.push(documentPath);
  return getDatabase().prepare(sql).all(...params) as Session[];
}

/**
 * Variant of listSessions that filters `document_path` against a SQL LIKE
 * pattern instead of an exact match. Used by hosts whose document_path
 * shares a stable prefix (e.g. Apple Notes' `applenotes://%`) so the overlay
 * can show all chats for the host when the active document isn't pinned yet.
 */
export function listSessionsByDocPathLike(workspaceId: string | undefined, source: string | undefined, documentPathLike: string): Session[] {
  const sourceClause = source !== undefined ? 'source = ?' : 'source IS NULL';
  const workspaceClause = workspaceId !== undefined ? 'workspace_id = ? AND ' : '';
  const sql = `SELECT * FROM sessions WHERE ${workspaceClause}${sourceClause} AND document_path LIKE ? ORDER BY updated_at DESC`;
  const params: unknown[] = [];
  if (workspaceId !== undefined) params.push(workspaceId);
  if (source !== undefined) params.push(source);
  params.push(documentPathLike);
  return getDatabase().prepare(sql).all(...params) as Session[];
}

/**
 * Every chat belonging to a mini-app, most recently active first.
 *
 * Ordered by the timestamp of the newest message rather than `updated_at`:
 * `updateSessionTitle` also bumps `updated_at`, so renaming a chat would
 * otherwise jump it to the top of the list. Chats with no messages yet fall
 * back to their creation time.
 */
export function listSessionsForApp(workspaceId: string, appDirName: string): SessionWithActivity[] {
  return getDatabase()
    .prepare(`
      SELECT s.*, MAX(m.created_at) AS last_message_at
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.workspace_id = ? AND s.app_dir_name = ?
      GROUP BY s.id
      ORDER BY COALESCE(MAX(m.created_at), s.created_at) DESC
    `)
    .all(workspaceId, appDirName) as SessionWithActivity[];
}

/** Message count plus the newest message's timestamp, for one session. */
export interface SessionActivity {
  messageCount: number;
  lastMessageAt: string | null;
}

export function getSessionActivity(sessionId: string): SessionActivity {
  const row = getDatabase()
    .prepare('SELECT COUNT(id) AS n, MAX(created_at) AS last FROM messages WHERE session_id = ?')
    .get(sessionId) as { n: number; last: string | null } | undefined;
  return { messageCount: row?.n ?? 0, lastMessageAt: row?.last ?? null };
}

export interface SessionWithCounts extends SessionWithActivity {
  message_count: number;
}

/**
 * Ordinary chats (`source IS NULL`, the same set the Chats list shows) in a
 * workspace, most recently active first, optionally filtered by a
 * case-insensitive title substring. Backs the agent's `list_chats` tool
 * (`main/chatReference.ts`), so `limit` is clamped here rather than trusted.
 */
export function listSessionsWithActivity(
  workspaceId: string,
  opts: { query?: string; limit?: number } = {},
): SessionWithCounts[] {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 20), 50));
  const query = opts.query?.trim();
  // `_` and `%` are LIKE wildcards; escape them so a literal title search is literal.
  const like = query ? `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const sql = `
      SELECT s.*, MAX(m.created_at) AS last_message_at, COUNT(m.id) AS message_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.workspace_id = ? AND s.source IS NULL${like ? " AND s.title LIKE ? ESCAPE '\\'" : ''}
      GROUP BY s.id
      ORDER BY COALESCE(MAX(m.created_at), s.created_at) DESC
      LIMIT ?
    `;
  const params: unknown[] = [workspaceId];
  if (like) params.push(like);
  params.push(limit);
  return getDatabase().prepare(sql).all(...params) as SessionWithCounts[];
}

/** Number of persisted messages in a session. 0 means the chat has never run a turn. */
export function countMessages(sessionId: string): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .get(sessionId) as { n: number } | undefined;
  return row?.n ?? 0;
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

/**
 * Drops the SDK conversation id so the next turn starts a fresh agent session
 * instead of resuming. This is the only recovery from a transcript that no
 * longer fits the context window: the oversized history lives in the file
 * `resumeSessionId` points at, so every later turn replays it and is rejected
 * identically no matter what the user types. The chat's own history (this
 * table) is untouched — only the agent's memory of it is dropped.
 */
export function clearSdkSessionId(id: string): void {
  getDatabase()
    .prepare('UPDATE sessions SET sdk_session_id = NULL WHERE id = ?')
    .run(id);
}

export function insertMessage(
  sessionId: string,
  type: string,
  content: string,
  messageId?: string,
): number {
  const result = getDatabase()
    .prepare(
      'INSERT INTO messages (session_id, type, content, message_id) VALUES (?, ?, ?, ?)',
    )
    .run(sessionId, type, content, messageId ?? null);

  // Touch the session's updated_at
  getDatabase()
    .prepare(
      "UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?",
    )
    .run(sessionId);

  return result.lastInsertRowid as number;
}

/**
 * Look up an existing user-message row by its renderer-generated messageId.
 * Used to dedupe `chat:send` invocations when a reload re-fires the same
 * logical message. Returns undefined if no such row exists.
 */
export function findMessageByMessageId(
  sessionId: string,
  messageId: string,
): Message | undefined {
  return getDatabase()
    .prepare('SELECT * FROM messages WHERE session_id = ? AND message_id = ? LIMIT 1')
    .get(sessionId, messageId) as Message | undefined;
}

/**
 * Delete `assistant` and `tool_result` rows that follow the most recent
 * `result` row in a session. These are the rows produced mid-turn before a
 * crash/restart left the turn unfinished — without cleanup the renderer
 * shows a tool-use spinner forever. User rows are preserved so the user
 * can still see what they asked even if no reply landed.
 *
 * Called at AgentSession startup before any new turn begins. Caller is
 * expected to log the row count when nonzero.
 */
export function cleanupOrphanTurnRows(sessionId: string): number {
  const lastResult = getDatabase()
    .prepare("SELECT MAX(id) as maxId FROM messages WHERE session_id = ? AND type = 'result'")
    .get(sessionId) as { maxId: number | null } | undefined;
  const cursor = lastResult?.maxId ?? 0;

  const result = getDatabase()
    .prepare(`
      DELETE FROM messages
      WHERE session_id = ?
        AND id > ?
        AND type IN ('assistant', 'tool_result')
    `)
    .run(sessionId, cursor);

  return result.changes as number;
}

export function deleteSession(id: string): void {
  getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/**
 * Every SDK conversation id a chat still points at. This is the full set of
 * transcripts that are still reachable — resume only ever names a value from
 * this column — so anything on disk that is not in here is orphaned.
 */
export function listSdkSessionIds(): string[] {
  return (
    getDatabase()
      .prepare('SELECT sdk_session_id FROM sessions WHERE sdk_session_id IS NOT NULL')
      .all() as { sdk_session_id: string }[]
  ).map((r) => r.sdk_session_id);
}

export function getMessages(sessionId: string): Message[] {
  return getDatabase()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Message[];
}

/**
 * Find the most recent session associated with a mini app by searching for:
 * 1. Assistant messages with open_mini_application/manage_mini_app.mjs tool
 *    calls containing the dir_name
 * 2. User messages with the synthetic context message for the app
 * 3. tool_result rows carrying the scaffold script's own JSON output
 *    (`{"dir_name":"<dirName>", ...}`) — the scaffold command line only ever
 *    carries the tool's *display* name, so a chat that ran
 *    `manage_mini_app.mjs --name "..."` and nothing else matches neither (1)
 *    nor (2); the dir name only ever appears in the script's printed result.
 * Returns the session ID or undefined if not found.
 *
 * This is the fallback path for databases predating `appChatLink.ts`'s
 * deterministic, at-the-moment linking in `agentSession.ts` — new chats are
 * linked directly via `setSessionAppDirName` and never need this scan.
 */
export function findSessionForApp(workspaceId: string, dirName: string): string | undefined {
  const db = getDatabase();

  // The marker text is stored inside JSON.stringify output, so quotes around
  // the dirName are escaped as \" in the stored content. Match accordingly.
  const marker = `connected to the application \\"${dirName}\\"`;
  // Same escaping applies to the scaffold script's tool_result JSON: the
  // stored content is JSON.stringify(contentArray), and the inner `content`
  // string is itself JSON, so the literal bytes on disk are
  // \"dir_name\":\"<dirName>\".
  const dirNameJsonMarker = `%\\"dir_name\\":\\"${dirName}\\"%`;
  // Matching `manage_mini_app.mjs` in addition to `open_mini_application` lets
  // us recover the creating thread for a tool whose agent hasn't yet called
  // open_mini_application — needed for tool.created attribution at the
  // first-open moment, before the agent has gotten around to opening it.
  const row = db.prepare(`
    SELECT m.session_id, m.id as message_id
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE s.workspace_id = ?
      AND (
        (m.type = 'assistant'
          AND (m.content LIKE '%open_mini_application%' OR m.content LIKE '%manage_mini_app.mjs%')
          AND m.content LIKE ?)
        OR (m.type = 'user' AND m.content LIKE ?)
        OR (m.type = 'tool_result' AND m.content LIKE ?)
      )
    ORDER BY m.id DESC
    LIMIT 1
  `).get(workspaceId, `%${dirName}%`, `%${marker}%`, dirNameJsonMarker) as { session_id: string; message_id: number } | undefined;

  return row?.session_id;
}
