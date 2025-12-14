/**
 * Integration tests for notification synchronization between:
 * - Desktop notification trigger ('new-notification' IPC)
 * - Notification count availability (getUndismissedNotifications with project_file_id filter)
 *
 * These tests verify that when syncWithBackend() triggers a desktop notification,
 * the same notification is immediately available for the badge count.
 */

// Mock the apiClient module that notificationManager depends on BEFORE importing anything
jest.mock('../apiClient', () => ({
  APIclient: jest.fn(),
  getCsrfToken: jest.fn(),
}));

import { notificationManager, CachedNotification } from '../notificationManager';
import * as notificationManagerModule from '../notificationManager';
import { Notification } from '../types/notifications';

// Mock Electron's BrowserWindow and app
jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  app: {
    getVersion: jest.fn(() => '1.0.0-test'),
    isPackaged: false,
    getPath: jest.fn(() => '/mock/path'),
  },
}));

/**
 * Helper function to create mock notification with required fields
 */
const createMockNotification = (
  id: number,
  projectFileId: number,
  options: Partial<Notification> = {}
): Notification => ({
  id,
  title: `Notification ${id}`,
  body_html: `<p>Body ${id}</p>`,
  user_id: 1,
  file_id: 100,
  project_id: 10,
  project_file_id: projectFileId,
  status: 'unread',
  created_at: Date.now(),
  read_at: null,
  dismissed_at: null,
  delivered_at: null,
  ...options,
});

/**
 * Helper function to filter notifications by project_file_id
 * (simulates the count endpoint filtering logic)
 */
const filterByProjectFileId = (
  notifications: CachedNotification[],
  projectFileId: number
): CachedNotification[] => {
  return notifications.filter((n) => n.project_file_id === projectFileId);
};

