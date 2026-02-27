import type { SessionsTracker, SessionRow } from '../sessionsTrackerFactory';

// --- Mocks ---

const mockInfo = jest.fn();
const mockWarn = jest.fn();
const mockError = jest.fn();
jest.mock('../utils/logger', () => ({
  defaultLogger: {
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: jest.fn(),
  },
}));

const mockPost = jest.fn();
jest.mock('../apiClient', () => ({
  APIclient: jest.fn(() => Promise.resolve({ post: mockPost })),
  getCsrfToken: jest.fn(() => Promise.resolve('test-csrf-token')),
}));

// --- Import after mocks ---

import { sessionSyncService } from '../sessionSyncService';

// --- Helpers ---

function makeMockTracker(sessions: SessionRow[] = []): SessionsTracker {
  return {
    recordAppStarted: jest.fn(),
    recordUserLoggedIn: jest.fn(),
    recordUserLoggedOut: jest.fn(),
    recordAppStopping: jest.fn(),
    processEvent: jest.fn(),
    startPeriodicFlush: jest.fn(),
    stopPeriodicFlush: jest.fn(),
    fetchSessionsToSync: jest.fn(() => sessions),
    updateSessionSyncTime: jest.fn(),
  };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: 'test-session-1',
    session_type: 'desktop_app',
    user_id: 100,
    start_time: '2025-01-01T00:00:00.000Z',
    end_time: '2025-01-01T00:05:00.000Z',
    data: '{}',
    device_id: 'test-device',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:05:00.000Z',
    synced_at: null,
    app_version: '1.0.0-test',
    ...overrides,
  };
}

// --- Tests ---

describe('sessionSyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPost.mockResolvedValue({ status: 200, data: { success: true, synced_count: 1 } });
  });

  afterEach(() => {
    sessionSyncService.stop();
  });

  it('successful sync calls API with correct payload and marks sessions synced', async () => {
    const sessions = [
      makeSession({ data: '{"doc":"test.docx"}' }),
      makeSession({ session_id: 'test-session-2', start_time: '2025-01-01T00:01:00.000Z' }),
    ];
    const tracker = makeMockTracker(sessions);

    await sessionSyncService.syncNow(tracker);

    expect(tracker.fetchSessionsToSync).toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith(
      '/v0/co_scientist/sessions/sync',
      {
        sessions: [
          {
            session_id: 'test-session-1',
            session_type: 'desktop_app',
            start_time: '2025-01-01T00:00:00.000Z',
            end_time: '2025-01-01T00:05:00.000Z',
            data: { doc: 'test.docx' },
            device_id: 'test-device',
            app_version: '1.0.0-test',
            client_created_at: '2025-01-01T00:00:00.000Z',
            client_updated_at: '2025-01-01T00:05:00.000Z',
          },
          {
            session_id: 'test-session-2',
            session_type: 'desktop_app',
            start_time: '2025-01-01T00:01:00.000Z',
            end_time: '2025-01-01T00:05:00.000Z',
            data: {},
            device_id: 'test-device',
            app_version: '1.0.0-test',
            client_created_at: '2025-01-01T00:00:00.000Z',
            client_updated_at: '2025-01-01T00:05:00.000Z',
          },
        ],
      },
      { headers: { 'x-csrf-token': 'test-csrf-token' } },
    );
    expect(tracker.updateSessionSyncTime).toHaveBeenCalledWith(['test-session-1', 'test-session-2']);
    expect(mockInfo).toHaveBeenCalledWith('[SessionSync] Synced 2 session(s)');
  });

  it('parses data field from JSON string to object in payload', async () => {
    const sessions = [makeSession({ data: '{"project_id":42,"path":"/doc.docx"}' })];
    const tracker = makeMockTracker(sessions);

    await sessionSyncService.syncNow(tracker);

    const payload = mockPost.mock.calls[0][1];
    expect(payload.sessions[0].data).toEqual({ project_id: 42, path: '/doc.docx' });
  });

  it('does not call API when no sessions to sync', async () => {
    const tracker = makeMockTracker([]);

    await sessionSyncService.syncNow(tracker);

    expect(tracker.fetchSessionsToSync).toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(tracker.updateSessionSyncTime).not.toHaveBeenCalled();
  });

  it('when >1000 sessions, only first 1000 sorted by start_time are sent and anomaly is logged', async () => {
    const sessions: SessionRow[] = [];
    for (let i = 0; i < 1005; i++) {
      const paddedIndex = String(i).padStart(4, '0');
      sessions.push(makeSession({
        session_id: `session-${paddedIndex}`,
        start_time: `2025-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }));
    }
    // Shuffle to verify sorting
    sessions.reverse();
    const tracker = makeMockTracker(sessions);

    await sessionSyncService.syncNow(tracker);

    const payload = mockPost.mock.calls[0][1];
    expect(payload.sessions).toHaveLength(1000);
    // First session should be the earliest start_time
    expect(payload.sessions[0].session_id).toBe('session-0000');
    expect(payload.sessions[999].session_id).toBe('session-0999');

    expect(tracker.updateSessionSyncTime).toHaveBeenCalledWith(
      expect.arrayContaining(['session-0000', 'session-0999']),
    );
    const syncedIds = (tracker.updateSessionSyncTime as jest.Mock).mock.calls[0][0];
    expect(syncedIds).toHaveLength(1000);

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('1005 sessions pending'),
    );
    expect(mockInfo).toHaveBeenCalledWith('[SessionSync] Synced 1000 session(s)');
  });

  it('on API error, logs error and does not mark sessions synced', async () => {
    mockPost.mockRejectedValue({ response: { status: 500, data: 'Internal Server Error' } });
    const sessions = [makeSession()];
    const tracker = makeMockTracker(sessions);

    await sessionSyncService.syncNow(tracker);

    expect(tracker.updateSessionSyncTime).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith('[SessionSync] Sync failed:', expect.anything());
  });

  it('on network error, logs error and does not mark sessions synced', async () => {
    mockPost.mockRejectedValue(new Error('Network Error'));
    const sessions = [makeSession()];
    const tracker = makeMockTracker(sessions);

    await sessionSyncService.syncNow(tracker);

    expect(tracker.updateSessionSyncTime).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith('[SessionSync] Sync failed:', expect.any(Error));
  });

  it('start sets up an interval and stop clears it', () => {
    jest.useFakeTimers();
    const sessions = [makeSession()];
    const tracker = makeMockTracker(sessions);

    sessionSyncService.start(tracker, 1000);

    // No call yet
    expect(tracker.fetchSessionsToSync).not.toHaveBeenCalled();

    // Advance timer
    jest.advanceTimersByTime(1000);
    expect(tracker.fetchSessionsToSync).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    expect(tracker.fetchSessionsToSync).toHaveBeenCalledTimes(2);

    // Stop should prevent further calls
    sessionSyncService.stop();
    jest.advanceTimersByTime(1000);
    expect(tracker.fetchSessionsToSync).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});
