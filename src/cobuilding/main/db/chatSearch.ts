/**
 * Chat search over message text (docs/design/chat-search.md). Reads the
 * `message_prose` FTS5 index (`./messageProse.ts`, migration 33) that the
 * `messages` triggers keep current — this module never writes to it.
 *
 * Deliberately does NOT import `./chatRepository`: `chatRepository.ts` imports
 * `proseMatchClause` from here to fold message-text matching into
 * `listSessionsWithActivity`, and a reverse import would be a cycle.
 */
import log from 'electron-log';
import { getDatabase } from './database';
import { proseSnippet } from '../../shared/proseSnippet';

export interface ChatPreview {
  sessionId: string;
  userText: string;
  assistantText: string;
}

export interface ProseHit {
  messageId: number;
  role: 'user' | 'assistant';
  createdAt: string;
  snippet: string;
}

export interface ChatProseResult {
  sessionId: string;
  total: number;
  hits: ProseHit[];
}

/**
 * The WHERE fragment (against `message_prose p`, joined into a query that
 * also has `messages m` and `sessions s` in scope) plus its one bound
 * parameter — or `null` for an empty query.
 *
 * Trigram `MATCH` needs >= 3 characters (fewer returns nothing), so a 1-2
 * character query falls back to `LIKE`. That one scans the index's stored
 * text rather than using it (a trigram index cannot answer a 2-char pattern,
 * and `ESCAPE` disables the LIKE optimisation anyway) — acceptable because the
 * prose is small: ~1.5 MB on a 50-chat production DB. FTS5
 * requires the bare table name — not an alias — on the left of `MATCH`, so
 * the two branches address the table differently.
 */
export function proseMatchClause(query: string): { sql: string; param: string } | null {
  const q = query.trim();
  if (!q) return null;

  if ([...q].length >= 3) {
    const phrase = `"${q.replace(/"/g, '""')}"`;
    return { sql: 'message_prose MATCH ?', param: phrase };
  }

  // `_` and `%` are LIKE wildcards; escape them so a literal query is literal.
  const escaped = q.replace(/[%_\\]/g, (c) => `\\${c}`);
  return { sql: `p.body LIKE ? ESCAPE '\\'`, param: `%${escaped}%` };
}

interface HitRow {
  id: number;
  session_id: string;
  type: string;
  created_at: string;
  body: string;
  rn: number;
  total: number;
}

/**
 * Up to `perChat` most-recent prose hits (and the total match count) per
 * chat, for chats matching `query`. Only `source IS NULL` chats — the set the
 * Chats list shows — are searched.
 *
 * Best-effort: a malformed query or an SQLite error is logged (by length
 * only — never the query text) and answered with `[]` rather than thrown,
 * since this backs a live-typing search box.
 */
export function searchChatProse(query: string, perChat = 3): ChatProseResult[] {
  const clause = proseMatchClause(query);
  if (!clause) return [];

  const limit = Math.max(1, Math.min(Math.floor(perChat), 10));
  const trimmedQuery = query.trim();

  try {
    const rows = getDatabase()
      .prepare(`
        WITH hits AS (
          SELECT m.id, m.session_id, m.type, m.created_at, p.body,
                 ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id DESC) AS rn,
                 COUNT(*)     OVER (PARTITION BY m.session_id) AS total
          FROM message_prose p
          JOIN messages m ON m.id = p.rowid
          JOIN sessions s ON s.id = m.session_id
          WHERE ${clause.sql} AND s.source IS NULL
        )
        SELECT * FROM hits WHERE rn <= ? ORDER BY session_id, id DESC
      `)
      .all(clause.param, limit) as HitRow[];

    const bySession = new Map<string, ChatProseResult>();
    for (const row of rows) {
      let result = bySession.get(row.session_id);
      if (!result) {
        result = { sessionId: row.session_id, total: row.total, hits: [] };
        bySession.set(row.session_id, result);
      }
      result.hits.push({
        messageId: row.id,
        role: row.type as 'user' | 'assistant',
        createdAt: row.created_at,
        snippet: proseSnippet(row.body, trimmedQuery),
      });
    }
    return Array.from(bySession.values());
  } catch (err) {
    log.warn('[chatSearch] searchChatProse failed, query length', trimmedQuery.length, err);
    return [];
  }
}

/** First non-empty line of `body`, capped to 120 chars, for a list preview. */
function firstLineFor(body: string): string {
  const nl = body.indexOf('\n');
  const line = nl === -1 ? body : body.slice(0, nl);
  return line.slice(0, 120);
}

interface EarliestRow {
  session_id: string;
  type: string;
  body: string;
}

/**
 * The Chats-list preview line for every `source IS NULL` chat that has at
 * least one prose row: the earliest user prose row and the earliest assistant
 * prose row, each cut to their first line and 120 chars. Skips an assistant
 * row that carries only tool calls (no prose row exists for it, so it's
 * invisible to this query) — an improvement over the old per-row loader,
 * which read every message in the chat to build the same preview.
 *
 * A chat with no prose rows at all is simply absent from the result.
 */
export function listChatPreviews(): ChatPreview[] {
  try {
    const rows = getDatabase()
      .prepare(`
        WITH earliest AS (
          SELECT m.session_id AS session_id, m.type AS type, p.body AS body,
                 ROW_NUMBER() OVER (PARTITION BY m.session_id, m.type ORDER BY m.id ASC) AS rn
          FROM message_prose p
          JOIN messages m ON m.id = p.rowid
          JOIN sessions s ON s.id = m.session_id
          WHERE s.source IS NULL
        )
        SELECT session_id, type, body FROM earliest WHERE rn = 1
      `)
      .all() as EarliestRow[];

    const bySession = new Map<string, ChatPreview>();
    for (const row of rows) {
      let preview = bySession.get(row.session_id);
      if (!preview) {
        preview = { sessionId: row.session_id, userText: '', assistantText: '' };
        bySession.set(row.session_id, preview);
      }
      const line = firstLineFor(row.body);
      if (row.type === 'user') preview.userText = line;
      else if (row.type === 'assistant') preview.assistantText = line;
    }
    return Array.from(bySession.values());
  } catch (err) {
    log.warn('[chatSearch] listChatPreviews failed', err);
    return [];
  }
}
