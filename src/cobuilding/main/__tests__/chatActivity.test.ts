/**
 * @jest-environment node
 *
 * `main/chatActivity.ts` decides which chats read "working" and which read
 * "unread" everywhere in the app. Driven against a REAL sqlite database (the
 * migration chain included, so migration 32's column is exercised too) —
 * `better-sqlite3` is built for Electron's ABI, which `npm test` runs under.
 *
 * The rule under test, as the user chose it: a turn that ENDS while its chat
 * is not on screen in a focused Acabox window is unread; opening that chat in
 * a focused window reads it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-chatactivity-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, isPackaged: false },
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { initDatabase, closeDatabase, getDatabase } from '../db/database';
import { createSession, listUnreadSessionIds } from '../db/chatRepository';
import {
  __resetChatActivityForTests,
  getChatActivity,
  noteTurnEnded,
  noteTurnStarted,
  onChatActivityChanged,
  setChatWindowFocused,
  setViewingChat,
  type ChatActivitySnapshot,
} from '../chatActivity';

let workspaceId: string;

beforeAll(() => {
  initDatabase(tmpDir);
  workspaceId = randomUUID();
  getDatabase()
    .prepare('INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)')
    .run(workspaceId, 'Test Workspace', tmpDir, 'test-key');
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let events: ChatActivitySnapshot[];

beforeEach(() => {
  __resetChatActivityForTests();
  getDatabase().prepare('UPDATE sessions SET unread = 0').run();
  events = [];
  onChatActivityChanged((s) => events.push(s));
});

/** The most recent announcement. */
function last(): ChatActivitySnapshot {
  return events[events.length - 1];
}

/** A chat the Chats list would show. */
function chat(source: string | null = null): string {
  const id = randomUUID();
  createSession(id, workspaceId, source, null, null);
  return id;
}

function runTurn(id: string): void {
  noteTurnStarted(id);
  noteTurnEnded(id);
}

describe('working', () => {
  it('a started turn is active and announced; an ended one is not', () => {
    const id = chat();
    noteTurnStarted(id);
    expect(getChatActivity().activeIds).toEqual([id]);
    expect(last().activeIds).toEqual([id]);
    noteTurnEnded(id);
    expect(getChatActivity().activeIds).toEqual([]);
    expect(last().activeIds).toEqual([]);
  });

  it('starting an already-active turn announces nothing new', () => {
    const id = chat();
    noteTurnStarted(id);
    noteTurnStarted(id);
    expect(events).toHaveLength(1);
  });
});

describe('unread — the rule the user chose', () => {
  it('a turn that ends with nobody looking is unread', () => {
    const id = chat();
    runTurn(id);
    expect(listUnreadSessionIds()).toContain(id);
    expect(last().unreadIds).toContain(id);
  });

  it('a turn that ends on screen in a focused window is NOT unread', () => {
    const id = chat();
    setChatWindowFocused(true);
    setViewingChat(id);
    runTurn(id);
    expect(listUnreadSessionIds()).not.toContain(id);
  });

  it('on screen but Acabox behind another app still counts as unread', () => {
    // The "+ app focused" half of the rule. Without it, a reply that lands
    // while you are in your browser would be marked read by a window you
    // were not looking at.
    const id = chat();
    setViewingChat(id);
    setChatWindowFocused(false);
    runTurn(id);
    expect(listUnreadSessionIds()).toContain(id);
  });

  it('focusing the window with that chat on screen reads it', () => {
    const id = chat();
    setViewingChat(id);
    runTurn(id);
    expect(listUnreadSessionIds()).toContain(id);
    setChatWindowFocused(true);
    expect(listUnreadSessionIds()).not.toContain(id);
    expect(last().unreadIds).not.toContain(id);
  });

  it('opening an unread chat in a focused window reads it', () => {
    const id = chat();
    setChatWindowFocused(true);
    runTurn(id);
    expect(listUnreadSessionIds()).toContain(id);
    setViewingChat(id);
    expect(listUnreadSessionIds()).not.toContain(id);
  });

  it('looking at a DIFFERENT chat does not read this one', () => {
    const a = chat();
    const b = chat();
    setChatWindowFocused(true);
    setViewingChat(b);
    runTurn(a);
    expect(listUnreadSessionIds()).toContain(a);
  });

  it('a session torn down between turns flags nothing', () => {
    // The error and destroy paths call noteTurnEnded unconditionally.
    const id = chat();
    noteTurnEnded(id);
    expect(listUnreadSessionIds()).not.toContain(id);
    expect(events).toHaveLength(0);
  });

  it('never flags a chat the Chats list does not show', () => {
    // An unread row nobody can see would still light the sidebar dot.
    const hidden = chat('scheduled-hidden');
    runTurn(hidden);
    expect(listUnreadSessionIds()).not.toContain(hidden);
  });

  it('reading an already-read chat announces nothing', () => {
    const id = chat();
    setChatWindowFocused(true);
    setViewingChat(id);
    expect(events).toHaveLength(0);
  });
});

describe('across a restart', () => {
  it('unread survives; working does not', () => {
    const done = chat();
    const midTurn = chat();
    runTurn(done);
    noteTurnStarted(midTurn);
    __resetChatActivityForTests(); // a fresh process: in-memory state gone
    const after = getChatActivity();
    expect(after.unreadIds).toContain(done);
    expect(after.activeIds).toEqual([]);
  });
});

describe('failure containment', () => {
  it('a database error never breaks the turn that triggered it', () => {
    const id = chat();
    noteTurnStarted(id);
    closeDatabase();
    try {
      expect(() => noteTurnEnded(id)).not.toThrow();
      expect(getChatActivity().activeIds).toEqual([]);
    } finally {
      initDatabase(tmpDir);
    }
  });
});
