/**
 * Integration tests for AcademiaHttpServer
 *
 * Tests the HTTP server endpoints, authentication, and data flow
 */

import { AcademiaHttpServer } from './httpServer';

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
  let validToken: string;

  beforeAll(async () => {
    // Create mock notification manager
    mockNotificationManager = new MockNotificationManager();

    // Create server instance
    server = new AcademiaHttpServer(
      mockNotificationManager,
      () => mockNotificationManager.getCurrentUserId()
    );

    // Start server
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;

    // Generate a valid token
    validToken = server.generateToken('test-client');

    console.log(`[Test] Server started at ${baseUrl}`);
    console.log(`[Test] Valid token: ${validToken.substring(0, 16)}...`);
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

    it('should generate unique tokens', () => {
      const token1 = server.generateToken('client-1');
      const token2 = server.generateToken('client-2');

      expect(token1).not.toBe(token2);
      expect(token1.length).toBe(64); // 32 bytes * 2 (hex encoding)
      expect(token2.length).toBe(64);
    });
  });

  describe('GET /api/health', () => {
    it('should return health status without authentication', async () => {
      const response = await fetch(`${baseUrl}/api/health`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.timestamp).toBeGreaterThan(0);
    });
  });

  describe('Authentication', () => {
    it('should reject requests without Authorization header', async () => {
      const response = await fetch(`${baseUrl}/api/notifications`);

      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
      expect(data.message).toContain('Missing Authorization header');
    });

    it('should reject requests with malformed Authorization header', async () => {
      const response = await fetch(`${baseUrl}/api/notifications`, {
        headers: {
          Authorization: 'InvalidFormat',
        },
      });

      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
      expect(data.message).toContain('Malformed Authorization header');
    });

    it('should reject requests with invalid token', async () => {
      const response = await fetch(`${baseUrl}/api/notifications`, {
        headers: {
          Authorization: 'Bearer invalid-token-12345',
        },
      });

      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
      expect(data.message).toContain('Invalid or expired token');
    });

    it('should accept requests with valid token', async () => {
      const response = await fetch(`${baseUrl}/api/notifications`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/notifications', () => {
    it('should return all undismissed notifications', async () => {
      const response = await fetch(`${baseUrl}/api/notifications`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.notifications).toBeInstanceOf(Array);
      expect(data.count).toBe(2); // Both test notifications are undismissed
      expect(data.notifications.length).toBe(2);
    });

    it('should filter notifications by status=unread', async () => {
      const response = await fetch(`${baseUrl}/api/notifications?status=unread`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.notifications).toBeInstanceOf(Array);
      expect(data.count).toBe(1); // Only 1 unread notification
      expect(data.notifications[0].status).toBe('unread');
    });

    it('should filter notifications by status=read', async () => {
      const response = await fetch(`${baseUrl}/api/notifications?status=read`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.notifications).toBeInstanceOf(Array);
      expect(data.count).toBe(1); // Only 1 read notification
      expect(data.notifications[0].status).toBe('read');
    });

    it('should respect limit parameter', async () => {
      const response = await fetch(`${baseUrl}/api/notifications?limit=1`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.notifications.length).toBe(1);
      expect(data.count).toBe(1);
    });
  });

  describe('GET /api/notifications/count', () => {
    it('should return notification counts without authentication', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/count`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.total).toBe(2); // Both test notifications are undismissed
      expect(data.unread).toBe(1); // 1 unread notification
      expect(data.read).toBe(1); // 1 read notification
    });

    it('should also work with authentication token (backward compatible)', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/count`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.total).toBe(2);
      expect(data.unread).toBe(1);
      expect(data.read).toBe(1);
    });
  });

  describe('PATCH /api/notifications/:id', () => {
    it('should mark notification as read', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
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
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
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
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'invalid' }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('BadRequest');
    });

    it('should reject invalid notification ID', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/abc`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'read' }),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('BadRequest');
      expect(data.message).toContain('Invalid notification ID');
    });

    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'read' }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Token Management', () => {
    it('should revoke tokens', () => {
      const token = server.generateToken('revoke-test');

      // Token should be valid initially
      expect(server.getTokenManager().isValidToken(token)).toBe(true);

      // Revoke token
      const revoked = server.revokeToken(token);
      expect(revoked).toBe(true);

      // Token should no longer be valid
      expect(server.getTokenManager().isValidToken(token)).toBe(false);
    });

    it('should return false when revoking non-existent token', () => {
      const revoked = server.revokeToken('non-existent-token');
      expect(revoked).toBe(false);
    });

    it('should track active token count', () => {
      const initialCount = server.getActiveTokenCount();

      const token1 = server.generateToken();
      expect(server.getActiveTokenCount()).toBe(initialCount + 1);

      const token2 = server.generateToken();
      expect(server.getActiveTokenCount()).toBe(initialCount + 2);

      server.revokeToken(token1);
      expect(server.getActiveTokenCount()).toBe(initialCount + 1);

      server.revokeToken(token2);
      expect(server.getActiveTokenCount()).toBe(initialCount);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON in request body', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: '{invalid json}',
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should handle missing request body', async () => {
      const response = await fetch(`${baseUrl}/api/notifications/1`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
      });

      expect(response.status).toBe(400);
    });
  });
});
