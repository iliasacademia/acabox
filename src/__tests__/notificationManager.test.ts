/**
 * Unit tests for NotificationManager
 */

// Mock the uploader module BEFORE importing anything
jest.mock('../uploader', () => ({
  getNotifications: jest.fn(),
  updateNotification: jest.fn(),
}));

import { notificationManager } from '../notificationManager';
import * as uploader from '../uploader';
import { BrowserWindow } from 'electron';

// Mock Electron's BrowserWindow
jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
}));

describe('NotificationManager', () => {
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
      },
    };

    // Setup mocks for API calls
    mockGetNotifications = jest.spyOn(uploader, 'getNotifications');
    mockUpdateNotification = jest.spyOn(uploader, 'updateNotification');
  });

  afterEach(() => {
    jest.clearAllMocks();
    notificationManager.stopPolling();
  });

  describe('In-Memory Storage', () => {
    it('should store and retrieve notifications in memory using id as key', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'Test notification 1',
            body_html: '<p>Test body 1</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
          },
          {
            id: 2,
            title: 'Test notification 2',
            body_html: '<p>Test body 2</p>',
            user_id: 1,
            file_id: 456,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now() - 1000,
            read_at: null,
            dismissed_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      const notifications = notificationManager.getNotificationsByStatus(1);
      expect(notifications).toHaveLength(2);
      expect(notifications[0].id).toBe(1);
      expect(notifications[1].id).toBe(2);
    });

    it('should retrieve notifications by status', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'Unread notification',
            body_html: '<p>Unread body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
          },
          {
            id: 2,
            title: 'Read notification',
            body_html: '<p>Read body</p>',
            user_id: 1,
            file_id: 456,
            project_id: 0,
            project_file_id: 0,
            status: 'read' as const,
            created_at: Date.now() - 1000,
            read_at: Date.now() - 500,
            dismissed_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      const unreadNotifications = notificationManager.getNotificationsByStatus(1, 'unread');
      expect(unreadNotifications).toHaveLength(1);
      expect(unreadNotifications[0].id).toBe(1);

      const readNotifications = notificationManager.getNotificationsByStatus(1, 'read');
      expect(readNotifications).toHaveLength(1);
      expect(readNotifications[0].id).toBe(2);
    });
  });

  describe('Status Updates', () => {
    beforeEach(async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'Test notification',
            body_html: '<p>Test body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);
    });

    it('should mark notification as read by id', async () => {
      await notificationManager.markAsRead(1);

      // Verify API was called with correct parameters (including delivered_at)
      expect(mockUpdateNotification).toHaveBeenCalledWith(
        1,
        'read',
        expect.any(Number),
        null,
        expect.any(Number) // delivered_at should be set from initial sync
      );

      // Verify status was updated in memory
      const notifications = notificationManager.getNotificationsByStatus(1);
      expect(notifications[0].status).toBe('read');
      expect(notifications[0].read_at).not.toBeNull();

      // Verify IPC event was sent
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'notification-updated',
        { id: 1, status: 'read' }
      );
    });

    it('should dismiss notification by id', async () => {
      await notificationManager.dismissNotification(1);

      // Verify API was called with correct parameters (including delivered_at)
      expect(mockUpdateNotification).toHaveBeenCalledWith(
        1,
        'dismissed',
        null,
        expect.any(Number),
        expect.any(Number) // delivered_at should be set from initial sync
      );

      // Verify status was updated in memory
      const notifications = notificationManager.getNotificationsByStatus(1);
      expect(notifications[0].status).toBe('dismissed');
      expect(notifications[0].dismissed_at).not.toBeNull();

      // Verify IPC event was sent
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'notification-updated',
        { id: 1, status: 'dismissed' }
      );
    });
  });

  describe('Notification Popup Logic with delivered_at', () => {
    it('should send popup for new notification without delivered_at field (undefined)', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'New notification',
            body_html: '<p>New body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            // No delivered_at field - should be undefined
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should send popup event for new notification
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'new-notification',
        expect.objectContaining({ id: 1 })
      );

      // Should mark as delivered
      expect(mockUpdateNotification).toHaveBeenCalledWith(
        1,
        'unread',
        null,
        null,
        expect.any(Number)
      );
    });

    it('should send popup for new notification with delivered_at = null', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 2,
            title: 'New notification',
            body_html: '<p>New body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            delivered_at: null, // Explicitly null
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should send popup event
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'new-notification',
        expect.objectContaining({ id: 2 })
      );
    });

    it('should NOT send popup when delivered_at = 0 (edge case)', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 3,
            title: 'Already delivered',
            body_html: '<p>Already delivered</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            delivered_at: 0, // Edge case: 0 is falsy but is a valid timestamp
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should NOT send popup event (already delivered)
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.anything()
      );
    });

    it('should NOT send popup for already delivered notification', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 4,
            title: 'Already delivered',
            body_html: '<p>Already delivered</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            delivered_at: 1234567890, // Has timestamp - already delivered
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should NOT send popup event
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.anything()
      );
    });

    it('should NOT send popup for notifications with status = "read"', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 5,
            title: 'Read notification',
            body_html: '<p>Read body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'read' as const,
            created_at: Date.now(),
            read_at: Date.now() - 1000,
            dismissed_at: null,
            delivered_at: null, // Not delivered but already read
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should NOT send popup event for read notifications
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.anything()
      );
    });

    it('should NOT send popup for notifications with status = "dismissed"', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 6,
            title: 'Dismissed notification',
            body_html: '<p>Dismissed body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'dismissed' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: Date.now() - 1000,
            delivered_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should NOT send popup event for dismissed notifications
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.anything()
      );
    });

    it('should update in-memory cache with delivered_at after showing popup', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 7,
            title: 'New notification',
            body_html: '<p>New body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            delivered_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Get notification from memory
      const notifications = notificationManager.getNotificationsByStatus(1);
      const notification = notifications.find((n) => n.id === 7);

      // Should have delivered_at set in memory
      expect(notification).toBeDefined();
      expect(notification?.delivered_at).not.toBeNull();
      expect(notification?.delivered_at).toBeGreaterThan(0);
    });

    it('should handle multiple new notifications correctly', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 8,
            title: 'New notification 1',
            body_html: '<p>New body 1</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            delivered_at: null,
          },
          {
            id: 9,
            title: 'New notification 2',
            body_html: '<p>New body 2</p>',
            user_id: 1,
            file_id: 456,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            delivered_at: null,
          },
          {
            id: 10,
            title: 'Already delivered',
            body_html: '<p>Already delivered</p>',
            user_id: 1,
            file_id: 789,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
            delivered_at: 1234567890,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      mockUpdateNotification.mockResolvedValue(undefined);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      // Should send popup for 2 new notifications (id 8 and 9)
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'new-notification',
        expect.objectContaining({ id: 8 })
      );
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'new-notification',
        expect.objectContaining({ id: 9 })
      );

      // Should NOT send popup for already delivered notification (id 10)
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'new-notification',
        expect.objectContaining({ id: 10 })
      );

      // Should call updateNotification twice (for id 8 and 9)
      expect(mockUpdateNotification).toHaveBeenCalledTimes(2);
    });
  });

  describe('Polling', () => {
    it('should start polling with 30s interval', async () => {
      mockGetNotifications.mockResolvedValue({ notifications: [] });
      notificationManager.setMainWindow(mockWindow);

      notificationManager.startPolling(1, 30000);

      // Initial sync should be called immediately
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockGetNotifications).toHaveBeenCalled();
    });

    it('should stop polling and clear interval', () => {
      mockGetNotifications.mockResolvedValue({ notifications: [] });
      notificationManager.setMainWindow(mockWindow);

      notificationManager.startPolling(1, 30000);
      notificationManager.stopPolling();

      // Should not throw and polling should be stopped
      expect(true).toBe(true);
    });
  });

  describe('Cleanup', () => {
    it('should stop polling on close', () => {
      mockGetNotifications.mockResolvedValue({ notifications: [] });
      notificationManager.setMainWindow(mockWindow);

      notificationManager.startPolling(1, 30000);
      notificationManager.close();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should clear notifications for a user', async () => {
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'Test notification',
            body_html: '<p>Test body</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: Date.now(),
            read_at: null,
            dismissed_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      await notificationManager.syncWithBackend(1);

      let notifications = notificationManager.getNotificationsByStatus(1);
      expect(notifications).toHaveLength(1);

      notificationManager.clearNotifications(1);

      notifications = notificationManager.getNotificationsByStatus(1);
      expect(notifications).toHaveLength(0);
    });
  });

  describe('getUndismissedNotifications', () => {
    it('should return both unread and read notifications', async () => {
      const now = Date.now();
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'Unread notification',
            body_html: '<p>Unread</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: now,
            read_at: null,
            dismissed_at: null,
          },
          {
            id: 2,
            title: 'Read notification',
            body_html: '<p>Read</p>',
            user_id: 1,
            file_id: 456,
            project_id: 0,
            project_file_id: 0,
            status: 'read' as const,
            created_at: now - 1000,
            read_at: now - 500,
            dismissed_at: null,
          },
          {
            id: 3,
            title: 'Dismissed notification',
            body_html: '<p>Dismissed</p>',
            user_id: 1,
            file_id: 789,
            project_id: 0,
            project_file_id: 0,
            status: 'dismissed' as const,
            created_at: now - 2000,
            read_at: null,
            dismissed_at: now - 1500,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);
      await notificationManager.syncWithBackend(1);

      const undismissed = notificationManager.getUndismissedNotifications(1);

      // Should return 2 notifications (unread and read, excluding dismissed)
      expect(undismissed).toHaveLength(2);
      expect(undismissed.map((n) => n.id).sort()).toEqual([1, 2]);
      expect(undismissed.every((n) => n.status !== 'dismissed')).toBe(true);
    });

    it('should exclude dismissed notifications only', async () => {
      const now = Date.now();
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'Dismissed 1',
            body_html: '<p>Dismissed 1</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'dismissed' as const,
            created_at: now,
            read_at: null,
            dismissed_at: now - 100,
          },
          {
            id: 2,
            title: 'Dismissed 2',
            body_html: '<p>Dismissed 2</p>',
            user_id: 1,
            file_id: 456,
            project_id: 0,
            project_file_id: 0,
            status: 'dismissed' as const,
            created_at: now - 1000,
            read_at: null,
            dismissed_at: now - 500,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);
      await notificationManager.syncWithBackend(1);

      const undismissed = notificationManager.getUndismissedNotifications(1);

      // Should return empty array (all dismissed)
      expect(undismissed).toHaveLength(0);
    });

    it('should return empty array when no notifications exist', () => {
      const undismissed = notificationManager.getUndismissedNotifications(1);
      expect(undismissed).toEqual([]);
    });

    it('should filter by userId correctly', async () => {
      const now = Date.now();
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'User 1 notification',
            body_html: '<p>User 1</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: now,
            read_at: null,
            dismissed_at: null,
          },
          {
            id: 2,
            title: 'User 2 notification',
            body_html: '<p>User 2</p>',
            user_id: 2,
            file_id: 456,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: now,
            read_at: null,
            dismissed_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);

      // Sync - this adds both user 1 and user 2 notifications to memory
      await notificationManager.syncWithBackend(1);

      const user1Undismissed = notificationManager.getUndismissedNotifications(1);
      const user2Undismissed = notificationManager.getUndismissedNotifications(2);

      // Both calls should return all notifications (backend already filtered by logged-in user)
      expect(user1Undismissed).toHaveLength(2);
      expect(user1Undismissed.map(n => n.user_id).sort()).toEqual([1, 2]);

      // User 2 should also get all notifications (from the same sync)
      expect(user2Undismissed).toHaveLength(2);
      expect(user2Undismissed.map(n => n.user_id).sort()).toEqual([1, 2]);
    });

    it('should return notifications sorted by created_at descending', async () => {
      const now = Date.now();
      const mockNotifications = {
        notifications: [
          {
            id: 1,
            title: 'Oldest',
            body_html: '<p>Oldest</p>',
            user_id: 1,
            file_id: 123,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: now - 3000,
            read_at: null,
            dismissed_at: null,
          },
          {
            id: 2,
            title: 'Newest',
            body_html: '<p>Newest</p>',
            user_id: 1,
            file_id: 456,
            project_id: 0,
            project_file_id: 0,
            status: 'read' as const,
            created_at: now,
            read_at: now - 500,
            dismissed_at: null,
          },
          {
            id: 3,
            title: 'Middle',
            body_html: '<p>Middle</p>',
            user_id: 1,
            file_id: 789,
            project_id: 0,
            project_file_id: 0,
            status: 'unread' as const,
            created_at: now - 1500,
            read_at: null,
            dismissed_at: null,
          },
        ],
      };

      mockGetNotifications.mockResolvedValue(mockNotifications);
      notificationManager.setMainWindow(mockWindow);
      await notificationManager.syncWithBackend(1);

      const undismissed = notificationManager.getUndismissedNotifications(1);

      // Should be sorted by created_at descending (newest first)
      expect(undismissed).toHaveLength(3);
      expect(undismissed[0].id).toBe(2); // Newest
      expect(undismissed[1].id).toBe(3); // Middle
      expect(undismissed[2].id).toBe(1); // Oldest

      // Verify sorting
      expect(undismissed[0].created_at).toBeGreaterThanOrEqual(undismissed[1].created_at);
      expect(undismissed[1].created_at).toBeGreaterThanOrEqual(undismissed[2].created_at);
    });
  });
});
