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
import { createActivityTracker, type ActivityTracker } from '../activityTrackerFactory';

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
  const tracker = createActivityTracker(sessionDb);
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

describe('activityTracker', () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.db.close();
  });

  it('tracks the full lifecycle: app start → login → Word events → logout → app stop', () => {
    const { db, tracker } = harness;

    // Step 1: recordAppStarted → 1 row, app session, user_id=null
    tracker.recordAppStarted();
    let rows = allSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toMatch(ULID_RE);
    expect(rows[0].session_type).toBe('app');
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].device_id).toBe('test-device-id');
    expect(rows[0].created_at).toBe(rows[0].start_time);
    expect(rows[0].updated_at).toBe(rows[0].start_time);
    const appSessionId = rows[0].session_id;

    // Step 2: recordUserLoggedIn → app session now has user_id=123
    tracker.recordUserLoggedIn(123);
    let appSessions = sessionsByType(db, 'app');
    expect(appSessions[0].user_id).toBe(123);
    expect(appSessions[0].updated_at >= appSessions[0].created_at).toBe(true);

    // Step 3: processEvent(APP_LAUNCHED) → 2 rows: app + word_app
    tracker.processEvent(makeEvent({ event: 'APP_LAUNCHED' }));
    rows = allSessions(db);
    expect(rows).toHaveLength(2);
    let wordApps = sessionsByType(db, 'word_app');
    expect(wordApps).toHaveLength(1);
    expect(wordApps[0].session_id).toMatch(ULID_RE);
    expect(wordApps[0].user_id).toBe(123);
    expect(wordApps[0].device_id).toBe('test-device-id');
    const wordAppSessionId = wordApps[0].session_id;

    // Step 4: processEvent(APP_LAUNCHED same PID) → still 2 rows (deduped)
    tracker.processEvent(makeEvent({ event: 'APP_LAUNCHED' }));
    rows = allSessions(db);
    expect(rows).toHaveLength(2);

    // Step 5: processEvent(WINDOW_CREATED with known project path) → 3 rows
    tracker.processEvent(makeEvent({
      event: 'WINDOW_CREATED',
      window: { id: 'win-1', title: 'Document', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
    } as any));
    rows = allSessions(db);
    expect(rows).toHaveLength(3);
    let docs = sessionsByType(db, 'document');
    expect(docs).toHaveLength(1);
    expect(docs[0].session_id).toMatch(ULID_RE);
    const docData = JSON.parse(docs[0].data);
    expect(docData.project_id).toBe(42);
    expect(docData.project_file_id).toBe(100);
    expect(docData.document_path).toBe('/known/project/doc.docx');
    const firstDocId = docs[0].session_id;

    // Step 6: processEvent(WINDOW_DOCUMENT_PATH_CHANGED to unknown path) → 4 rows
    tracker.processEvent(makeEvent({
      event: 'WINDOW_DOCUMENT_PATH_CHANGED',
      window: { id: 'win-1', title: 'New Doc', documentPath: '/unknown/doc.docx', bounds: defaultBounds },
    } as any));
    rows = allSessions(db);
    expect(rows).toHaveLength(4);
    docs = sessionsByType(db, 'document');
    expect(docs).toHaveLength(2);
    // Old doc session should be closed
    const closedDoc = docs.find(d => d.session_id === firstDocId)!;
    expect(closedDoc.end_time >= closedDoc.start_time).toBe(true);
    // New doc session should have null project_id
    const newDoc = docs.find(d => d.session_id !== firstDocId)!;
    expect(newDoc.session_id).toMatch(ULID_RE);
    const newDocData = JSON.parse(newDoc.data);
    expect(newDocData.project_id).toBeNull();
    const secondDocId = newDoc.session_id;

    // Step 7: processEvent(WINDOW_DESTROYED) → new doc session has end_time set
    tracker.processEvent(makeEvent({
      event: 'WINDOW_DESTROYED',
      window: { id: 'win-1', title: null, documentPath: null, bounds: null },
    } as any));
    rows = allSessions(db);
    expect(rows).toHaveLength(4);
    docs = sessionsByType(db, 'document');
    const destroyedDoc = docs.find(d => d.session_id === secondDocId)!;
    expect(destroyedDoc.end_time >= destroyedDoc.start_time).toBe(true);
    expect(destroyedDoc.updated_at >= destroyedDoc.created_at).toBe(true);

    // Step 8: processEvent(APP_TERMINATED) → word_app session has end_time set
    tracker.processEvent(makeEvent({ event: 'APP_TERMINATED' }));
    rows = allSessions(db);
    expect(rows).toHaveLength(4);
    wordApps = sessionsByType(db, 'word_app');
    expect(wordApps[0].end_time >= wordApps[0].start_time).toBe(true);

    // Step 9: processEvent(WINDOW_FOCUSED) → same row count (ignored event)
    tracker.processEvent(makeEvent({
      event: 'WINDOW_FOCUSED',
      window: { id: 'win-99', title: 'Some Doc', documentPath: null, bounds: defaultBounds },
    } as any));
    rows = allSessions(db);
    expect(rows).toHaveLength(4);

    // Step 10: recordUserLoggedOut → all prior sessions closed, new app session with user_id=null
    tracker.recordUserLoggedOut();
    rows = allSessions(db);
    expect(rows).toHaveLength(5);
    appSessions = sessionsByType(db, 'app');
    expect(appSessions).toHaveLength(2);
    // Old app session should be closed
    const closedApp = appSessions.find(s => s.session_id === appSessionId)!;
    expect(closedApp.end_time >= closedApp.start_time).toBe(true);
    // New app session should have user_id=null
    const newApp = appSessions.find(s => s.session_id !== appSessionId)!;
    expect(newApp.session_id).toMatch(ULID_RE);
    expect(newApp.user_id).toBeNull();
    expect(newApp.device_id).toBe('test-device-id');
    const newAppSessionId = newApp.session_id;

    // Step 11: recordAppStopping → all sessions have final end_time
    tracker.recordAppStopping();
    rows = allSessions(db);
    expect(rows).toHaveLength(5);
    appSessions = sessionsByType(db, 'app');
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

    // Word launches before login
    tracker.processEvent(makeEvent({ event: 'APP_LAUNCHED' }));
    let wordApps = sessionsByType(db, 'word_app');
    expect(wordApps).toHaveLength(1);
    expect(wordApps[0].user_id).toBeNull();

    // Document opens before login
    tracker.processEvent(makeEvent({
      event: 'WINDOW_CREATED',
      window: { id: 'win-1', title: 'Doc', documentPath: '/known/project/doc.docx', bounds: defaultBounds },
    } as any));
    let docs = sessionsByType(db, 'document');
    expect(docs).toHaveLength(1);
    expect(docs[0].user_id).toBeNull();

    // Now user logs in — all 3 active sessions should get user_id backfilled
    tracker.recordUserLoggedIn(456);
    rows = allSessions(db);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.user_id).toBe(456);
    }

    // Clean up
    tracker.recordAppStopping();
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
      tracker.processEvent(makeEvent({ event: 'APP_LAUNCHED' }));

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

      // Trigger periodic flush via startPeriodicFlush + manual interval
      // Instead, we directly call recordAppStopping and check that text change sessions
      // are handled separately. For flush specifically, we check that extendActiveSessions
      // does NOT touch text change sessions by examining the end_time via a raw query.
      // Simulate a flush by updating app/word_app/document sessions only.
      // The simplest way: read the session after flush timer fires.
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

  describe('fetchSessionsToSync', () => {
    it('returns sessions with user_id where synced_at is null', () => {
      const { db, tracker } = harness;
      tracker.recordAppStarted();
      tracker.recordUserLoggedIn(100);
      tracker.processEvent(makeEvent({ event: 'APP_LAUNCHED' }));

      const toSync = tracker.fetchSessionsToSync();
      expect(toSync.length).toBe(2); // app + word_app
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