describe('Notification Synchronization', () => {
  let mockWindow: any;
  let mockGetNotifications: jest.SpyInstance;
  let mockUpdateNotification: jest.SpyInstance;

  beforeEach(() => {
    // Clear any previous state
    notificationManager.stopPolling();
    notificationManager.clearNotifications(1);

    // Setup mock window
    mockWindow = {
      webContents: {
        send: jest.fn(),
        isDestroyed: jest.fn().mockReturnValue(false),
      },
      isDestroyed: jest.fn().mockReturnValue(false),
    };

    // Setup mocks for API calls
    mockGetNotifications = jest.spyOn(notificationManagerModule, 'getNotifications');
    mockUpdateNotification = jest.spyOn(notificationManagerModule, 'updateNotification');
  });

  afterEach(() => {
    jest.clearAllMocks();
    notificationManager.stopPolling();
  });

  describe('Core Synchronization Tests', () => {
    it('should make notification available in getUndismissedNotifications immediately after IPC send', async () => {
      const projectFileId = 12345;
      const mockNotifications = {
        notifications: [
          createMockNotification(1, projectFileId, {
            status: 'unread',
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      // Track when IPC was sent and what was available at that moment
      let countAtIpcTime: CachedNotification[] | null = null;
      mockWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'new-notification') {
          // Query count at the exact moment IPC is sent
          countAtIpcTime = notificationManager.getUndismissedNotifications(1);
        }
      });

      await notificationManager.syncWithBackend(1);

      // Verify IPC was sent
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'new-notification',
        expect.objectContaining({ id: 1, project_file_id: projectFileId })
      );

      // Verify notification was available at IPC time
      expect(countAtIpcTime).not.toBeNull();
      expect(countAtIpcTime!.length).toBe(1);
      expect(countAtIpcTime![0].project_file_id).toBe(projectFileId);
    });

    it('should store notification in cache before IPC is sent', async () => {
      const projectFileId = 67890;
      const mockNotifications = {
        notifications: [
          createMockNotification(2, projectFileId, {
            status: 'unread',
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      // Capture the order of operations
      const operationOrder: string[] = [];
      let notificationInCacheBeforeIpc = false;

      mockWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'new-notification') {
          operationOrder.push('ipc-sent');
          // Check if notification is already in cache
          const cached = notificationManager.getUndismissedNotifications(1);
          notificationInCacheBeforeIpc = cached.some((n) => n.id === 2);
        }
      });

      await notificationManager.syncWithBackend(1);

      // Verify notification was in cache when IPC was sent
      expect(notificationInCacheBeforeIpc).toBe(true);
    });

    it('should have correct project_file_id in notification for filtering', async () => {
      const projectFileId = 54321;
      const mockNotifications = {
        notifications: [
          createMockNotification(3, projectFileId, {
            status: 'unread',
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Get all undismissed notifications
      const allNotifications = notificationManager.getUndismissedNotifications(1);

      // Filter by matching project_file_id
      const matchingFiltered = filterByProjectFileId(allNotifications, projectFileId);
      expect(matchingFiltered.length).toBe(1);
      expect(matchingFiltered[0].id).toBe(3);

      // Filter by non-matching project_file_id
      const nonMatchingFiltered = filterByProjectFileId(allNotifications, 99999);
      expect(nonMatchingFiltered.length).toBe(0);
    });
  });

  describe('project_file_id Filtering Tests', () => {
    it('should return only notifications matching the specified project_file_id', async () => {
      const mockNotifications = {
        notifications: [
          createMockNotification(1, 100, { status: 'unread', delivered_at: 1234567890 }),
          createMockNotification(2, 200, { status: 'unread', delivered_at: 1234567890 }),
          createMockNotification(3, 300, { status: 'unread', delivered_at: 1234567890 }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      const allNotifications = notificationManager.getUndismissedNotifications(1);
      expect(allNotifications.length).toBe(3);

      // Filter for project_file_id = 200
      const filtered = filterByProjectFileId(allNotifications, 200);
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe(2);
      expect(filtered[0].project_file_id).toBe(200);
    });

    it('should handle project_file_id = 0 edge case', async () => {
      const mockNotifications = {
        notifications: [
          createMockNotification(1, 0, { status: 'unread', delivered_at: 1234567890 }),
          createMockNotification(2, 100, { status: 'unread', delivered_at: 1234567890 }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      const allNotifications = notificationManager.getUndismissedNotifications(1);

      // Filter for project_file_id = 0
      const filtered = filterByProjectFileId(allNotifications, 0);
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe(1);
    });

    it('should return all undismissed notifications when no filter is applied', async () => {
      const mockNotifications = {
        notifications: [
          createMockNotification(1, 100, { status: 'unread', delivered_at: 1234567890 }),
          createMockNotification(2, 200, { status: 'read', read_at: Date.now(), delivered_at: 1234567890 }),
          createMockNotification(3, 300, { status: 'dismissed', dismissed_at: Date.now(), delivered_at: 1234567890 }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // getUndismissedNotifications returns all non-dismissed (unread + read)
      const undismissed = notificationManager.getUndismissedNotifications(1);
      expect(undismissed.length).toBe(2);
      expect(undismissed.map((n) => n.id).sort()).toEqual([1, 2]);
    });
  });

  describe('Race Condition Tests', () => {
    it('should prevent concurrent sync calls with isSyncing flag', async () => {
      const mockNotifications = {
        notifications: [createMockNotification(1, 100)],
      };

      // Make getNotifications slow to simulate network delay
      let getNotificationsCallCount = 0;
      mockGetNotifications.mockImplementation(() => {
        getNotificationsCallCount++;
        return new Promise((resolve) => {
          setTimeout(() => resolve(mockNotifications), 100);
        });
      });
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      // Start two syncs concurrently
      const sync1 = notificationManager.syncWithBackend(1);
      const sync2 = notificationManager.syncWithBackend(1);

      await Promise.all([sync1, sync2]);

      // Only one sync should have actually called getNotifications
      expect(getNotificationsCallCount).toBe(1);
    });

    it('should have notification available in cache before updateNotification API completes', async () => {
      const projectFileId = 11111;
      const mockNotifications = {
        notifications: [
          createMockNotification(1, projectFileId, {
            status: 'unread',
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);

      // Make updateNotification slow to simulate network delay
      let notificationAvailableBeforeUpdate = false;
      mockUpdateNotification.mockImplementation(() => {
        // Check if notification is available while updateNotification is being called
        const cached = notificationManager.getUndismissedNotifications(1);
        notificationAvailableBeforeUpdate = cached.some((n) => n.id === 1);
        return new Promise((resolve) => setTimeout(resolve, 100));
      });

      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Notification should have been available before updateNotification completed
      expect(notificationAvailableBeforeUpdate).toBe(true);
    });

    it('should NOT mark notification as delivered if IPC send fails', async () => {
      const mockNotifications = {
        notifications: [
          createMockNotification(1, 100, {
            status: 'unread',
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);

      // Make IPC send throw an error
      mockWindow.webContents.send.mockImplementation(() => {
        throw new Error('IPC send failed');
      });

      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // updateNotification should NOT have been called (no delivered_at update)
      expect(mockUpdateNotification).not.toHaveBeenCalled();
    });
  });

  describe('Status Transition Tests', () => {
    it('should show popup AND appear in count for unread + delivered_at: null', async () => {
      const projectFileId = 22222;
      const mockNotifications = {
        notifications: [
          createMockNotification(1, projectFileId, {
            status: 'unread',
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should show popup (IPC sent)
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'new-notification',
        expect.objectContaining({ id: 1 })
      );

      // Should appear in count
      const undismissed = notificationManager.getUndismissedNotifications(1);
      const filtered = filterByProjectFileId(undismissed, projectFileId);
      expect(filtered.length).toBe(1);
    });

    it('should NOT show popup but appear in count for unread + delivered_at: timestamp', async () => {
      const projectFileId = 33333;
      const mockNotifications = {
        notifications: [
          createMockNotification(1, projectFileId, {
            status: 'unread',
            delivered_at: 1234567890, // Already delivered
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should NOT show popup
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.anything()
      );

      // Should still appear in count
      const undismissed = notificationManager.getUndismissedNotifications(1);
      const filtered = filterByProjectFileId(undismissed, projectFileId);
      expect(filtered.length).toBe(1);
    });

    it('should NOT show popup but appear in count for read + delivered_at: null', async () => {
      const projectFileId = 44444;
      const mockNotifications = {
        notifications: [
          createMockNotification(1, projectFileId, {
            status: 'read',
            read_at: Date.now() - 1000,
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should NOT show popup (status is not 'unread')
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.anything()
      );

      // Should appear in count (read but not dismissed)
      const undismissed = notificationManager.getUndismissedNotifications(1);
      const filtered = filterByProjectFileId(undismissed, projectFileId);
      expect(filtered.length).toBe(1);
    });

    it('should NOT show popup and NOT appear in count for dismissed notifications', async () => {
      const projectFileId = 55555;
      const mockNotifications = {
        notifications: [
          createMockNotification(1, projectFileId, {
            status: 'dismissed',
            dismissed_at: Date.now() - 1000,
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should NOT show popup
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.anything()
      );

      // Should NOT appear in undismissed count
      const undismissed = notificationManager.getUndismissedNotifications(1);
      const filtered = filterByProjectFileId(undismissed, projectFileId);
      expect(filtered.length).toBe(0);
    });

    it('should handle notification appearing in both IPC and count with same project_file_id', async () => {
      const projectFileId = 66666;
      const mockNotifications = {
        notifications: [
          createMockNotification(1, projectFileId, {
            status: 'unread',
            delivered_at: null,
          }),
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      // Capture what was sent via IPC
      let ipcPayload: any = null;
      mockWindow.webContents.send.mockImplementation((channel: string, payload: any) => {
        if (channel === 'new-notification') {
          ipcPayload = payload;
        }
      });

      await notificationManager.syncWithBackend(1);

      // Get from count
      const undismissed = notificationManager.getUndismissedNotifications(1);
      const filtered = filterByProjectFileId(undismissed, projectFileId);

      // Verify same notification appears in both
      expect(ipcPayload).not.toBeNull();
      expect(ipcPayload.id).toBe(1);
      expect(ipcPayload.project_file_id).toBe(projectFileId);

      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe(1);
      expect(filtered[0].project_file_id).toBe(projectFileId);
    });
  });
});
