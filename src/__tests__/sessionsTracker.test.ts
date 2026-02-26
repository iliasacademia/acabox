import Database from 'better-sqlite3';
import type { WindowMonitorEvent } from '../windowMonitor/types';

// --- Mocks (hoisted by Jest before imports) ---

jest.mock('../utils/logger', () => ({
  defaultLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../utils/deviceId', () => ({
  getDeviceId: jest.fn(() => 'test-device-id'),
  resetDeviceIdCache: jest.fn(),
}));

jest.mock('../wordIntegrationDataStoreV2', () => ({
  wordIntegrationDataStoreV2: {
    getProjectFileForPath: jest.fn((filePath: string) => {
      if (filePath === '/known/project/doc.docx') {
        return { project_id: 42, project_file_id: 100 };
      }
      return null;
    }),
  },
}));

// --- Imports (resolved AFTER mocks are registered) ---

import { createSessionDb } from '../sessionDbFactory';
import { createSessionsTracker, type SessionsTracker } from '../sessionsTrackerFactory';

// --- Helpers ---

interface SessionRow {
  session_id: string;
  session_type: string;
  user_id: number | null;
  start_time: string;
  end_time: string;
  data: string;
  device_id: string;
  created_at: string;
  updated_at: string;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function allSessions(db: Database.Database): SessionRow[] {
  return db.prepare('SELECT * FROM sessions ORDER BY session_id').all() as SessionRow[];
}

function sessionsByType(db: Database.Database, type: string): SessionRow[] {
  return db.prepare('SELECT * FROM sessions WHERE session_type = ? ORDER BY session_id').all(type) as SessionRow[];
}

// --- Test helpers ---

function createTestHarness() {
  const db = new Database(':memory:');
  const sessionDb = createSessionDb(db);
  const tracker = createSessionsTracker(sessionDb);
  return { db, tracker };
}

const appInfo = {
  pid: 1234,
  name: 'Microsoft Word',
  identifier: 'com.microsoft.Word',
  identifierType: 'bundleId' as const,
};

const defaultBounds = { x: 0, y: 0, width: 800, height: 600 };

function makeEvent(overrides: Partial<WindowMonitorEvent> & { event: string }): WindowMonitorEvent {
  return {
    timestamp: new Date().toISOString(),
    platform: 'macos',
    app: appInfo,
    ...overrides,
  } as WindowMonitorEvent;
}

// --- Tests ---

describe('sessionsTracker', () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it('tracks the full lifecycle: app start → login → WINDOW_FOCUSED → APP_UNFOCUSED → logout → app stop', () => {
    const { db, tracker } = harness;

    // Step 1: recordAppStarted → 1 row, desktop_app session, user_id=null
    tracker.recordAppStarted();
    let rows = allSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toMatch(ULID_RE);
    expect(rows[0].session_type).toBe('desktop_app');
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].device_id).toBe('test-device-id');
    expect(rows[0].created_at).toBe(rows[0].start_time);
    expect(rows[0].updated_at).toBe(rows[0].start_time);
    const appSessionId = rows[0].session_id;

    // Step 2: recordUserLoggedIn → app session now has user_id=123
    tracker.recordUserLoggedIn(123);
    let appSessions = sessionsByType(db, 'desktop_app');
    expect(appSessions[0].user_id).toBe(123);
    expect(appSessions[0].updated_at >= appSessions[0].created_at).toBe(true);

    // Step 3: APP_LAUNCHED is now a no-op
    tracker.processEvent(makeEvent({ event: 'APP_LAUNCHED' }));
    rows = allSessions(db);
    expect(rows).toHaveLength(1); // still just desktop_app

    // Step 4: WINDOW_CREATED populates windowToApp but no session
    tracker.processEvent(makeEvent({
      event: 'WINDOW_CREATED',
      window: { id: 'win-1', title: 'Document', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
    } as any));
    rows = allSessions(db);
    expect(rows).toHaveLength(1); // still just desktop_app

    // Step 5: WINDOW_FOCUSED creates word_window_focused session
    tracker.processEvent(makeEvent({
      event: 'WINDOW_FOCUSED',
      window: { id: 'win-1', title: 'Document', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
    } as any));
    rows = allSessions(db);
    expect(rows).toHaveLength(2);
    let focused = sessionsByType(db, 'word_window_focused');
    expect(focused).toHaveLength(1);
    expect(focused[0].user_id).toBe(123);
    const focusedData = JSON.parse(focused[0].data);
    expect(focusedData.document_path).toBe('/known/project/doc.docx');
    expect(focusedData.project_id).toBe(42);
    expect(focusedData.project_file_id).toBe(100);
    expect(focusedData.window_id).toBe('win-1');
    const focusedSessionId = focused[0].session_id;

    // Step 6: APP_UNFOCUSED closes the focused session
    tracker.processEvent(makeEvent({ event: 'APP_UNFOCUSED' } as any));
    focused = sessionsByType(db, 'word_window_focused');
    const closedFocused = focused.find(s => s.session_id === focusedSessionId)!;
    expect(closedFocused.end_time >= closedFocused.start_time).toBe(true);

    // Step 7: recordUserLoggedOut → all prior sessions closed, new desktop_app session with user_id=null
    tracker.recordUserLoggedOut();
    rows = allSessions(db);
    expect(rows).toHaveLength(3); // original desktop_app + word_window_focused + new desktop_app
    appSessions = sessionsByType(db, 'desktop_app');
    expect(appSessions).toHaveLength(2);
    const closedApp = appSessions.find(s => s.session_id === appSessionId)!;
    expect(closedApp.end_time >= closedApp.start_time).toBe(true);
    const newApp = appSessions.find(s => s.session_id !== appSessionId)!;
    expect(newApp.session_id).toMatch(ULID_RE);
    expect(newApp.user_id).toBeNull();
    const newAppSessionId = newApp.session_id;

    // Step 8: recordAppStopping → new app session has final end_time
    tracker.recordAppStopping();
    rows = allSessions(db);
    expect(rows).toHaveLength(3);
    appSessions = sessionsByType(db, 'desktop_app');
    const finalApp = appSessions.find(s => s.session_id === newAppSessionId)!;
    expect(finalApp.end_time >= finalApp.start_time).toBe(true);
    // Verify all sessions are properly populated
    for (const row of rows) {
      expect(row.session_id).toMatch(ULID_RE);
      expect(row.end_time).toBeTruthy();
      expect(row.device_id).toBe('test-device-id');
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeTruthy();
    }
  });

  it('backfills user_id on all active sessions when user logs in after activity', () => {
    const { db, tracker } = harness;

    // App starts with no user
    tracker.recordAppStarted();
    let rows = allSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();

    // Window focused before login
    tracker.processEvent(makeEvent({
      event: 'WINDOW_FOCUSED',
      window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
    } as any));
    let focused = sessionsByType(db, 'word_window_focused');
    expect(focused).toHaveLength(1);
    expect(focused[0].user_id).toBeNull();

    // Now user logs in — both active sessions should get user_id backfilled
    tracker.recordUserLoggedIn(456);
    rows = allSessions(db);
    expect(rows).toHaveLength(2); // desktop_app + word_window_focused
    for (const row of rows) {
      expect(row.user_id).toBe(456);
    }

    // Clean up
    tracker.recordAppStopping();
  });

  describe('word_window_focused sessions', () => {
    it('creates a session on WINDOW_FOCUSED with document_path data', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const focused = sessionsByType(db, 'word_window_focused');
      expect(focused).toHaveLength(1);
      const data = JSON.parse(focused[0].data);
      expect(data.document_path).toBe('/known/project/doc.docx');
      expect(data.project_id).toBe(42);
      expect(data.project_file_id).toBe(100);
      expect(data.window_id).toBe('win-1');
    });

    it('creates a session with null document_path', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Untitled', documentPath: null, bounds: defaultBounds },
      } as any));

