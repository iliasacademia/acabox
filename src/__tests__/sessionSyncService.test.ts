import type { ActivityTracker, SessionRow } from '../activityTrackerFactory';

// --- Mocks ---

const mockInfo = jest.fn();
jest.mock('../utils/logger', () => ({
  defaultLogger: {
    info: mockInfo,
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- Import after mocks ---

import { sessionSyncService } from '../sessionSyncService';

// --- Helpers ---

function makeMockTracker(sessions: SessionRow[] = []): ActivityTracker {
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
    session_type: 'app',
    user_id: 100,
    start_time: '2025-01-01T00:00:00.000Z',
    end_time: '2025-01-01T00:05:00.000Z',
    data: '{}',
    device_id: 'test-device',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:05:00.000Z',
    synced_at: null,
    ...overrides,
  };
}

// --- Tests ---

describe('sessionSyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    sessionSyncService.stop();
  });

  it('logs count of pending sessions when there are sessions to sync', () => {
    const sessions = [makeSession(), makeSession({ session_id: 'test-session-2' })];
    const tracker = makeMockTracker(sessions);

    sessionSyncService.syncNow(tracker);

    expect(tracker.fetchSessionsToSync).toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith('[SessionSync] 2 session(s) pending sync');
  });

  it('does not log when no sessions to sync', () => {
    const tracker = makeMockTracker([]);

    sessionSyncService.syncNow(tracker);

    expect(tracker.fetchSessionsToSync).toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
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
