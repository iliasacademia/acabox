/**
 * @jest-environment node
 *
 * `main/chatReference.ts` backs the agent's `list_chats` / `read_chat` MCP
 * tools (host handlers in `AgentInfrastructureController.ts`, schemas in
 * `agent-server/index.ts`). Two halves:
 *  1. `renderChatTranscript` — pure, exercised with hand-built Session/Message
 *     objects, no database.
 *  2. `readChatForAgent` / `listChatsForAgent` — thin entry points, exercised
 *     against a REAL sqlite database (recipe copied from
 *     `appChatLink.test.ts`: `better-sqlite3` is built for Electron's Node
 *     ABI, which `npm test` runs under).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-chatref-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { renderChatTranscript, readChatForAgent, listChatsForAgent } from '../chatReference';
import type { Session, Message } from '../db/chatRepository';
import { initDatabase, closeDatabase, getDatabase } from '../db/database';
import { createSession, insertMessage } from '../db/chatRepository';
import { buildChatLink } from '../../shared/chatLinks';

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// renderChatTranscript — pure, hand-built Session/Message objects
// ---------------------------------------------------------------------------

const SESSION_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    workspace_id: 'ws-1',
    sdk_session_id: null,
    title: 'Test Chat',
    source: null,
    document_path: null,
    app_dir_name: null,
    model: null,
    effort: null,
    created_at: '2026-09-18T07:00:00.000',
    updated_at: '2026-09-18T07:00:00.000',
    ...overrides,
  };
}

function makeMessage(id: number, type: string, content: unknown, createdAt: string): Message {
  return {
    id,
    session_id: SESSION_ID,
    type,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    message_id: null,
    created_at: createdAt,
  };
}

describe('renderChatTranscript', () => {
  it('conversation mode: shows user text and each turn\'s final reply only', () => {
    const session = makeSession();
    const messages = [
      makeMessage(1, 'user', { text: 'Hello' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'assistant', [
        { type: 'text', text: 'Hi there, thinking out loud...' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ], '2026-09-18T07:01:00.000'),
      makeMessage(3, 'tool_result', [{ tool_use_id: 't1', type: 'tool_result', content: 'file1\nfile2' }], '2026-09-18T07:01:30.000'),
      makeMessage(4, 'assistant', [{ type: 'text', text: 'Done listing files.' }], '2026-09-18T07:02:00.000'),
      makeMessage(5, 'result', { subtype: 'success', result: 'Done listing files.', is_error: false }, '2026-09-18T07:02:01.000'),
      makeMessage(6, 'user', { text: 'Thanks' }, '2026-09-18T07:03:00.000'),
      makeMessage(7, 'result', { subtype: 'success', result: 'You are welcome.', is_error: false }, '2026-09-18T07:03:01.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'conversation' });

    expect(result.text).toContain('[user 07:00] Hello');
    expect(result.text).toContain('[assistant 07:02] Done listing files.');
    expect(result.text).toContain('[user 07:03] Thanks');
    expect(result.text).toContain('[assistant 07:03] You are welcome.');
    expect(result.text).not.toContain('Hi there, thinking out loud');
    expect(result.text).not.toContain('file1');
    expect(result.text).not.toContain('[tool Bash]');
  });

  it('full mode: shows the Bash tool line with the command\'s first line, and no thinking', () => {
    const session = makeSession();
    const messages = [
      makeMessage(1, 'user', { text: 'Do a thing' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'assistant', [
        { type: 'thinking', thinking: 'Let me think this through...' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hello\necho world' } },
      ], '2026-09-18T07:01:00.000'),
      makeMessage(3, 'tool_result', [{ tool_use_id: 't1', type: 'tool_result', content: 'hello\nworld' }], '2026-09-18T07:01:30.000'),
      makeMessage(4, 'assistant', [{ type: 'text', text: 'Done.' }], '2026-09-18T07:02:00.000'),
      makeMessage(5, 'result', { subtype: 'success', result: 'Done.', is_error: false }, '2026-09-18T07:02:01.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'full' });

    expect(result.text).toContain('[tool Bash] echo hello');
    expect(result.text).not.toContain('Let me think this through');
  });

  it('include_tool_results includes a [result] line cut to 500 chars', () => {
    const session = makeSession();
    const bigOutput = 'X'.repeat(600);
    const messages = [
      makeMessage(1, 'user', { text: 'Run it' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat bigfile' } }], '2026-09-18T07:01:00.000'),
      makeMessage(3, 'tool_result', [{ tool_use_id: 't1', type: 'tool_result', content: bigOutput }], '2026-09-18T07:01:30.000'),
      makeMessage(4, 'assistant', [{ type: 'text', text: 'Here you go.' }], '2026-09-18T07:02:00.000'),
      makeMessage(5, 'result', { subtype: 'success', result: 'Here you go.', is_error: false }, '2026-09-18T07:02:01.000'),
    ];

    const withoutFlag = renderChatTranscript(session, messages, { detail: 'full' });
    expect(withoutFlag.text).not.toContain('[result]');

    const withFlag = renderChatTranscript(session, messages, { detail: 'full', includeToolResults: true });
    const match = /\[result\] (X+)…/.exec(withFlag.text);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(500);
  });

  it('an interrupted last turn (assistant text, no result row) still shows its last text', () => {
    const session = makeSession();
    const messages = [
      makeMessage(1, 'user', { text: 'Start a long task' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'assistant', [{ type: 'text', text: 'Working on step 1...' }], '2026-09-18T07:01:00.000'),
      makeMessage(3, 'assistant', [{ type: 'text', text: 'Working on step 2, almost done...' }], '2026-09-18T07:02:00.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'conversation' });

    expect(result.text).toContain('[assistant 07:02] Working on step 2, almost done...');
    expect(result.text).not.toContain('step 1');
  });

  it('an is_error result renders as a failed turn', () => {
    const session = makeSession();
    const messages = [
      makeMessage(1, 'user', { text: 'Do something bad' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'result', { subtype: 'error_during_execution', result: 'Something went wrong', is_error: true }, '2026-09-18T07:00:30.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'conversation' });

    expect(result.text).toContain('[assistant 07:00] (turn failed: Something went wrong)');
  });

  it('falls back to "error" when a failed result carries no text', () => {
    const session = makeSession();
    const messages = [
      makeMessage(1, 'user', { text: 'x' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'result', { subtype: 'error', result: '', is_error: true }, '2026-09-18T07:00:30.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'conversation' });

    expect(result.text).toContain('(turn failed: error)');
  });

  it('full mode dedupes a result row that only restates the last assistant text', () => {
    const session = makeSession();
    const messages = [
      makeMessage(1, 'user', { text: 'Q' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'assistant', [{ type: 'text', text: 'Answer text' }], '2026-09-18T07:01:00.000'),
      makeMessage(3, 'result', { subtype: 'success', result: 'Answer text', is_error: false }, '2026-09-18T07:01:01.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'full' });
    const occurrences = (result.text.match(/Answer text/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('full mode keeps a result that differs from the last assistant text', () => {
    const session = makeSession();
    const messages = [
      makeMessage(1, 'user', { text: 'Q' }, '2026-09-18T07:00:00.000'),
      makeMessage(2, 'assistant', [{ type: 'text', text: 'Partial answer' }], '2026-09-18T07:01:00.000'),
      makeMessage(3, 'result', { subtype: 'success', result: 'Final answer', is_error: false }, '2026-09-18T07:01:01.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'full' });
    expect(result.text).toContain('Partial answer');
    expect(result.text).toContain('Final answer');
  });

  it('annotates a quote (cut to 200 chars) and attachments', () => {
    const session = makeSession();
    const longQuote = 'A'.repeat(250);
    const messages = [
      makeMessage(1, 'user', {
        text: 'Check this out',
        quote: { text: longQuote },
        attachments: [{ name: 'a.csv' }, { name: 'b.png' }],
      }, '2026-09-18T07:00:00.000'),
    ];

    const result = renderChatTranscript(session, messages, { detail: 'conversation' });

    expect(result.text).toContain(`(quoted: ${'A'.repeat(200)}…)`);
    expect(result.text).toContain('(attachments: a.csv, b.png)');
  });

  it('truncates at the char budget and continues cleanly from the reported cursor', () => {
    const session = makeSession();
    const messages: Message[] = [];
    const turns = 25;
    for (let i = 0; i < turns; i++) {
      const minute = String(i % 60).padStart(2, '0');
      messages.push(makeMessage(messages.length + 1, 'user', { text: 'Q'.repeat(40) }, `2026-09-18T07:${minute}:00.000`));
      messages.push(makeMessage(messages.length + 1, 'result', { subtype: 'success', result: 'A'.repeat(40), is_error: false }, `2026-09-18T07:${minute}:01.000`));
    }

    const first = renderChatTranscript(session, messages, { detail: 'conversation', maxChars: 2000 });
    expect(first.truncated).toBe(true);
    expect(first.nextFromMessageId).not.toBeNull();
    expect(first.text).toContain(`from_message_id=${first.nextFromMessageId}`);

    const second = renderChatTranscript(session, messages, {
      detail: 'conversation',
      maxChars: 2000,
      fromMessageId: first.nextFromMessageId!,
    });
    expect(second.truncated).toBe(false);
    expect(first.renderedRows + second.renderedRows).toBe(messages.length);

    // No overlap, no gap: everything strictly after the reported cursor is
    // exactly what the second call rendered.
    const remainingIds = messages.map((m) => m.id).filter((id) => id > first.nextFromMessageId!);
    expect(remainingIds.length).toBe(second.renderedRows);
  });

  it('always includes the header, even for an untitled chat', () => {
    const session = makeSession({ title: '' });
    const messages = [makeMessage(1, 'user', { text: 'Hi' }, '2026-09-18T07:00:00.000')];

    const result = renderChatTranscript(session, messages, { detail: 'conversation' });

    expect(result.text).toContain('(untitled chat)');
    expect(result.text).toContain(`Link: acabox://chat/${SESSION_ID}`);
    expect(result.text).toContain('Times below are UTC.');
    expect(result.text).toContain('Messages: 1 rows total');
  });
});

// ---------------------------------------------------------------------------
// readChatForAgent / listChatsForAgent — against a real database
// ---------------------------------------------------------------------------

describe('readChatForAgent / listChatsForAgent — against a real database', () => {
  let workspaceId: string;
  let otherWorkspaceId: string;
  let sessionA: string; // title 'Alpha Report', most recently active
  let sessionB: string; // title 'Beta Notes', older
  let sessionUnderscore: string; // title 'Weird_Report'
  let sessionXVariant: string; // title 'WeirdXReport' — same shape minus the underscore
  let otherWorkspaceSession: string;

  function insertMessageAt(sessionId: string, type: string, content: string, createdAt: string): void {
    getDatabase()
      .prepare('INSERT INTO messages (session_id, type, content, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, type, content, createdAt);
  }

  beforeAll(() => {
    initDatabase(tmpDir);
    const db = getDatabase();

    workspaceId = randomUUID();
    db.prepare('INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)')
      .run(workspaceId, 'Test Workspace', tmpDir, 'test-key');

    otherWorkspaceId = randomUUID();
    db.prepare('INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)')
      .run(otherWorkspaceId, 'Other Workspace', tmpDir, 'test-key-2');

    sessionA = randomUUID();
    createSession(sessionA, workspaceId, null, null, null);
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Alpha Report', sessionA);
    insertMessageAt(sessionA, 'user', JSON.stringify({ text: 'hi' }), '2026-09-18T08:00:00.000');

    sessionB = randomUUID();
    createSession(sessionB, workspaceId, null, null, null);
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Beta Notes', sessionB);
    insertMessageAt(sessionB, 'user', JSON.stringify({ text: 'yo' }), '2026-09-18T07:00:00.000');

    sessionUnderscore = randomUUID();
    createSession(sessionUnderscore, workspaceId, null, null, null);
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Weird_Report', sessionUnderscore);
    insertMessageAt(sessionUnderscore, 'user', JSON.stringify({ text: 'x' }), '2026-09-18T06:00:00.000');

    sessionXVariant = randomUUID();
    createSession(sessionXVariant, workspaceId, null, null, null);
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('WeirdXReport', sessionXVariant);
    insertMessageAt(sessionXVariant, 'user', JSON.stringify({ text: 'x' }), '2026-09-18T05:00:00.000');

    otherWorkspaceSession = randomUUID();
    createSession(otherWorkspaceSession, otherWorkspaceId, null, null, null);
    insertMessage(otherWorkspaceSession, 'user', JSON.stringify({ text: 'elsewhere' }));
  });

  describe('listChatsForAgent', () => {
    it('orders most-recent-first', () => {
      const result = listChatsForAgent(workspaceId, {});
      expect(result.ok).toBe(true);
      const idxA = result.text.indexOf(buildChatLink(sessionA));
      const idxB = result.text.indexOf(buildChatLink(sessionB));
      expect(idxA).toBeGreaterThan(-1);
      expect(idxB).toBeGreaterThan(-1);
      expect(idxA).toBeLessThan(idxB);
    });

    it('a literal underscore in the query matches only the literal title, not as a SQL wildcard', () => {
      // 'WeirdXReport' is the same shape as 'Weird_Report' with the
      // underscore's position replaced by an ordinary character. If `_`
      // were passed through to LIKE unescaped, it would match ANY single
      // character there and this title would show up too; if the escaper
      // mangled the query instead (the bug this case caught: a collapsed
      // `\\` emitted the literal text `${c}`), the real title would be
      // missed. Both halves are asserted.
      const result = listChatsForAgent(workspaceId, { query: 'Weird_Report' });
      expect(result.ok).toBe(true);
      expect(result.text).toContain(buildChatLink(sessionUnderscore));
      expect(result.text).not.toContain(buildChatLink(sessionXVariant));
    });

    it('reports zero results plainly', () => {
      const result = listChatsForAgent(workspaceId, { query: 'no such chat exists' });
      expect(result.ok).toBe(true);
      expect(result.text).toContain('No chats found matching "no such chat exists".');
    });
  });

  describe('readChatForAgent', () => {
    it('refuses a malformed chat reference', () => {
      const result = readChatForAgent(workspaceId, { chat: 'definitely not a chat link' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('is not a chat link or id');
    });

    it('accepts a bare uuid (no acabox://chat/ prefix) for an existing chat', () => {
      const result = readChatForAgent(workspaceId, { chat: sessionA });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text).toContain('Alpha Report');
        expect(result.text).toContain('hi');
      }
    });

    it('reports "exists in this workspace" for a well-formed but unknown id, not a format error', () => {
      const result = readChatForAgent(workspaceId, { chat: randomUUID() });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('exists in this workspace');
        expect(result.error).not.toContain('is not a chat link or id');
      }
    });

    it('refuses a chat that exists but belongs to a different workspace', () => {
      const result = readChatForAgent(workspaceId, { chat: otherWorkspaceSession });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('exists in this workspace');
    });
  });
});