      const focused = sessionsByType(db, 'word_window_focused');
      expect(focused).toHaveLength(1);
      const data = JSON.parse(focused[0].data);
      expect(data.document_path).toBeNull();
      expect(data.project_id).toBeNull();
    });

    it('closes on APP_UNFOCUSED', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      const sessionId = before[0].session_id;

      tracker.processEvent(makeEvent({ event: 'APP_UNFOCUSED' } as any));

      const after = sessionsByType(db, 'word_window_focused');
      const closed = after.find(s => s.session_id === sessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);
    });

    it('closes on APP_TERMINATED', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      // Register the window so windowToApp maps it
      tracker.processEvent(makeEvent({
        event: 'WINDOW_CREATED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      const sessionId = before[0].session_id;

      tracker.processEvent(makeEvent({ event: 'APP_TERMINATED' }));

      const after = sessionsByType(db, 'word_window_focused');
      const closed = after.find(s => s.session_id === sessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);
    });

    it('switches windows: closes old session and opens new', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc1', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const firstFocused = sessionsByType(db, 'word_window_focused');
      expect(firstFocused).toHaveLength(1);
      const firstSessionId = firstFocused[0].session_id;

      // Focus a different window
      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-2', title: 'Doc2', documentPath: '/unknown/doc.docx', bounds: defaultBounds },
      } as any));

      const allFocused = sessionsByType(db, 'word_window_focused');
      expect(allFocused).toHaveLength(2);

      // First should be closed
      const closed = allFocused.find(s => s.session_id === firstSessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);

      // Second should be open with the new path
      const newSession = allFocused.find(s => s.session_id !== firstSessionId)!;
      const data = JSON.parse(newSession.data);
      expect(data.document_path).toBe('/unknown/doc.docx');
      expect(data.window_id).toBe('win-2');
    });

    it('closes on WINDOW_DESTROYED of focused window', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_CREATED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      const sessionId = before[0].session_id;

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DESTROYED',
        window: { id: 'win-1', title: null, documentPath: null, bounds: null },
      } as any));

      const after = sessionsByType(db, 'word_window_focused');
      const closed = after.find(s => s.session_id === sessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);
    });

    it('WINDOW_DOCUMENT_PATH_CHANGED: null → path updates session data', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      // Focus a window with no document path
      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Untitled', documentPath: null, bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      expect(before).toHaveLength(1);
      const sessionId = before[0].session_id;
      expect(JSON.parse(before[0].data).document_path).toBeNull();

      // Path becomes available (Save As)
      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_PATH_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      // Should still be 1 session (data updated, not closed+reopened)
      const after = sessionsByType(db, 'word_window_focused');
      expect(after).toHaveLength(1);
      expect(after[0].session_id).toBe(sessionId);
      const data = JSON.parse(after[0].data);
      expect(data.document_path).toBe('/known/project/doc.docx');
      expect(data.project_id).toBe(42);
      expect(data.project_file_id).toBe(100);
    });

    it('WINDOW_DOCUMENT_PATH_CHANGED: path → path closes and reopens session', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      // Focus a window with a document path
      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      expect(before).toHaveLength(1);
      const firstSessionId = before[0].session_id;

      // Path changes to a different document
      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_PATH_CHANGED',
        window: { id: 'win-1', title: 'New Doc', documentPath: '/unknown/doc.docx', bounds: defaultBounds },
      } as any));

      // Should be 2 sessions: first closed, second opened
      const after = sessionsByType(db, 'word_window_focused');
      expect(after).toHaveLength(2);

      const closed = after.find(s => s.session_id === firstSessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);

      const newSession = after.find(s => s.session_id !== firstSessionId)!;
      const data = JSON.parse(newSession.data);
      expect(data.document_path).toBe('/unknown/doc.docx');
      expect(data.project_id).toBeNull();
    });

    it('WINDOW_DOCUMENT_PATH_CHANGED is a no-op for non-focused window', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      // Focus win-1
      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      expect(before).toHaveLength(1);

      // Path changes on a different (non-focused) window
      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_PATH_CHANGED',
        window: { id: 'win-2', title: 'Other', documentPath: '/other/doc.docx', bounds: defaultBounds },
      } as any));

      // Still only 1 focused session, unchanged
      const after = sessionsByType(db, 'word_window_focused');
      expect(after).toHaveLength(1);
      expect(after[0].session_id).toBe(before[0].session_id);
    });

    it('extends focused session during periodic flush', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      const endTimeBefore = before[0].end_time;

      jest.useFakeTimers();
      tracker.startPeriodicFlush(1000);
      jest.advanceTimersByTime(1000);
      tracker.stopPeriodicFlush();
      jest.useRealTimers();

      const after = sessionsByType(db, 'word_window_focused');
      expect(after[0].end_time >= endTimeBefore).toBe(true);
    });

    it('backfills user_id on login', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      let focused = sessionsByType(db, 'word_window_focused');
      expect(focused[0].user_id).toBeNull();

      tracker.recordUserLoggedIn(789);

      focused = sessionsByType(db, 'word_window_focused');
      expect(focused[0].user_id).toBe(789);
    });

    it('closes on logout', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();
      tracker.recordUserLoggedIn(100);

      tracker.processEvent(makeEvent({
        event: 'WINDOW_FOCUSED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const before = sessionsByType(db, 'word_window_focused');
      const sessionId = before[0].session_id;

      tracker.recordUserLoggedOut();

      const after = sessionsByType(db, 'word_window_focused');
      const closed = after.find(s => s.session_id === sessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);
    });
  });

  describe('document_text_change sessions', () => {
    let dateNowSpy: jest.SpyInstance;

    afterEach(() => {
      if (dateNowSpy) dateNowSpy.mockRestore();
    });

    it('creates a session on WINDOW_DOCUMENT_TEXT_CHANGED', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      // Need a window registered so windowToApp is populated
      tracker.processEvent(makeEvent({
        event: 'WINDOW_CREATED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const textChangeSessions = sessionsByType(db, 'document_text_change');
      expect(textChangeSessions).toHaveLength(1);
      const data = JSON.parse(textChangeSessions[0].data);
      expect(data.document_path).toBe('/known/project/doc.docx');
      expect(data.project_id).toBe(42);
      expect(data.project_file_id).toBe(100);
      expect(data.window_id).toBe('win-1');
    });

    it('groups events within 1 minute into the same session', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      const baseTime = 1000000;
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      // 30 seconds later — within gap
      dateNowSpy.mockReturnValue(baseTime + 30_000);

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const textChangeSessions = sessionsByType(db, 'document_text_change');
      expect(textChangeSessions).toHaveLength(1);
      // end_time should have been updated (extended)
      expect(textChangeSessions[0].end_time >= textChangeSessions[0].start_time).toBe(true);
    });

    it('splits into a new session after > 1 minute gap', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      const baseTime = 1000000;
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      // 61 seconds later — exceeds gap
      dateNowSpy.mockReturnValue(baseTime + 61_000);

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const textChangeSessions = sessionsByType(db, 'document_text_change');
      expect(textChangeSessions).toHaveLength(2);
      expect(textChangeSessions[0].session_id).not.toBe(textChangeSessions[1].session_id);
    });

    it('cleans up on WINDOW_DESTROYED', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_CREATED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      let textChangeSessions = sessionsByType(db, 'document_text_change');
      expect(textChangeSessions).toHaveLength(1);
      const sessionId = textChangeSessions[0].session_id;

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DESTROYED',
        window: { id: 'win-1', title: null, documentPath: null, bounds: null },
      } as any));

      textChangeSessions = sessionsByType(db, 'document_text_change');
      const closed = textChangeSessions.find(s => s.session_id === sessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);
      expect(closed.updated_at >= closed.created_at).toBe(true);
    });

    it('cleans up on APP_TERMINATED', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_CREATED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      let textChangeSessions = sessionsByType(db, 'document_text_change');
      expect(textChangeSessions).toHaveLength(1);
      const sessionId = textChangeSessions[0].session_id;

      tracker.processEvent(makeEvent({ event: 'APP_TERMINATED' }));

      textChangeSessions = sessionsByType(db, 'document_text_change');
      const closed = textChangeSessions.find(s => s.session_id === sessionId)!;
      expect(closed.end_time >= closed.start_time).toBe(true);
    });

    it('backfills user_id on login', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      let textChangeSessions = sessionsByType(db, 'document_text_change');
      expect(textChangeSessions).toHaveLength(1);
      expect(textChangeSessions[0].user_id).toBeNull();

      tracker.recordUserLoggedIn(789);

      textChangeSessions = sessionsByType(db, 'document_text_change');
      expect(textChangeSessions[0].user_id).toBe(789);
    });

    it('does not extend text change sessions during periodic flush', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();

      tracker.processEvent(makeEvent({
        event: 'WINDOW_DOCUMENT_TEXT_CHANGED',
        window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
      } as any));

      const textChangeSessions = sessionsByType(db, 'document_text_change');
      const endTimeBefore = textChangeSessions[0].end_time;
      const updatedAtBefore = textChangeSessions[0].updated_at;

      jest.useFakeTimers();
      tracker.startPeriodicFlush(1000);
      jest.advanceTimersByTime(1000);
      tracker.stopPeriodicFlush();
      jest.useRealTimers();

      const after = sessionsByType(db, 'document_text_change');
      expect(after[0].end_time).toBe(endTimeBefore);
      expect(after[0].updated_at).toBe(updatedAtBefore);
    });
  });

  describe('session retention', () => {
    const REAL_DATE_NOW = Date.now;
    const REAL_DATE = global.Date;

    afterEach(() => {
      global.Date = REAL_DATE;
      Date.now = REAL_DATE_NOW;
    });

    function mockDate(isoDate: string): void {
      const fixedTime = new REAL_DATE(isoDate).getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedTime);
      const OrigDate = REAL_DATE;
      const MockDate = function (...args: unknown[]) {
        if (args.length === 0) {
          return new OrigDate(fixedTime);
        }
        // @ts-expect-error — spread into Date constructor
        return new OrigDate(...args);
      } as unknown as DateConstructor;
      MockDate.now = () => fixedTime;
      MockDate.parse = OrigDate.parse;
      MockDate.UTC = OrigDate.UTC;
      Object.defineProperty(MockDate, 'prototype', { value: OrigDate.prototype });
      global.Date = MockDate;
    }

    function insertOldSession(db: Database.Database, endTime: string): void {
      db.prepare(
        `INSERT INTO sessions (session_id, session_type, user_id, start_time, end_time, data, device_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`old-${endTime}`, 'desktop_app', null, endTime, endTime, '{}', 'test-device', endTime, endTime);
    }

    it('deletes sessions older than 14 days', () => {
      const { db, tracker } = createTestHarness();

      // Insert a session with end_time 20 days ago
      const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      insertOldSession(db, oldTime);

      expect(allSessions(db)).toHaveLength(1);

      tracker.recordAppStarted(); // triggers purge

      // Old session should be deleted, only the new desktop_app session remains
      const rows = allSessions(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].session_type).toBe('desktop_app');
      expect(rows[0].session_id).not.toBe(`old-${oldTime}`);

      db.close();
    });

    it('keeps sessions newer than 14 days', () => {
      const { db, tracker } = createTestHarness();

      // Insert a session with end_time 5 days ago (within retention)
      const recentTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      insertOldSession(db, recentTime);

      expect(allSessions(db)).toHaveLength(1);

      tracker.recordAppStarted(); // triggers purge

      // Recent session should survive + new desktop_app session
      const rows = allSessions(db);
      expect(rows).toHaveLength(2);
      expect(rows.some(r => r.session_id === `old-${recentTime}`)).toBe(true);

      db.close();
    });

    it('only runs cleanup once per day', () => {
      const { db, tracker } = createTestHarness();

      mockDate('2026-02-20T10:00:00.000Z');

      tracker.recordAppStarted(); // first call — runs purge

      // Check metadata was set
      const meta = db.prepare('SELECT value FROM session_metadata WHERE key = ?').get('last_cleanup_date') as { value: string };
      expect(meta.value).toBe('2026-02-20');

      // Insert an old session AFTER first purge
      const oldTime = new Date(new REAL_DATE('2026-02-01T00:00:00.000Z')).toISOString();
      insertOldSession(db, oldTime);

      // Second recordAppStarted same day — should NOT purge
      tracker.recordAppStopping();
      tracker.recordAppStarted();

      // The old session should still be there (cleanup was skipped)
      const rows = allSessions(db);
      expect(rows.some(r => r.session_id === `old-${oldTime}`)).toBe(true);

      db.close();
    });

    it('runs cleanup again the next day', () => {
      const { db, tracker } = createTestHarness();

      mockDate('2026-02-20T10:00:00.000Z');

      tracker.recordAppStarted(); // day 1 purge

      // Insert an old session after day 1 purge
      const oldTime = new REAL_DATE('2026-02-01T00:00:00.000Z').toISOString();
      insertOldSession(db, oldTime);

      // Advance to next day
      tracker.recordAppStopping();
      mockDate('2026-02-21T10:00:00.000Z');

      tracker.recordAppStarted(); // day 2 purge — should run

      // The old session should now be deleted
      const rows = allSessions(db);
      expect(rows.every(r => r.session_id !== `old-${oldTime}`)).toBe(true);

      // Metadata should reflect the new date
      const meta = db.prepare('SELECT value FROM session_metadata WHERE key = ?').get('last_cleanup_date') as { value: string };
      expect(meta.value).toBe('2026-02-21');

      db.close();
    });
  });

  describe('fetchSessionsToSync', () => {
    it('returns sessions with user_id where synced_at is null', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();
      tracker.recordUserLoggedIn(100);

      const toSync = tracker.fetchSessionsToSync();
      expect(toSync.length).toBe(1); // desktop_app only
      for (const row of toSync) {
        expect(row.user_id).toBe(100);
        expect(row.synced_at).toBeNull();
      }
    });

    it('excludes sessions without user_id', () => {
      const { tracker } = harness;
      tracker.recordAppStarted(); // no login — user_id is null

      const toSync = tracker.fetchSessionsToSync();
      expect(toSync).toHaveLength(0);
    });

    it('excludes sessions that have been synced and not updated', () => {
      const { tracker } = harness;
      tracker.recordAppStarted();
      tracker.recordUserLoggedIn(100);

      const before = tracker.fetchSessionsToSync();
      expect(before).toHaveLength(1);

      tracker.updateSessionSyncTime(before.map(s => s.session_id));

      const after = tracker.fetchSessionsToSync();
      expect(after).toHaveLength(0);
    });

    it('returns sessions again after updated_at is bumped past synced_at', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();
      tracker.recordUserLoggedIn(100);

      const before = tracker.fetchSessionsToSync();
      tracker.updateSessionSyncTime(before.map(s => s.session_id));
      expect(tracker.fetchSessionsToSync()).toHaveLength(0);

      // Simulate periodic flush bumping updated_at
      const sessionId = before[0].session_id;
      const futureTime = new Date(Date.now() + 60_000).toISOString();
      db.prepare('UPDATE sessions SET end_time = ?, updated_at = ? WHERE session_id = ?')
        .run(futureTime, futureTime, sessionId);

      const after = tracker.fetchSessionsToSync();
      expect(after).toHaveLength(1);
      expect(after[0].session_id).toBe(sessionId);
    });
  });
});
