# Chat search over message text — design + tickets

Status: **built and verified 2026-09-28** (both tickets landed; see CLAUDE.md Status). One post-review change to the appendix: snippets open ~40 chars before the match instead of centring on it, because the list ellipsizes a hit line at ~95 chars. Decisions are the user's (2026-09-28):
index **prose only** (what the user typed, and Claude's written replies), never
tool output; show **up to 3 most recent matching lines** per chat; rank title
matches above body-only matches, then list order; fix the Chats-page preview
loader in the same change. Jump-to-message is deliberately NOT in this change.

## Why

Search matched the title plus the first ~120 chars of the first user message and
first reply. To build that preview, every row called `sessionsAPI.listMessages`
— the chat's ENTIRE history — and kept 120 characters. The list is not
virtualized, so opening Chats copied essentially the whole messages table
(~77 MB on the production DB, 50 chats) into the renderer once per app run.

## Measured on the production DB (2026-09-28, 50 chats, 88 MB)

| Content | Size |
|---|---|
| user typed text | 0.14 MB |
| assistant `text` blocks | 0.77 MB |
| `result` rows | 0.57 MB — **all 248 non-empty ones duplicate an assistant text block**, so they are NOT indexed (every final answer would match twice) |
| tool_use inputs | 8.6 MB |
| tool_result | 43 MB |
| thinking blocks | 22.4 MB, of which 22.15 MB is the encrypted `signature` |

- No assistant row holds more than one `text` block, so one index row = one
  paragraph on screen.
- Every user row is a JSON object with keys from `{text, attachments, quote}`.
- FTS5 with the `trigram` tokenizer ships in Electron's better-sqlite3
  (SQLite 3.51.2). Prose-only trigram index: **+6 MB, 0.2 s to build, <0.3 ms
  per query**. The everything-index would be +73 MB and noisy.
- Verified in real SQLite: an AFTER DELETE trigger on `messages` fires on the
  `ON DELETE CASCADE` from `sessions`. Trigram `MATCH` needs >= 3 characters
  (shorter returns nothing); `LIKE` without `ESCAPE` uses the index, `LIKE`
  with `ESCAPE` scans (fine for a 1–2 char query over ~1.5 MB).

## Design

- `message_prose` — FTS5 table, `rowid = messages.id`, one column `body`.
  Filled ONLY by triggers on `messages` (insert / delete / update), so no code
  path (chat delete, hard reset, orphan cleanup, overflow repair) can forget it.
  Backfilled once by migration 33.
- Search runs in main (`sessions:searchProse`), not the renderer. The renderer
  ranks and renders.
- Previews come from one batched query (`sessions:previews`) over the same
  table, refreshed on `sessions:changed`.
- The agent's `list_chats(query)` matches title OR message text via the same
  clause.
- Cost: zero model calls on every path.

---

## Appendix — shared contract (both tickets rely on exactly this)

### Main-side types — `src/cobuilding/main/db/chatSearch.ts`

```ts
export interface ChatPreview { sessionId: string; userText: string; assistantText: string; }
export interface ProseHit { messageId: number; role: 'user' | 'assistant'; createdAt: string; snippet: string; }
export interface ChatProseResult { sessionId: string; total: number; hits: ProseHit[]; }
```

### IPC

| Channel | Args | Returns |
|---|---|---|
| `sessions:previews` | none | `ChatPreview[]` |
| `sessions:searchProse` | `query: string` (non-string → `[]`; sliced to 200 chars) | `ChatProseResult[]` |

### Preload (`src/cobuilding/main/preload.ts`, inside the `sessionsAPI` object)

```ts
previews: () => ipcRenderer.invoke('sessions:previews'),
searchProse: (query: string) => ipcRenderer.invoke('sessions:searchProse', query),
```

### Renderer types (`src/cobuilding/renderer/types.d.ts`)

Add next to `MessageData` (there are TWO `MessageData` / `SessionsAPI`
declarations in that file, ~line 70 and ~line 630 — update BOTH):

```ts
interface ChatPreviewData { sessionId: string; userText: string; assistantText: string; }
interface ProseHitData { messageId: number; role: 'user' | 'assistant'; createdAt: string; snippet: string; }
interface ChatProseResultData { sessionId: string; total: number; hits: ProseHitData[]; }
```

and to both `SessionsAPI` interfaces:

```ts
previews(): Promise<ChatPreviewData[]>;
searchProse(query: string): Promise<ChatProseResultData[]>;
```

### Semantics

- **Prose of a row** — `user`: `content.text`, plus `"\n" + content.quote.text`
  when a quote exists. `assistant`: the `text` blocks of the content array,
  joined with `"\n"`. Every other type (`tool_result`, `result`, …): none.
  Trimmed of leading/trailing whitespace; an empty result is not indexed.
- **Search** — `q = query.trim()`; empty → `[]`. If `[...q].length >= 3`: FTS
  `MATCH` on the phrase `"` + q with every `"` doubled + `"`. Otherwise
  `body LIKE '%' || escaped(q) || '%' ESCAPE '\'` (escape `\`, `%`, `_`).
  Case-insensitive. Only sessions with `source IS NULL` (the set the Chats list
  shows). No workspace filter — `sessions:list` has none either, and the
  renderer only renders ids it already lists.
- **Per chat** — `total` = number of matching prose rows in that chat; `hits`
  = the 3 most recent (highest `messages.id` first), each with a `snippet`.
- **Preview** — `userText` = first line of the earliest user prose row in the
  chat, sliced to 120 chars; `assistantText` = same for the earliest assistant
  prose row (so an assistant row with only tool calls is skipped — a small
  improvement over the old per-row loader). Empty string when absent. Chats
  with no prose rows are simply absent from the array. `source IS NULL` only.
- **Snippet** — `proseSnippet(body, query, maxChars = 160)` in
  `src/cobuilding/shared/proseSnippet.ts` (pure, no imports):
  1. `i` = case-insensitive index of `query` in `body`. If `-1`, use the first
     non-empty line, clipped to `maxChars` with a trailing `…` if clipped, then
     step 4.
  2. Take the line containing `i` (bounded by `\n`). If the match starts more
     than 40 chars into the line, open the window 40 chars before it (moved to
     a nearby word break), else at the line start; take up to `maxChars` from
     there. Prefix `…` if it starts after the line start, suffix `…` if it ends
     before the line end. (Originally "centred on the match"; changed after the
     live list showed a centred match cut off by the row's ellipsis.)
  3. (window chosen on the RAW line; cleaning happens after)
  4. Clean: `[text](url)` → `text`; remove `**`, `__`, and backticks; if the
     window starts at the line start, strip one leading block marker
     (`#`…`######` + space, `>` + space, `-`/`*`/`+` + space, `1.` + space);
     table pipes: runs of `\s*\|\s*` → ` · `, then strip leading/trailing ` · `;
     collapse whitespace runs to one space; trim.

---

## Ticket A — main side: index, search, previews, IPC, `list_chats`

Owns these files only: `src/cobuilding/main/db/messageProse.ts` (new),
`src/cobuilding/main/db/chatSearch.ts` (new), `src/cobuilding/shared/proseSnippet.ts`
(new), `src/cobuilding/main/db/database.ts`, `src/cobuilding/main/db/chatRepository.ts`,
`src/cobuilding/main/index.ts`, `src/cobuilding/agent-server/index.ts`
(one description string), and the two new test files. The preload bridge and
`types.d.ts` entries from the appendix ARE ALREADY IN PLACE — do not edit them.

1. **`db/messageProse.ts`** — export `const MESSAGE_PROSE_SQL: string` that, run
   with `database.exec`, does ALL of:
   - `CREATE VIRTUAL TABLE message_prose USING fts5(body, tokenize = 'trigram');`
   - `AFTER INSERT ON messages WHEN new.type IN ('user','assistant')` trigger
     inserting `(rowid = new.id, body = prose)` only when prose is non-NULL and
     non-empty.
   - `AFTER DELETE ON messages` trigger: `DELETE FROM message_prose WHERE rowid = old.id;`
   - `AFTER UPDATE OF type, content ON messages` trigger: delete old rowid, then
     insert the new row's prose under the same conditions as the insert trigger.
   - Backfill: `INSERT INTO message_prose(rowid, body) SELECT id, <prose> FROM messages WHERE <prose non-empty>;`
   Build the prose expression ONCE in TS as `function proseExpr(row: string): string`
   and interpolate it for `new`, and for the backfill's `messages` alias, so the
   three copies cannot drift. Reference implementation (verified in real SQLite):
   ```sql
   CASE
     WHEN r.type = 'user' AND json_valid(r.content) THEN
       NULLIF(trim(COALESCE(json_extract(r.content, '$.text'), '')
         || COALESCE(char(10) || json_extract(r.content, '$.quote.text'), ''),
         char(32, 9, 10, 13)), '')
     WHEN r.type = 'assistant' AND json_valid(r.content) AND json_type(r.content) = 'array' THEN
       NULLIF(trim((SELECT group_concat(json_extract(value, '$.text'), char(10))
         FROM json_each(r.content) WHERE json_extract(value, '$.type') = 'text'),
         char(32, 9, 10, 13)), '')
   END
   ```
   Header comment: prose-only on purpose (link this doc), `result` rows excluded
   because they duplicate the last assistant text, triggers are the only writer.

2. **`db/database.ts`** — append migration `{ version: 33, sql: MESSAGE_PROSE_SQL }`
   with a short comment in the style of 31/32.

3. **`shared/proseSnippet.ts`** — `export function proseSnippet(body: string, query: string, maxChars = 160): string` per the appendix.

4. **`db/chatSearch.ts`** — imports `getDatabase` from `./database` and
   `proseSnippet` from `../../shared/proseSnippet`. Must NOT import `chatRepository`.
   - `export function proseMatchClause(query: string): { sql: string; param: string } | null`
     — returns `null` for an empty trimmed query; otherwise the WHERE fragment
     against alias `p` (the `message_prose` table) plus its single bound
     parameter, per the appendix (`message_prose MATCH ?` vs
     `p.body LIKE ? ESCAPE '\'`). Note FTS5 needs the TABLE name on the left of
     MATCH, so alias usage is `FROM message_prose p ... WHERE message_prose MATCH ?`.
   - `export function searchChatProse(query: string, perChat = 3): ChatProseResult[]`
     — clamp `perChat` to 1..10. One query using window functions:
     ```sql
     WITH hits AS (
       SELECT m.id, m.session_id, m.type, m.created_at, p.body,
              ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id DESC) AS rn,
              COUNT(*)     OVER (PARTITION BY m.session_id) AS total
       FROM message_prose p
       JOIN messages m ON m.id = p.rowid
       JOIN sessions s ON s.id = m.session_id
       WHERE <clause> AND s.source IS NULL
     )
     SELECT * FROM hits WHERE rn <= ? ORDER BY session_id, id DESC
     ```
     Group into `ChatProseResult[]`; `snippet = proseSnippet(body, query.trim())`.
     Wrap in try/catch: on an SQLite error log via `electron-log` `warn` with the
     query length (not the text) and return `[]`.
   - `export function listChatPreviews(): ChatPreview[]` — earliest user and
     earliest assistant prose row per `source IS NULL` session, per the appendix.

5. **`db/chatRepository.ts`** — `listSessionsWithActivity`: when a query is
   given, replace the title-only filter with
   `(s.title LIKE ? ESCAPE '\\' OR s.id IN (SELECT m.session_id FROM message_prose p JOIN messages m ON m.id = p.rowid WHERE <clause>))`
   using `proseMatchClause`. Update its doc comment.

6. **`agent-server/index.ts`** — `list_chats`: tool description "search titles
   with query" → "search with query (matches chat titles and the text of
   messages)"; the `query` param description → "Case-insensitive text to find
   in chat titles or message text.". Nothing else in that file.

7. **IPC** — add the two `ipcMain.handle` calls from the appendix next to
   `'messages:list'` in `main/index.ts` (preload + types already exist).

8. **Tests**
   - `src/cobuilding/shared/__tests__/proseSnippet.test.ts` — short line
     returned cleaned; match on the 3rd line returns that line; long line →
     length ≤ maxChars + 2, contains the query, starts with `…` when clipped
     left and ends with `…` when clipped right; case-insensitive; `## **KII** results`
     → `KII results`; `| GTEx | KII data |` → `GTEx · KII data`;
     `[KII](http://x.y)` → `KII`; no match → first non-empty line.
   - `src/cobuilding/main/__tests__/chatSearch.test.ts` — `@jest-environment node`,
     REAL database via the recipe in `main/__tests__/chatReference.test.ts`
     (mock `electron` + `electron-log`, tmp dir, `initDatabase`). Cases:
     1. user text, user quote text, assistant text block are all findable.
     2. NOT findable: a token only in a thinking block's `signature`, only in a
        `tool_use` input, only in a `tool_result`, only in a `result` row.
     3. A `result` row repeating an assistant text → that chat has `total` 1, not 2.
     4. `"KII"` finds `"kii"` (case-insensitive, MATCH path).
     5. 2-char query finds via the LIKE path; `"5%"` matches `"5% of"` and not `"50 of"`.
     6. 5 matching messages in one chat → `hits.length` 3, `total` 5, hits in
        descending `messageId`.
     7. A session with `source = 'reactions-system'` is excluded.
     8. `deleteSession` → its hits are gone; a direct
        `DELETE FROM messages WHERE id = ?` removes that one hit.
     9. `UPDATE messages SET content = ?` re-indexes (old word gone, new found).
     10. Backfill: fresh `new Database(':memory:')`, create a minimal `messages`
         table, insert rows, THEN `exec(MESSAGE_PROSE_SQL)` → those rows are
         searchable via `SELECT rowid FROM message_prose WHERE message_prose MATCH ?`.
     11. `listChatPreviews`: skips an assistant row that has only `tool_use`,
         returns the first line only, caps at 120 chars, omits a chat with no
         messages.
     12. `listSessionsWithActivity(ws, { query })` returns a chat whose title
         does not contain the query but whose message text does.

**Acceptance:** `npx tsc --noEmit` clean; `npm test` fully green (never bare
`npx jest` — see CLAUDE.md). Do not run the app, do not commit.

---

## Ticket B — renderer: previews store, search hook, ranked list, hit lines

Owns these files only: `src/cobuilding/renderer/chatPreviewStore.ts` (new),
`src/cobuilding/renderer/chatSearchRank.ts` (new),
`src/cobuilding/renderer/useProseSearch.ts` (new),
`src/cobuilding/renderer/components/assistant-ui/thread-list.tsx`,
`src/cobuilding/renderer/App.css` (chat-list rules only), and the new tests.
The appendix's preload bridge and `types.d.ts` entries are ALREADY IN PLACE
(do not edit them); Ticket A is building the main side in parallel, so the IPC
channels will not answer in unit tests — mock `window.sessionsAPI`.

`thread-list.tsx` imports `@assistant-ui/react`, which cannot load under jest
(ESM-only `assistant-stream`), so every rule worth testing lives in the three
new modules, which must NOT import `@assistant-ui/react`.

1. **`chatPreviewStore.ts`** — copy the shape of `renderer/chatActivityStore.ts`
   (module-level snapshot, `ensureStarted`, `useSyncExternalStore`, bridge calls
   in try/catch). Snapshot: `ReadonlyMap<string, ChatPreviewData>` from
   `window.sessionsAPI.previews()`, re-read on `onSessionsChanged`. Export:
   - `useChatPreview(sessionId: string | undefined): ChatPreviewData | null`
   - pure `formatPreviewLine(p: ChatPreviewData | null): string` → exactly the
     old format: `You: <userText>` and `CS: <assistantText>`, each only when
     non-empty, joined with `' · '`; `''` for null.
   - `__resetChatPreviewStoreForTests()` (see how `chatActivityStore` exposes
     its test reset, if it does; otherwise add one).

2. **`chatSearchRank.ts`** (pure):
   ```ts
   export interface RankedRow { threadId: string; sessionId: string; titleMatch: boolean; prose: ChatProseResultData | null; }
   export function rankSearchRows(
     threadIds: readonly string[],
     items: Readonly<Record<string, { remoteId?: string; title?: string }>>,
     query: string,
     prose: ReadonlyMap<string, ChatProseResultData>,
   ): RankedRow[]
   ```
   `q = query.trim().toLowerCase()`; empty → `[]`. Skip ids without `remoteId`.
   `titleMatch = (title ?? 'New Chat').toLowerCase().includes(q)`. Include a row
   when `titleMatch || prose.has(remoteId)`. Order: all title matches first, then
   prose-only, each group preserving `threadIds` order (that order is the list's
   own recency order).

3. **`useProseSearch.ts`** — `useProseSearch(query: string): { forQuery: string; results: ReadonlyMap<string, ChatProseResultData> }`.
   Trimmed empty query → `{ forQuery: '', results: empty map }` immediately.
   Otherwise debounce 150 ms, call `window.sessionsAPI.searchProse(q)`, apply the
   response only if it is still the latest request (sequence counter), and keep
   the PREVIOUS results on screen until then (no per-keystroke flicker). While
   the query is non-empty, re-run it on `onSessionsChanged`. A rejected call
   leaves results unchanged.

4. **`thread-list.tsx`**
   - Delete `previewCache` and `useMessagePreview` entirely. `ThreadListItem`
     reads `useChatPreview(remoteId)` + `formatPreviewLine`. After this change
     nothing in this file may call `listMessages`.
   - `ThreadList`: `const prose = useProseSearch(searchQuery)`. Provide
     `prose.results` through a new context. When the trimmed query is empty,
     render `StableThreadItems` exactly as today. Otherwise compute
     `rankSearchRows(threadIds, threadItems, searchQuery, prose.results)` (read
     both with `useThreadList((s: any) => s.threadIds)` / `s.threadItems`) and
     render each row with
     `<ThreadListPrimitive.ItemByIndex index={threadIds.indexOf(row.threadId)} components={{ ThreadListItem }} />`.
     If the ranked list is empty AND `prose.forQuery === searchQuery.trim()`,
     show `No chats mention “<query>”.` in a `chatListEmpty` element (muted,
     13px, same padding as `chatListRefreshing`); if empty and not yet answered,
     render nothing.
   - Remove the per-item `return null` search filter from `ThreadListItem` (the
     list decides what renders now). Keep title highlighting.
   - In `ThreadListItem`, when searching and this chat has prose hits, render
     them INSTEAD of the preview line, inside the existing Trigger (so a click
     still opens the chat):
     ```tsx
     <span className="chatListItemHits">
       {hits.map((h) => (
         <span key={h.messageId} className="chatListItemHit">
           <span className="chatListItemHitWho">{h.role === 'user' ? 'You:' : 'CS:'}</span>{' '}
           {highlightMatch(h.snippet, searchQuery)}
         </span>
       ))}
       {total > hits.length && <span className="chatListItemHitMore">+{total - hits.length} more</span>}
     </span>
     ```
     A title-only match keeps the normal preview line.
   - Update the search input placeholder to `Search chat titles and messages…`.

5. **`App.css`** — next to `.chatListItemPreview`: `.chatListItemHits`
   (flex column, gap 2px, min-width 0); `.chatListItemHit` (same font, colour,
   line-height, single-line ellipsis as `.chatListItemPreview`);
   `.chatListItemHitWho` (colour `#6b6b78`); `.chatListItemHitMore`
   (`'IBM Plex Mono', monospace`, 11px, uppercase, letter-spacing 0.04em,
   colour `#91919e`); `.chatListEmpty`.

6. **Tests** (jsdom unless noted; follow `renderer/__tests__/chatActivityStore.test.tsx`
   for mocking `window.sessionsAPI`):
   - `renderer/__tests__/chatSearchRank.test.ts` — empty query → `[]`; title
     matches come before prose-only ones regardless of list position; each group
     keeps list order; a row matching both appears once, in the title group,
     with its prose attached; ids without `remoteId` skipped; case-insensitive
     title match; missing title treated as `New Chat`.
   - `renderer/__tests__/chatPreviewStore.test.tsx` — `formatPreviewLine`
     cases (both, user only, assistant only, null); the hook renders the
     preview after `previews()` resolves; a `sessions:changed` callback triggers
     a second `previews()` call and the new value renders.
   - `renderer/__tests__/useProseSearch.test.tsx` — fake timers: no call before
     150 ms; one call after; rapid typing → only the last query is sent; an
     out-of-order older response does not overwrite a newer one; empty query →
     empty results without a call.

**Acceptance:** `npx tsc --noEmit` clean; `npm test` fully green. Do not run the
app, do not commit.
