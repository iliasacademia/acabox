import { jest } from '@jest/globals';
import axios from 'axios';

// Mock the axios module
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock electron app
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock/path'),
    getVersion: jest.fn(() => '1.0.0-test'),
    isPackaged: false,
  },
}));

// Mock axios-cookiejar-support (ESM module)
jest.mock('axios-cookiejar-support', () => ({
  wrapper: jest.fn((axios) => axios),
}));

// Mock http-cookie-agent (ESM module)
jest.mock('http-cookie-agent/http', () => ({
  HttpCookieAgent: jest.fn(),
  HttpsCookieAgent: jest.fn(),
}));

// Mock tough-cookie
jest.mock('tough-cookie', () => ({
  CookieJar: jest.fn(() => ({})),
  Store: class Store {
    synchronous = true;
  },
  Cookie: {
    fromJSON: jest.fn((data) => data),
  },
}));

// Mock tough-cookie-file-store
jest.mock('tough-cookie-file-store', () => jest.fn());

// Mock pdf-lib
jest.mock('pdf-lib', () => ({
  PDFDocument: {
    load: jest.fn(),
  },
}));

// Create a mock axios instance
const mockClient: any = {
  get: jest.fn(),
  patch: jest.fn(),
  post: jest.fn(),
};

// Mock apiClient module
jest.mock('../apiClient', () => ({
  APIclient: jest.fn(async () => mockClient),
  getCsrfToken: jest.fn(async () => 'mock-csrf-token'),
}));

// Import after mocking
import { getNotifications, updateNotification } from '../notificationManager';
import { Notification } from '../types/notifications';

// Mock axios.create to return our mock client (called once when module loads)
mockedAxios.create = jest.fn(() => mockClient);

describe('Notification API Client', () => {
  beforeEach(() => {
    // Clear previous call history
    jest.clearAllMocks();
  });

  describe('getNotifications', () => {
    it('should fetch notifications from the API and return the correct type', async () => {
      const mockNotifications: Notification[] = [
        {
          id: 1,
          title: 'Test Notification',
          body_html: '<p>This is a test notification</p>',
          user_id: 123,
          file_id: 456,
          project_id: 789,
          project_file_id: 101,
          status: 'unread',
          read_at: null,
          dismissed_at: null,
          created_at: Date.now(),
        },
        {
          id: 2,
          title: 'Another Notification',
          body_html: '<p>This is another test</p>',
          user_id: 123,
          file_id: 457,
          project_id: 789,
          project_file_id: 102,
          status: 'read',
          read_at: Date.now() - 1000,
          dismissed_at: null,
          created_at: Date.now() - 2000,
        },
      ];

      const mockResponse = {
        data: {
          notifications: mockNotifications,
        },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await getNotifications();

      expect(mockClient.get).toHaveBeenCalledWith('/v0/desktop_notifications/get_notifications', { params: {} });
      expect(result).toEqual({ notifications: mockNotifications });
      expect(result.notifications).toHaveLength(2);
      expect(result.notifications[0].id).toBe(1);
      expect(result.notifications[0].title).toBe('Test Notification');
      expect(result.notifications[0].body_html).toContain('test notification');
    });

    it('should handle empty notifications array', async () => {
      const mockResponse = {
        data: {
          notifications: [],
        },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await getNotifications();

      expect(result.notifications).toEqual([]);
      expect(result.notifications).toHaveLength(0);
    });

    it('should throw error when API call fails', async () => {
      const mockError = new Error('Network error');
      mockClient.get.mockRejectedValue(mockError);

      await expect(getNotifications()).rejects.toThrow('Network error');
    });
  });

  describe('updateNotification', () => {
    it('should update notification status to read using id', async () => {
      const notificationId = 1;
      const readAt = Date.now();

      mockClient.patch.mockResolvedValue({ status: 200 });

      await updateNotification(notificationId, 'read', readAt, null);

      // Check that the update was called (getCsrfToken is mocked in apiClient)
      expect(mockClient.patch).toHaveBeenCalledWith(
        '/v0/desktop_notifications/update_notification',
        {
          id: notificationId,
          status: 'read',
          read_at: readAt,
          dismissed_at: null,
        },
        {
          headers: { 'x-csrf-token': 'mock-csrf-token' },
        }
      );
    });

    it('should update notification status to dismissed using id', async () => {
      const notificationId = 2;
      const dismissedAt = Date.now();

      mockClient.post.mockResolvedValue({ data: 'mock-csrf-token' });
      mockClient.patch.mockResolvedValue({ status: 200 });

      await updateNotification(notificationId, 'dismissed', null, dismissedAt);

      expect(mockClient.patch).toHaveBeenCalledWith(
        '/v0/desktop_notifications/update_notification',
        {
          id: notificationId,
          status: 'dismissed',
          read_at: null,
          dismissed_at: dismissedAt,
        },
        {
          headers: { 'x-csrf-token': 'mock-csrf-token' },
        }
      );
    });

    it('should update notification status to unread using id', async () => {
      const notificationId = 3;

      mockClient.post.mockResolvedValue({ data: 'mock-csrf-token' });
      mockClient.patch.mockResolvedValue({ status: 200 });

      await updateNotification(notificationId, 'unread', null, null);

      expect(mockClient.patch).toHaveBeenCalledWith(
        '/v0/desktop_notifications/update_notification',
        {
          id: notificationId,
          status: 'unread',
          read_at: null,
          dismissed_at: null,
        },
        {
          headers: { 'x-csrf-token': 'mock-csrf-token' },
        }
      );
    });

    it('should use id parameter not created_at', async () => {
      const notificationId = 42;

      mockClient.post.mockResolvedValue({ data: 'mock-csrf-token' });
      mockClient.patch.mockResolvedValue({ status: 200 });

      await updateNotification(notificationId, 'read', Date.now(), null);

      // Verify that the payload uses 'id' and not 'created_at'
      const patchCall = mockClient.patch.mock.calls[0];
      const payload = patchCall[1];

      expect(payload).toHaveProperty('id');
      expect(payload).not.toHaveProperty('created_at');
      expect(payload.id).toBe(notificationId);
    });

    it('should throw error when API call fails', async () => {
      const mockError = new Error('Update failed');

      mockClient.post.mockResolvedValue({ data: 'mock-csrf-token' });
      mockClient.patch.mockRejectedValue(mockError);

      await expect(updateNotification(1, 'read', Date.now(), null)).rejects.toThrow('Update failed');
    });
  });

  describe('Type Safety', () => {
    it('should ensure Notification type has all required fields', () => {
      const notification: Notification = {
        id: 1,
        title: 'Test',
        body_html: '<p>Test</p>',
        user_id: 123,
        file_id: 456,
        project_id: 789,
        project_file_id: 101,
        status: 'unread',
        read_at: null,
        dismissed_at: null,
        created_at: Date.now(),
      };

      // This test passes if TypeScript compilation succeeds
      expect(notification.id).toBeDefined();
      expect(notification.title).toBeDefined();
      expect(notification.body_html).toBeDefined();
      expect(notification.project_id).toBeDefined();
      expect(notification.project_file_id).toBeDefined();
    });

    it('should ensure status field only accepts valid values', () => {
      const validStatuses: Array<'unread' | 'read' | 'dismissed'> = ['unread', 'read', 'dismissed'];

      validStatuses.forEach((status) => {
        expect(['unread', 'read', 'dismissed']).toContain(status);
      });
    });
  });
});
