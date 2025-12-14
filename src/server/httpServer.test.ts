/**
 * Integration tests for AcademiaHttpServer
 *
 * Tests the HTTP server endpoints, authentication, and data flow
 *
 * @jest-environment node
 */

// Mock Electron's app module for testing
jest.mock('electron', () => ({
  app: {
    getVersion: jest.fn(() => '1.0.0-test'),
    isPackaged: false,
    getPath: jest.fn(() => '/mock/path'),
  },
}));

// Mock proxy routes to avoid axios-cookiejar-support ES module issues
jest.mock('./routes/proxy', () => ({
  registerProxyRoutes: jest.fn(),
}));

import { AcademiaHttpServer } from './httpServer';
import { wordIntegrationDataStore } from '../wordIntegrationDataStore';

// Mock NotificationManager for testing
class MockNotificationManager {
  private notifications = new Map<number, any>();
  private currentUser = 123;

  constructor() {
    // Add some test notifications
    this.notifications.set(1, {
      id: 1,
      title: 'Test Notification 1',
      body_html: 'Test body 1',
      user_id: 123,
      file_id: 1,
      project_id: 1,
      project_file_id: 1,
      status: 'unread',
      read_at: null,
      dismissed_at: null,
      created_at: Date.now(),
      fetched_at: Date.now(),
      synced_to_backend: true,
    });

    this.notifications.set(2, {
      id: 2,
      title: 'Test Notification 2',
      body_html: 'Test body 2',
      user_id: 123,
      file_id: 2,
      project_id: 1,
      project_file_id: 2,
      status: 'read',
      read_at: Date.now() - 86400000,
      dismissed_at: null,
      created_at: Date.now() - 86400000,
      fetched_at: Date.now(),
      synced_to_backend: true,
    });
  }

  getCurrentUserId() {
    return this.currentUser;
  }

  getNotificationsByStatus(userId: number, status?: string) {
    const results = Array.from(this.notifications.values()).filter(
      (n) => n.user_id === userId && (!status || n.status === status)
    );
    return results;
  }

  getUndismissedNotifications(userId: number) {
    return Array.from(this.notifications.values()).filter(
      (n) => n.user_id === userId && n.status !== 'dismissed'
    );
  }

  async markAsRead(id: number) {
    const notif = this.notifications.get(id);
    if (notif) {
      notif.status = 'read';
      notif.read_at = Date.now();
    }
  }

  async dismissNotification(id: number) {
    const notif = this.notifications.get(id);
    if (notif) {
      notif.status = 'dismissed';
      notif.dismissed_at = Date.now();
    }
  }
}

