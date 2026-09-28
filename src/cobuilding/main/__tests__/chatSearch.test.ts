/**
 * @jest-environment node
 *
 * Chat search over message text (docs/design/chat-search.md). Exercises
 * `db/chatSearch.ts` and the `message_prose` FTS5 index/triggers
 * (`db/messageProse.ts`, migration 33) against a REAL sqlite database —
 * recipe copied from `chatReference.test.ts`: `better-sqlite3` is built for
 * Electron's Node ABI, which `npm test` runs under.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import BetterSqlite3 from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-chatsearch-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { initDatabase, closeDatabase, getDatabase } from '../db/database';
import { createSession, insertMessage, deleteSession, listSessionsWithActivity } from '../db/chatRepository';
import { searchChatProse, listChatPreviews, type ChatProseResult } from '../db/chatSearch';
import { MESSAGE_PROSE_SQL } from '../db/messageProse';

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let workspaceId: string;

beforeAll(() => {
  initDatabase(tmpDir);
  workspaceId = randomUUID();
  getDatabase()
    .prepare('INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)')
    .run(workspaceId, 'Test Workspace', tmpDir, 'test-key');
});

function newSession(source: string | null = null): string {
  const id = randomUUID();
  createSession(id, workspaceId, source);
  return id;
}

function insertUserText(sessionId: string, text: string, quoteText?: string): number {
  const content: Record<string, unknown> = { text };
  if (quoteText !== undefined) content.quote = { text: quoteText };
  return insertMessage(sessionId, 'user', JSON.stringify(content));
}

function insertAssistantText(sessionId: string, text: string): number {
  return insertMessage(sessionId, 'assistant', JSON.stringify([{ type: 'text', text }]));
}

function findResult(results: ChatProseResult[], sessionId: string): ChatProseResult | undefined {
  return results.find((r) => r.sessionId === sessionId);
}

describe('searchChatProse', () => {
  it('finds user text, a user quote, and an assistant text block', () => {
    const sessionId = newSession();
    insertUserText(sessionId, 'talking about needleusertxt01 today');
    insertUserText(sessionId, 'plain body', 'needlequotetxt02 inside a quote');
    insertAssistantText(sessionId, 'needleassistanttxt03 as a reply');

    expect(findResult(searchChatProse('needleusertxt01'), sessionId)).toBeDefined();
    expect(findResult(searchChatProse('needlequotetxt02'), sessionId)).toBeDefined();
    expect(findResult(searchChatProse('needleassistanttxt03'), sessionId)).toBeDefined();
  });

  it('does not find a token that only appears outside prose', () => {
    const sessionId = newSession();
    insertMessage(sessionId, 'assistant', JSON.stringify([
      { type: 'thinking', thinking: 'reasoning about it', signature: 'needlesignature04' },
    ]));
    insertMessage(sessionId, 'assistant', JSON.stringify([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo needletoolinput05' } },
    ]));
    insertMessage(sessionId, 'tool_result', JSON.stringify([
      { tool_use_id: 't1', type: 'tool_result', content: 'needletoolresult06' },
    ]));
    insertMessage(sessionId, 'result', JSON.stringify({
      subtype: 'success', result: 'needleresultrow07', is_error: false,
    }));

    expect(searchChatProse('needlesignature04')).toEqual([]);
    expect(searchChatProse('needletoolinput05')).toEqual([]);
    expect(searchChatProse('needletoolresult06')).toEqual([]);
    expect(searchChatProse('needleresultrow07')).toEqual([]);
  });

  it('does not double-count a result row that repeats the last assistant text', () => {
    const sessionId = newSession();
    insertAssistantText(sessionId, 'needlerepeat08 final answer');
    insertMessage(sessionId, 'result', JSON.stringify({
      subtype: 'success', result: 'needlerepeat08 final answer', is_error: false,
    }));

    const result = findResult(searchChatProse('needlerepeat08'), sessionId);
    expect(result).toBeDefined();
    expect(result!.total).toBe(1);
  });

  it('matches case-insensitively via the trigram MATCH path', () => {
    const sessionId = newSession();
    insertUserText(sessionId, 'we were discussing NeedleCaseNine today');

    const result = findResult(searchChatProse('needlecasenine'), sessionId);
    expect(result).toBeDefined();
  });

  it('a 2-character query matches literally via the LIKE path', () => {
    const percentSessionId = newSession();
    insertUserText(percentSessionId, 'Growth rate was 5% of baseline');
    const fiftySessionId = newSession();
    insertUserText(fiftySessionId, 'We had 50 of them delivered');

    const results = searchChatProse('5%');
    expect(findResult(results, percentSessionId)).toBeDefined();
    expect(findResult(results, fiftySessionId)).toBeUndefined();
  });

  it('caps hits at perChat, reports the true total, and orders hits by descending messageId', () => {
    const sessionId = newSession();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(insertAssistantText(sessionId, `needleshared10 message number ${i}`));
    }

    const result = findResult(searchChatProse('needleshared10'), sessionId);
    expect(result).toBeDefined();
    expect(result!.total).toBe(5);
    expect(result!.hits.length).toBe(3);
    const expectedIds = [...ids].sort((a, b) => b - a).slice(0, 3);
    expect(result!.hits.map((h) => h.messageId)).toEqual(expectedIds);
  });

  it('excludes a session with source = "reactions-system"', () => {
    const sessionId = newSession('reactions-system');
    insertUserText(sessionId, 'needlereactions11 scheduled output');

    expect(searchChatProse('needlereactions11')).toEqual([]);
  });

  it('deleteSession removes its hits; deleting one message removes just that hit', () => {
    const sessionId = newSession();
    insertAssistantText(sessionId, 'needledeleteall12 message one');
    insertAssistantText(sessionId, 'needledeleteall12 message two');
    expect(findResult(searchChatProse('needledeleteall12'), sessionId)!.total).toBe(2);

    deleteSession(sessionId);
    expect(searchChatProse('needledeleteall12')).toEqual([]);

    const otherSessionId = newSession();
    const idA = insertAssistantText(otherSessionId, 'needleonemsg13 message A');
    const idB = insertAssistantText(otherSessionId, 'needleonemsg13 message B');
    expect(findResult(searchChatProse('needleonemsg13'), otherSessionId)!.total).toBe(2);

    getDatabase().prepare('DELETE FROM messages WHERE id = ?').run(idA);

    const afterDelete = findResult(searchChatProse('needleonemsg13'), otherSessionId);
    expect(afterDelete).toBeDefined();
    expect(afterDelete!.total).toBe(1);
    expect(afterDelete!.hits.map((h) => h.messageId)).toEqual([idB]);
  });

  it('an UPDATE re-indexes a message: the old word is gone, the new one is found', () => {
    const sessionId = newSession();
    const messageId = insertUserText(sessionId, 'the needleoldword14 is here');
    expect(findResult(searchChatProse('needleoldword14'), sessionId)).toBeDefined();

    getDatabase()
      .prepare('UPDATE messages SET content = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'the needlenewword15 is here now' }), messageId);

    expect(searchChatProse('needleoldword14')).toEqual([]);
    expect(findResult(searchChatProse('needlenewword15'), sessionId)).toBeDefined();
  });
});

describe('MESSAGE_PROSE_SQL backfill', () => {
  it('indexes rows that existed before the table/triggers were created', () => {
    const memDb = new BetterSqlite3(':memory:');
    try {
      memDb.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, type TEXT, content TEXT);');
      memDb.prepare('INSERT INTO messages (id, type, content) VALUES (?, ?, ?)')
        .run(1, 'user', JSON.stringify({ text: 'needlebackfill16 was already here' }));
      memDb.prepare('INSERT INTO messages (id, type, content) VALUES (?, ?, ?)')
        .run(2, 'assistant', JSON.stringify([{ type: 'text', text: 'needlebackfill17 assistant reply' }]));

      memDb.exec(MESSAGE_PROSE_SQL);

      const rows = memDb.prepare('SELECT rowid FROM message_prose WHERE message_prose MATCH ?').all('needlebackfill16') as { rowid: number }[];
      expect(rows).toEqual([{ rowid: 1 }]);
      const rows2 = memDb.prepare('SELECT rowid FROM message_prose WHERE message_prose MATCH ?').all('needlebackfill17') as { rowid: number }[];
      expect(rows2).toEqual([{ rowid: 2 }]);
    } finally {
      memDb.close();
    }
  });
});

describe('listChatPreviews', () => {
  it('skips a tool-only assistant row, uses only the first line, and caps at 120 chars', () => {
    const sessionId = newSession();
    insertUserText(sessionId, 'user preview needle18 first line\nsecond line is not shown');
    insertMessage(sessionId, 'assistant', JSON.stringify([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]));
    insertAssistantText(sessionId, 'assistant preview needle19 first prose line');

    const previews = listChatPreviews();
    const preview = previews.find((p) => p.sessionId === sessionId);
    expect(preview).toBeDefined();
    expect(preview!.userText).toBe('user preview needle18 first line');
    expect(preview!.assistantText).toBe('assistant preview needle19 first prose line');

    const longLineSessionId = newSession();
    const longLine = 'x'.repeat(200);
    insertUserText(longLineSessionId, longLine);
    const longPreview = listChatPreviews().find((p) => p.sessionId === longLineSessionId);
    expect(longPreview).toBeDefined();
    expect(longPreview!.userText.length).toBe(120);
    expect(longPreview!.userText).toBe(longLine.slice(0, 120));
  });

  it('omits a chat with no messages', () => {
    const emptySessionId = newSession();
    const previews = listChatPreviews();
    expect(previews.find((p) => p.sessionId === emptySessionId)).toBeUndefined();
  });
});

describe('listSessionsWithActivity with a query', () => {
  it('returns a chat whose title does not contain the query but whose message text does', () => {
    const sessionId = newSession();
    insertUserText(sessionId, 'mentions needletitleless20 in the body only');

    const rows = listSessionsWithActivity(workspaceId, { query: 'needletitleless20' });
    const row = rows.find((r) => r.id === sessionId);
    expect(row).toBeDefined();
    expect(row!.title.toLowerCase()).not.toContain('needletitleless20');
  });
});
