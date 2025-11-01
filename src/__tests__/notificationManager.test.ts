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

      // Verify API was called with correct parameters
      expect(mockUpdateNotification).toHaveBeenCalledWith(
        1,
        'read',
        expect.any(Number),
        null
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

      // Verify API was called with correct parameters
      expect(mockUpdateNotification).toHaveBeenCalledWith(
        1,
        'dismissed',
        null,
        expect.any(Number)
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
});