describe('AcademiaHttpServer', () => {
  let server: AcademiaHttpServer;
  let mockNotificationManager: MockNotificationManager;
  let baseUrl: string;
  let authToken: string;

  // Helper to create headers with auth token
  const authHeaders = (additionalHeaders: Record<string, string> = {}) => ({
    Authorization: `Bearer ${authToken}`,
    ...additionalHeaders,
  });

  beforeAll(async () => {
    // Create mock notification manager
    mockNotificationManager = new MockNotificationManager();

    // Create server instance with port 23110 (dedicated test port)
    server = new AcademiaHttpServer(
      mockNotificationManager,
      () => mockNotificationManager.getCurrentUserId(),
      { port: 23110 } // Use dedicated test port
    );

    // Start server
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    authToken = server.getAuthToken()!;

    console.log(`[Test] Server started at ${baseUrl}`);
  });

  afterAll(async () => {
    // Stop server
    await server.stop();
  });

  describe('Server Initialization', () => {
    it('should start on a random port', () => {
      expect(server.getPort()).toBeGreaterThan(0);
      expect(server.isRunning()).toBe(true);
    });

    it('should have a valid base URL', () => {
      expect(server.getBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.timestamp).toBeGreaterThan(0);
    });

    it('should reject requests without auth token', async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/notifications', () => {
    it('should return all undismissed notifications', async () => {
      const response = await fetch(`${baseUrl}/api/notifications`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(Array.isArray(data.notifications)).toBe(true);
      expect(data.count).toBe(2); // Both test notifications are undismissed
      expect(data.notifications.length).toBe(2);
    });

    it('should filter notifications by status=unread', async () => {
      const response = await fetch(`${baseUrl}/api/notifications?status=unread`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(Array.isArray(data.notifications)).toBe(true);
      expect(data.count).toBe(1); // Only 1 unread notification
      expect(data.notifications[0].status).toBe('unread');
    });

    it('should filter notifications by status=read', async () => {
      const response = await fetch(`${baseUrl}/api/notifications?status=read`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(Array.isArray(data.notifications)).toBe(true);
      expect(data.count).toBe(1); // Only 1 read notification
      expect(data.notifications[0].status).toBe('read');
    });

    it('should respect limit parameter', async () => {
      const response = await fetch(`${baseUrl}/api/notifications?limit=1`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.notifications.length).toBe(1);
      expect(data.count).toBe(1);
    });
  });

  describe('GET /api/notifications/count', () => {
    it('should return notification counts', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/count`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.total).toBe(2); // Both test notifications are undismissed
      expect(data.unread).toBe(1); // 1 unread notification
      expect(data.read).toBe(1); // 1 read notification
    });

    it('should filter by project_file_id and return matching notifications', async () => {
      // Request count for project_file_id=1 (only notification 1 has this)
      const response = await fetch(`${baseUrl}/api/notifications/count?project_file_id=1`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      // Should only return notification with project_file_id=1
      expect(data.notifications).toBeDefined();
      expect(data.notifications.length).toBe(1);
      expect(data.notifications[0].project_file_id).toBe(1);
      expect(data.total).toBe(1);
    });

    it('should filter by project_file_id and return empty for non-matching', async () => {
      // Request count for project_file_id=999 (no notifications have this)
      const response = await fetch(`${baseUrl}/api/notifications/count?project_file_id=999`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      // Should return no notifications
      expect(data.notifications).toBeDefined();
      expect(data.notifications.length).toBe(0);
      expect(data.total).toBe(0);
      expect(data.unread).toBe(0);
      expect(data.read).toBe(0);
    });

    it('should return notifications array for badge button to count client-side', async () => {
      // The AcademiaNotificationsButton counts notifications client-side
      // Verify the response structure matches what the button expects
      const response = await fetch(`${baseUrl}/api/notifications/count?project_file_id=1`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      // Button uses: const notifications = data.notifications || [];
      // Then: const count = notifications.length;
      expect(data.notifications).toBeDefined();
      expect(Array.isArray(data.notifications)).toBe(true);

      // Each notification should have all required fields
      if (data.notifications.length > 0) {
        const notif = data.notifications[0];
        expect(notif.id).toBeDefined();
        expect(notif.project_file_id).toBeDefined();
        expect(notif.status).toBeDefined();
      }
    });
  });

  describe('PATCH /api/notifications/:id', () => {
    it('should mark notification as read', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'read' }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.notification).toBeTruthy();
      expect(data.notification.status).toBe('read');
      expect(data.notification.read_at).toBeTruthy();
    });

    it('should dismiss notification', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/2`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'dismissed' }),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.notification).toBeTruthy();
      expect(data.notification.status).toBe('dismissed');
      expect(data.notification.dismissed_at).toBeTruthy();
    });

    it('should reject invalid status values', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'invalid' }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('BadRequest');
    });

    it('should reject invalid notification ID', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/abc`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'read' }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('BadRequest');
      expect(data.message).toContain('Invalid notification ID');
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON in request body', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: '{invalid json}',
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should handle missing request body', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /word/:pid/project_file', () => {
    beforeEach(() => {
      // Clear any existing tracked PIDs
      wordIntegrationDataStore.clearTrackedPIDs();
    });

    it('should return project_file_id for tracked PID', async () => {
      // Setup: Track a PID with a file path
      const testPID = 12345;
      const testFilePath = '/path/to/test.docx';
      const testProjectFileId = 42;
      const testProjectId = 10;

      // Register the PID
      wordIntegrationDataStore.setTrackedPID(testPID, {
        pid: testPID,
        filePath: testFilePath,
        isActive: true,
      });

      // Set up the project file cache
      const cache = new Map<string, { project_id: number; project_file_id: number }>();
      cache.set(testFilePath, {
        project_id: testProjectId,
        project_file_id: testProjectFileId,
      });
      wordIntegrationDataStore.setProjectFileCache(cache);

      // Make request
      const response = await fetch(`${baseUrl}/word/${testPID}/project_file`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.project_id).toBe(testProjectId);
      expect(data.project_file_id).toBe(testProjectFileId);
    });

    it('should return 404 for untracked PID', async () => {
      const response = await fetch(`${baseUrl}/word/99999/project_file`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error).toBe('NotFound');
    });

    it('should return 404 when PID tracked but no project file cache', async () => {
      // Track a PID but don't set up the cache
      const testPID = 11111;
      wordIntegrationDataStore.setTrackedPID(testPID, {
        pid: testPID,
        filePath: '/path/to/uncached.docx',
        isActive: true,
      });

      const response = await fetch(`${baseUrl}/word/${testPID}/project_file`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid PID format', async () => {
      const response = await fetch(`${baseUrl}/word/not-a-number/project_file`, {
        headers: authHeaders(),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('BadRequest');
    });
  });

  describe('End-to-end: Notification and Word integration', () => {
    beforeEach(() => {
      wordIntegrationDataStore.clearTrackedPIDs();
    });

    it('should return notification when project_file_id matches between Word and notifications', async () => {
      // This test verifies the full flow:
      // 1. Word process is tracked with a specific project_file_id
      // 2. Notification exists with the same project_file_id
      // 3. Count endpoint returns the notification when filtered

      const testPID = 55555;
      const testFilePath = '/path/to/document.docx';
      const matchingProjectFileId = 1; // notification 1 has project_file_id=1

      // Setup Word tracking
      wordIntegrationDataStore.setTrackedPID(testPID, {
        pid: testPID,
        filePath: testFilePath,
        isActive: true,
      });

      const cache = new Map<string, { project_id: number; project_file_id: number }>();
      cache.set(testFilePath, {
        project_id: 1,
        project_file_id: matchingProjectFileId,
      });
      wordIntegrationDataStore.setProjectFileCache(cache);

      // Step 1: Get project_file_id from Word endpoint (what the button does)
      const wordResponse = await fetch(`${baseUrl}/word/${testPID}/project_file`, {
        headers: authHeaders(),
      });
      expect(wordResponse.status).toBe(200);
      const wordData = await wordResponse.json();
      const projectFileId = wordData.project_file_id;

      // Step 2: Use that project_file_id to get notification count (what the button does)
      const countResponse = await fetch(
        `${baseUrl}/api/notifications/count?project_file_id=${projectFileId}`,
        { headers: authHeaders() }
      );
      expect(countResponse.status).toBe(200);
      const countData = await countResponse.json();

      // Step 3: Verify we got the matching notification
      expect(countData.notifications.length).toBeGreaterThan(0);
      expect(countData.notifications[0].project_file_id).toBe(matchingProjectFileId);
    });

    it('should return empty when project_file_id does not match any notifications', async () => {
      // Setup Word tracking with a project_file_id that doesn't match any notifications
      const testPID = 66666;
      const testFilePath = '/path/to/other.docx';
      const nonMatchingProjectFileId = 9999; // no notification has this

      wordIntegrationDataStore.setTrackedPID(testPID, {
        pid: testPID,
        filePath: testFilePath,
        isActive: true,
      });

      const cache = new Map<string, { project_id: number; project_file_id: number }>();
      cache.set(testFilePath, {
        project_id: 99,
        project_file_id: nonMatchingProjectFileId,
      });
      wordIntegrationDataStore.setProjectFileCache(cache);

      // Get project_file_id from Word endpoint
      const wordResponse = await fetch(`${baseUrl}/word/${testPID}/project_file`, {
        headers: authHeaders(),
      });
      const wordData = await wordResponse.json();

      // Get notification count with that project_file_id
      const countResponse = await fetch(
        `${baseUrl}/api/notifications/count?project_file_id=${wordData.project_file_id}`,
        { headers: authHeaders() }
      );
      const countData = await countResponse.json();

      // Should return empty - no notifications match
      expect(countData.notifications.length).toBe(0);
      expect(countData.total).toBe(0);
    });
  });
});
