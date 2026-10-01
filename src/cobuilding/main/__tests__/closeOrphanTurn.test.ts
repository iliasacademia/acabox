/**
 * @jest-environment node
 *
 * `closeOrphanTurn` replaced `cleanupOrphanTurnRows`, which DELETED a crashed
 * or stopped turn's assistant/tool rows (237 on one Stop in production). It now
 * keeps them and appends a `stopped` result row. Real SQLite, as in
 * `chatSearch.test.ts`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-orphan-'));
jest.mock('electron', () => ({ app: { getPath: () => tmpDir, isPackaged: false } }));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { initDatabase, closeDatabase, getDatabase } from '../db/database';
import { createSession, insertMessage, closeOrphanTurn, getMessages } from '../db/chatRepository';

let workspaceId: string;
beforeAll(() => {
  initDatabase(tmpDir);
  workspaceId = randomUUID();
  getDatabase()
    .prepare('INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)')
    .run(workspaceId, 'W', tmpDir, 'k');
});
afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const session = () => { const id = randomUUID(); createSession(id, workspaceId, null); return id; };
const text = (s: string) => JSON.stringify([{ type: 'text', text: s }]);

describe('closeOrphanTurn', () => {
  it('keeps the open turn\'s rows and appends a stopped result', () => {
    const id = session();
    insertMessage(id, 'user', JSON.stringify({ text: 'go' }), 'm1');
    insertMessage(id, 'assistant', text('working'), 'm1');
    insertMessage(id, 'tool_result', JSON.stringify([{ type: 'tool_result', tool_use_id: 't' }]), 'm1');
    insertMessage(id, 'assistant', text('more'), 'm1');

    expect(closeOrphanTurn(id)).toBe(3);

    const rows = getMessages(id);
    expect(rows.map((r) => r.type)).toEqual(['user', 'assistant', 'tool_result', 'assistant', 'result']);
    expect(JSON.parse(rows[4].content)).toEqual({ subtype: 'stopped', result: '', is_error: false, stopped_by: 'crash' });
    expect(rows[4].message_id).toBe('m1');
  });

  it('is a no-op once the turn is closed, so it cannot pile up result rows', () => {
    const id = session();
    insertMessage(id, 'user', JSON.stringify({ text: 'go' }));
    insertMessage(id, 'assistant', text('x'));
    expect(closeOrphanTurn(id)).toBe(1);
    expect(closeOrphanTurn(id)).toBe(0);
    expect(getMessages(id).filter((r) => r.type === 'result')).toHaveLength(1);
  });

  it('leaves a finished turn alone and only closes the one after it', () => {
    const id = session();
    insertMessage(id, 'user', JSON.stringify({ text: 'a' }));
    insertMessage(id, 'assistant', text('done'));
    insertMessage(id, 'result', JSON.stringify({ subtype: 'success', result: 'done', is_error: false }));
    expect(closeOrphanTurn(id)).toBe(0);
    insertMessage(id, 'user', JSON.stringify({ text: 'b' }));
    insertMessage(id, 'assistant', text('half'));
    expect(closeOrphanTurn(id)).toBe(1);
    expect(getMessages(id).map((r) => r.type)).toEqual(['user', 'assistant', 'result', 'user', 'assistant', 'result']);
  });

  it('does nothing for a user row with no reply', () => {
    const id = session();
    insertMessage(id, 'user', JSON.stringify({ text: 'hi' }));
    expect(closeOrphanTurn(id)).toBe(0);
    expect(getMessages(id)).toHaveLength(1);
  });
});
