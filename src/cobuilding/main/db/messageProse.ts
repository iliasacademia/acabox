/**
 * `message_prose` — the prose-only search index behind chat search
 * (docs/design/chat-search.md). It indexes ONLY what a user typed and what
 * Claude wrote back in reply — never `tool_use` input, `tool_result` output,
 * `thinking` blocks, or `result` rows. `result` rows are excluded on purpose:
 * every non-empty one duplicates the last assistant `text` block (measured on
 * the production DB), so indexing them would make every final answer match
 * search twice.
 *
 * The table is filled EXCLUSIVELY by triggers on `messages` — insert, delete,
 * and update — so no code path (chat delete, hard reset, orphan-row cleanup,
 * overflow repair) can forget to keep it in sync. `proseExpr()` below is the
 * single place the prose-extraction SQL is written; the insert trigger, the
 * update trigger, and migration 33's one-time backfill all interpolate it, so
 * those three copies cannot drift apart.
 */

/**
 * The prose-extraction expression for one `messages` row, referenced by
 * `alias` (`new` inside a trigger; the backfill SELECT's `messages` alias).
 * - `user`: `content.text`, plus a newline + `content.quote.text` when a quote
 *   is present.
 * - `assistant`: every `text` block in the content array, joined with `\n`.
 * - anything else, or content that isn't valid JSON in the expected shape:
 *   NULL.
 * Trimmed of whitespace; `NULLIF` turns an all-whitespace/empty result into
 * NULL so callers can test "IS NOT NULL" rather than "!= ''".
 */
function proseExpr(alias: string): string {
  return `
    CASE
      WHEN ${alias}.type = 'user' AND json_valid(${alias}.content) THEN
        NULLIF(trim(COALESCE(json_extract(${alias}.content, '$.text'), '')
          || COALESCE(char(10) || json_extract(${alias}.content, '$.quote.text'), ''),
          char(32, 9, 10, 13)), '')
      WHEN ${alias}.type = 'assistant' AND json_valid(${alias}.content) AND json_type(${alias}.content) = 'array' THEN
        NULLIF(trim((SELECT group_concat(json_extract(value, '$.text'), char(10))
          FROM json_each(${alias}.content) WHERE json_extract(value, '$.type') = 'text'),
          char(32, 9, 10, 13)), '')
    END
  `;
}

const NEW_PROSE = proseExpr('new');
const BACKFILL_PROSE = proseExpr('m');

/**
 * Run once, via `database.exec`, by migration 33. Creates the FTS5 index,
 * wires the triggers that keep it current, and backfills every existing row.
 */
export const MESSAGE_PROSE_SQL = `
  CREATE VIRTUAL TABLE message_prose USING fts5(body, tokenize = 'trigram');

  CREATE TRIGGER message_prose_ai AFTER INSERT ON messages
  WHEN new.type IN ('user', 'assistant')
  BEGIN
    INSERT INTO message_prose (rowid, body)
    SELECT new.id, body FROM (SELECT ${NEW_PROSE} AS body)
    WHERE body IS NOT NULL;
  END;

  CREATE TRIGGER message_prose_ad AFTER DELETE ON messages
  BEGIN
    DELETE FROM message_prose WHERE rowid = old.id;
  END;

  CREATE TRIGGER message_prose_au AFTER UPDATE OF type, content ON messages
  BEGIN
    DELETE FROM message_prose WHERE rowid = old.id;
    INSERT INTO message_prose (rowid, body)
    SELECT new.id, body FROM (SELECT ${NEW_PROSE} AS body)
    WHERE new.type IN ('user', 'assistant') AND body IS NOT NULL;
  END;

  INSERT INTO message_prose (rowid, body)
  SELECT id, body FROM (
    SELECT m.id AS id, ${BACKFILL_PROSE} AS body
    FROM messages m
    WHERE m.type IN ('user', 'assistant')
  )
  WHERE body IS NOT NULL;
`;
