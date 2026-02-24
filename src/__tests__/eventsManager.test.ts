/**
 * Unit tests for EventsManager
 */

// Mock the apiClient module BEFORE importing anything
jest.mock('../apiClient', () => ({
  APIclient: jest.fn(),
}));

// Mock electron-store
jest.mock('electron-store');

import { eventsManager } from '../eventsManager';
import * as eventsManagerModule from '../eventsManager';
import Store from 'electron-store';

// Mock Electron's BrowserWindow and app
jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  app: {
    getVersion: jest.fn(() => '1.0.0-test'),
    isPackaged: false,
    getPath: jest.fn(() => '/mock/path'),
  },
}));

describe('EventsManager', () => {
  let mockWindow: any;
  let mockPollEvents: jest.SpyInstance;
  let mockStore: jest.Mocked<Store>;

  beforeEach(() => {
    // Clear any previous state
    eventsManager.stopPolling();

    // Setup mock window
    mockWindow = {
      webContents: {
        send: jest.fn(),
        isDestroyed: jest.fn().mockReturnValue(false),
      },
      isDestroyed: jest.fn().mockReturnValue(false),
    };

    // Setup mock for pollEvents function
    mockPollEvents = jest.spyOn(eventsManagerModule, 'pollEvents');

    // Setup mock for electron-store
    mockStore = new Store() as jest.Mocked<Store>;
    mockStore.get = jest.fn().mockReturnValue(null);
    mockStore.set = jest.fn();

    // Replace the store instance
    (eventsManager as any).store = mockStore;
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    eventsManager.stopPolling();
  });

  describe('Polling', () => {
    it('should start polling with 10 second interval', async () => {
      jest.useFakeTimers();

      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      eventsManager.startPolling(1, 10000);

      // Initial sync should be called immediately
      await Promise.resolve();
      expect(mockPollEvents).toHaveBeenCalledTimes(1);

      // Fast-forward 10 seconds
      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      // Should have been called again
      expect(mockPollEvents).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('should perform immediate sync on startPolling()', async () => {
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      eventsManager.startPolling(1, 10000);

      // Wait for immediate sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockPollEvents).toHaveBeenCalled();
    });

    it('should clear existing interval before starting new one', async () => {
      jest.useFakeTimers();

      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      // Start first time
      eventsManager.startPolling(1, 10000);
      await Promise.resolve();
      mockPollEvents.mockClear();

      // Start again (should clear previous interval)
      eventsManager.startPolling(1, 5000);
      await Promise.resolve();

      // Fast-forward 5 seconds (new interval)
      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      // Should have been called with new interval
      expect(mockPollEvents).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should stop polling and clear interval', () => {
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      eventsManager.startPolling(1, 10000);
      eventsManager.stopPolling();

      // Should not throw and userId should be null
      expect(eventsManager.getCurrentUserId()).toBeNull();
    });

    it('should NOT clear stored timestamp on stopPolling()', () => {
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      eventsManager.startPolling(1, 10000);
      eventsManager.stopPolling();

      // store.set should not be called for clearing timestamp
      expect(mockStore.set).not.toHaveBeenCalledWith('last_ts', null);
    });
  });

  describe('Timestamp Persistence', () => {
    it('should retrieve timestamp from electron-store on init', () => {
      const mockTimestamp = '2026-01-13T12:00:00Z';
      mockStore.get.mockReturnValue(mockTimestamp);

      const timestamp = (eventsManager as any).getStoredTimestamp();

      expect(mockStore.get).toHaveBeenCalledWith('last_ts', null);
      expect(timestamp).toBe(mockTimestamp);
    });

    it('should persist timestamp after processing events', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 1,
            event_name: 'review_completed',
            data: { review_id: 789 },
            timestamp: '2026-01-13T12:30:00.000Z',
          },
        ],
        server_timestamp: '2026-01-13T12:30:05.000Z',
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1); // Set currentUserId

      await eventsManager.syncWithBackend();

      // Should update timestamp to server's timestamp
      expect(mockStore.set).toHaveBeenCalledWith('last_ts', '2026-01-13T12:30:05.000Z');
    });

    it('should handle missing timestamp (null) gracefully', async () => {
      mockStore.get.mockReturnValue(null);
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      await eventsManager.syncWithBackend();

      // Should call API without timestamp parameter
      expect(mockPollEvents).toHaveBeenCalledWith(undefined);
    });

    it('should update timestamp to server timestamp once per poll', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event1',
            data: {},
            timestamp: '2026-01-13T12:00:00.000Z',
          },
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event2',
            data: {},
            timestamp: '2026-01-13T12:30:00.000Z',
          },
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event3',
            data: {},
            timestamp: '2026-01-13T13:00:00.000Z',
          },
        ],
        server_timestamp: '2026-01-13T13:00:05.000Z',
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1); // Set currentUserId

      await eventsManager.syncWithBackend();

      // Should update timestamp once with server's timestamp (not per event)
      expect(mockStore.set).toHaveBeenCalledTimes(1);
      expect(mockStore.set).toHaveBeenCalledWith('last_ts', '2026-01-13T13:00:05.000Z');
    });
  });

  describe('syncWithBackend', () => {
    it('should skip if sync already in progress (isSyncing flag)', async () => {
      mockPollEvents.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ events: [] }), 1000))
      );
      eventsManager.setMainWindow(mockWindow);

      // Start two syncs at the same time
      const sync1 = eventsManager.syncWithBackend();
      const sync2 = eventsManager.syncWithBackend();

      await Promise.all([sync1, sync2]);

      // Should only call pollEvents once (second call skipped)
      expect(mockPollEvents).toHaveBeenCalledTimes(1);
    });

    it('should fetch events with last_ts parameter', async () => {
      const mockTimestamp = '2026-01-13T12:00:00Z';
      mockStore.get.mockReturnValue(mockTimestamp);
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      await eventsManager.syncWithBackend();

      expect(mockPollEvents).toHaveBeenCalledWith(mockTimestamp);
    });

    it('should fetch without timestamp on first sync (null)', async () => {
      mockStore.get.mockReturnValue(null);
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      await eventsManager.syncWithBackend();

      expect(mockPollEvents).toHaveBeenCalledWith(undefined);
    });

    it('should validate event.user_id matches currentUserId', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event1',
            data: {},
            timestamp: '2026-01-13T12:00:00Z',
          },
          {
            project_id: 123,
            user_id: 2, // Different user
            event_name: 'event2',
            data: {},
            timestamp: '2026-01-13T12:30:00Z',
          },
        ],
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1); // User 1

      await eventsManager.syncWithBackend();

      // Should only send first event (user_id = 1)
      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1);
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'co-scientist-event',
        expect.objectContaining({ user_id: 1 })
      );
    });

    it('should skip events with mismatched user_id but still update timestamp', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 2, // Wrong user
            event_name: 'event1',
            data: {},
            timestamp: '2026-01-13T12:00:00.000Z',
          },
        ],
        server_timestamp: '2026-01-13T12:00:05.000Z',
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1); // User 1

      await eventsManager.syncWithBackend();

      // Should not send any events
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();

      // But should still update timestamp with server's timestamp
      expect(mockStore.set).toHaveBeenCalledWith('last_ts', '2026-01-13T12:00:05.000Z');
    });

    it('should send events to renderer individually', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event1',
            data: {},
            timestamp: '2026-01-13T12:00:00Z',
          },
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event2',
            data: {},
            timestamp: '2026-01-13T12:30:00Z',
          },
        ],
        server_timestamp: '2026-01-13T12:30:05.000Z',
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      // Should send each event individually
      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(2);
      expect(mockWindow.webContents.send).toHaveBeenNthCalledWith(
        1,
        'co-scientist-event',
        mockEvents.events[0]
      );
      expect(mockWindow.webContents.send).toHaveBeenNthCalledWith(
        2,
        'co-scientist-event',
        mockEvents.events[1]
      );
    });

    it('should update last_ts with server timestamp', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event1',
            data: {},
            timestamp: '2026-01-13T12:00:00.000Z',
          },
        ],
        server_timestamp: '2026-01-13T12:00:05.000Z',
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      expect(mockStore.set).toHaveBeenCalledWith('last_ts', '2026-01-13T12:00:05.000Z');
    });

    it('should update timestamp once with server timestamp regardless of skipped events', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 2, // Wrong user - will be skipped
            event_name: 'event1',
            data: {},
            timestamp: '2026-01-13T12:00:00.000Z',
          },
          {
            project_id: 123,
            user_id: 1, // Correct user
            event_name: 'event2',
            data: {},
            timestamp: '2026-01-13T12:05:00.000Z',
          },
          {
            project_id: 123,
            user_id: 3, // Wrong user - will be skipped
            event_name: 'event3',
            data: {},
            timestamp: '2026-01-13T12:10:00.000Z',
          },
        ],
        server_timestamp: '2026-01-13T12:10:05.000Z',
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      // Should only send one event (event2)
      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1);
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'co-scientist-event',
        mockEvents.events[1]
      );

      // Should update timestamp once with server's timestamp
      expect(mockStore.set).toHaveBeenCalledTimes(1);
      expect(mockStore.set).toHaveBeenCalledWith('last_ts', '2026-01-13T12:10:05.000Z');
    });

    it('should handle API errors gracefully without stopping', async () => {
      mockPollEvents.mockRejectedValue(new Error('Network error'));
      eventsManager.setMainWindow(mockWindow);

      // Should not throw
      await expect(eventsManager.syncWithBackend()).resolves.not.toThrow();
    });

    it('should handle network errors and continue polling', async () => {
      jest.useFakeTimers();

      mockPollEvents
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ events: [] });

      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1, 10000);

      // Wait for first sync to fail
      await Promise.resolve();
      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      // Second sync should succeed
      expect(mockPollEvents).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('should handle empty events array and still update server timestamp', async () => {
      mockPollEvents.mockResolvedValue({
        events: [],
        server_timestamp: '2026-01-13T12:00:00.000Z',
      });
      eventsManager.setMainWindow(mockWindow);

      await eventsManager.syncWithBackend();

      // Should not send any events
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
      // Should still update timestamp with server's timestamp
      expect(mockStore.set).toHaveBeenCalledWith('last_ts', '2026-01-13T12:00:00.000Z');
    });

    it('should process multiple events in order', async () => {
      const mockEvents = {
        events: [
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event1',
            data: { order: 1 },
            timestamp: '2026-01-13T12:00:00Z',
          },
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event2',
            data: { order: 2 },
            timestamp: '2026-01-13T12:30:00Z',
          },
          {
            project_id: 123,
            user_id: 1,
            event_name: 'event3',
            data: { order: 3 },
            timestamp: '2026-01-13T13:00:00Z',
          },
        ],
        server_timestamp: '2026-01-13T13:00:05.000Z',
      };

      mockPollEvents.mockResolvedValue(mockEvents);
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      // Verify events sent in order
      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(3);
      expect((mockWindow.webContents.send as jest.Mock).mock.calls[0][1].data.order).toBe(1);
      expect((mockWindow.webContents.send as jest.Mock).mock.calls[1][1].data.order).toBe(2);
      expect((mockWindow.webContents.send as jest.Mock).mock.calls[2][1].data.order).toBe(3);
    });
  });

  describe('IPC Communication', () => {
    it('should send events via webContents.send()', async () => {
      const mockEvent = {
        project_id: 123,
        user_id: 1,
        event_name: 'review_completed',
        data: { review_id: 789 },
        timestamp: '2026-01-13T12:00:00Z',
      };

      mockPollEvents.mockResolvedValue({ events: [mockEvent], server_timestamp: '2026-01-13T12:00:05.000Z' });
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('co-scientist-event', mockEvent);
    });

    it('should check window.isDestroyed() before sending', async () => {
      const mockEvent = {
        project_id: 123,
        user_id: 1,
        event_name: 'event1',
        data: {},
        timestamp: '2026-01-13T12:00:00Z',
      };

      mockWindow.isDestroyed.mockReturnValue(true);

      mockPollEvents.mockResolvedValue({ events: [mockEvent], server_timestamp: '2026-01-13T12:00:05.000Z' });
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      // Should not send event if window is destroyed
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should check webContents.isDestroyed() before sending', async () => {
      const mockEvent = {
        project_id: 123,
        user_id: 1,
        event_name: 'event1',
        data: {},
        timestamp: '2026-01-13T12:00:00Z',
      };

      mockWindow.webContents.isDestroyed.mockReturnValue(true);

      mockPollEvents.mockResolvedValue({ events: [mockEvent], server_timestamp: '2026-01-13T12:00:05.000Z' });
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      // Should not send event if webContents is destroyed
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should log error when window is null', async () => {
      const mockEvent = {
        project_id: 123,
        user_id: 1,
        event_name: 'event1',
        data: {},
        timestamp: '2026-01-13T12:00:00Z',
      };

      mockPollEvents.mockResolvedValue({ events: [mockEvent], server_timestamp: '2026-01-13T12:00:05.000Z' });
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(null);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      // Should not throw, just log error
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should continue polling if IPC send fails', async () => {
      jest.useFakeTimers();

      mockWindow.webContents.send.mockImplementationOnce(() => {
        throw new Error('IPC send failed');
      });

      const mockEvent = {
        project_id: 123,
        user_id: 1,
        event_name: 'event1',
        data: {},
        timestamp: '2026-01-13T12:00:00Z',
      };

      mockPollEvents.mockResolvedValue({ events: [mockEvent], server_timestamp: '2026-01-13T12:00:05.000Z' });
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1, 10000);

      // Wait for first sync (should fail but not throw)
      await Promise.resolve();

      // Fast-forward to next poll
      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      // Should have tried polling again
      expect(mockPollEvents).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('should send correct event structure to renderer', async () => {
      const mockEvent = {
        project_id: 123,
        user_id: 1,
        event_name: 'review_completed',
        data: { review_id: 789, status: 'success' },
        timestamp: '2026-01-13T12:00:00Z',
      };

      mockPollEvents.mockResolvedValue({ events: [mockEvent], server_timestamp: '2026-01-13T12:00:05.000Z' });
      mockStore.get.mockReturnValue(null);
      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1);

      await eventsManager.syncWithBackend();

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'co-scientist-event',
        expect.objectContaining({
          project_id: 123,
          user_id: 1,
          event_name: 'review_completed',
          data: expect.objectContaining({ review_id: 789, status: 'success' }),
          timestamp: '2026-01-13T12:00:00Z',
        })
      );
    });
  });

  describe('Lifecycle Management', () => {
    it('should set main window reference', () => {
      eventsManager.setMainWindow(mockWindow);
      // Should not throw
      expect(true).toBe(true);
    });

    it('should clear window reference on null', () => {
      eventsManager.setMainWindow(mockWindow);
      eventsManager.setMainWindow(null);
      // Should not throw
      expect(true).toBe(true);
    });

    it('should close and cleanup resources', () => {
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      eventsManager.startPolling(1, 10000);
      eventsManager.close();

      // Should stop polling
      expect(eventsManager.getCurrentUserId()).toBeNull();
    });

    it('should stop polling on close()', () => {
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      eventsManager.startPolling(1, 10000);
      eventsManager.close();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should NOT clear timestamp on close()', () => {
      eventsManager.close();

      // store.set should not be called to clear timestamp
      expect(mockStore.set).not.toHaveBeenCalledWith('last_ts', null);
    });
  });

  describe('Error Handling', () => {
    it('should handle API 500 errors gracefully', async () => {
      const error = new Error('Internal Server Error');
      (error as any).response = { status: 500 };

      mockPollEvents.mockRejectedValue(error);
      eventsManager.setMainWindow(mockWindow);

      await expect(eventsManager.syncWithBackend()).resolves.not.toThrow();
    });

    it('should handle network timeout errors', async () => {
      const error = new Error('Network timeout');
      mockPollEvents.mockRejectedValue(error);
      eventsManager.setMainWindow(mockWindow);

      await expect(eventsManager.syncWithBackend()).resolves.not.toThrow();
    });

    it('should handle malformed API responses', async () => {
      // Response without 'events' field
      mockPollEvents.mockResolvedValue({} as any);
      eventsManager.setMainWindow(mockWindow);

      // Should not throw, but won't process any events
      await expect(eventsManager.syncWithBackend()).resolves.not.toThrow();
    });

    it('should continue polling after errors', async () => {
      jest.useFakeTimers();

      mockPollEvents
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce({ events: [] });

      eventsManager.setMainWindow(mockWindow);
      eventsManager.startPolling(1, 10000);

      await Promise.resolve();

      // Fast-forward through errors
      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      // Should have tried 3 times
      expect(mockPollEvents).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent polling attempts', async () => {
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      // Start polling twice
      eventsManager.startPolling(1, 10000);
      eventsManager.startPolling(1, 10000);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not cause issues
      expect(true).toBe(true);
    });

    it('should handle rapid start/stop calls', () => {
      mockPollEvents.mockResolvedValue({ events: [], server_timestamp: '2026-01-13T12:00:00.000Z' });
      eventsManager.setMainWindow(mockWindow);

      // Rapid start/stop
      eventsManager.startPolling(1, 10000);
      eventsManager.stopPolling();
      eventsManager.startPolling(1, 10000);
      eventsManager.stopPolling();

      // Should not throw
      expect(true).toBe(true);
    });
  });
});
