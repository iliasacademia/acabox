import Database from 'better-sqlite3';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import {
  getNotifications,
  updateNotification,
  DesktopNotification,
} from './uploader';

export interface CachedNotification {
  created_at: number;
  data: string;
  user_id: number;
  file_id: number;
  status: 'unread' | 'read' | 'dismissed';
  read_at: number | null;
  dismissed_at: number | null;
  fetched_at: number;
  synced_to_backend: number; // 0 = not synced, 1 = synced
}

class NotificationService {
  private db: Database.Database;
  private mainWindow: BrowserWindow | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private currentUserId: number | null = null;
  private isSyncing = false;

  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'notifications.db');
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        created_at INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('unread', 'read', 'dismissed')),
        read_at INTEGER,
        dismissed_at INTEGER,
        fetched_at INTEGER NOT NULL,
        synced_to_backend INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_user_id ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_status ON notifications(status);
      CREATE INDEX IF NOT EXISTS idx_synced ON notifications(synced_to_backend);
    `);
  }

  setMainWindow(window: BrowserWindow | null) {
    this.mainWindow = window;
  }

  /**
   * Adapter to convert old API format to new schema
   * TODO: Remove this once backend API is updated to new schema
   */
  private adaptOldApiFormat(oldNotif: any, userId: number): DesktopNotification {
    // Check if it's already in new format
    if (oldNotif.data && oldNotif.status) {
      return oldNotif as DesktopNotification;
    }

    // Convert old format (title, description, shown_at) to new format
    const data = oldNotif.title && oldNotif.description
      ? `${oldNotif.title}: ${oldNotif.description}`
      : oldNotif.title || oldNotif.description || 'Notification';

    const status: 'unread' | 'read' | 'dismissed' = oldNotif.shown_at ? 'read' : 'unread';

    return {
      data,
      user_id: userId,
      file_id: oldNotif.file_id || 0, // Default to 0 if not provided
      status,
      created_at: oldNotif.created_at,
      read_at: oldNotif.shown_at || null,
      dismissed_at: null,
    };
  }

  /**
   * Sync notifications from backend API and merge into local DB
   */
  async syncWithBackend(userId: number): Promise<void> {
    if (this.isSyncing) {
      console.log('Sync already in progress, skipping...');
      return;
    }

    this.isSyncing = true;
    try {
      console.log('Syncing notifications from backend...');
      const response = await getNotifications();
      const fetchedAt = Date.now();

      // Get existing notification timestamps from DB
      const existingStmt = this.db.prepare(
        'SELECT created_at FROM notifications WHERE user_id = ?'
      );
      const existing = existingStmt.all(userId) as { created_at: number }[];
      const existingTimestamps = new Set(existing.map((n) => n.created_at));

      // Upsert notifications from API
      const upsertStmt = this.db.prepare(`
        INSERT INTO notifications (
          created_at, data, user_id, file_id, status,
          read_at, dismissed_at, fetched_at, synced_to_backend
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(created_at) DO UPDATE SET
          status = excluded.status,
          read_at = excluded.read_at,
          dismissed_at = excluded.dismissed_at,
          fetched_at = excluded.fetched_at
      `);

      const newNotifications: DesktopNotification[] = [];

      for (const rawNotif of response.notifications) {
        // Adapt old API format to new schema
        const notif = this.adaptOldApiFormat(rawNotif, userId);

        upsertStmt.run(
          notif.created_at,
          notif.data,
          notif.user_id,
          notif.file_id,
          notif.status,
          notif.read_at,
          notif.dismissed_at,
          fetchedAt
        );

        // Track new notifications
        if (!existingTimestamps.has(notif.created_at) && notif.status === 'unread') {
          newNotifications.push(notif);
        }
      }

      // Sync local changes to backend
      await this.syncLocalChangesToBackend();

      // Notify renderer about new notifications
      if (newNotifications.length > 0 && this.mainWindow) {
        for (const notif of newNotifications) {
          this.mainWindow.webContents.send('new-notification', notif);
        }
      }

      console.log(`Synced ${response.notifications.length} notifications, ${newNotifications.length} new`);
    } catch (error) {
      console.error('Failed to sync notifications:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync local changes (that haven't been synced) to backend
   */
  private async syncLocalChangesToBackend(): Promise<void> {
    const unsyncedStmt = this.db.prepare(`
      SELECT * FROM notifications WHERE synced_to_backend = 0
    `);
    const unsynced = unsyncedStmt.all() as CachedNotification[];

    for (const notif of unsynced) {
      try {
        await updateNotification(
          notif.created_at,
          notif.status,
          notif.read_at,
          notif.dismissed_at
        );

        // Mark as synced
        const markSyncedStmt = this.db.prepare(
          'UPDATE notifications SET synced_to_backend = 1 WHERE created_at = ?'
        );
        markSyncedStmt.run(notif.created_at);
      } catch (error) {
        console.error(`Failed to sync notification ${notif.created_at} to backend:`, error);
      }
    }
  }

  /**
   * Get notifications filtered by status
   */
  getNotificationsByStatus(
    userId: number,
    status?: 'unread' | 'read' | 'dismissed'
  ): CachedNotification[] {
    let stmt: Database.Statement;

    if (status) {
      stmt = this.db.prepare(`
        SELECT * FROM notifications
        WHERE user_id = ? AND status = ?
        ORDER BY created_at DESC
      `);
      return stmt.all(userId, status) as CachedNotification[];
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
      `);
      return stmt.all(userId) as CachedNotification[];
    }
  }

  /**
   * Get unread notifications
   */
  getUnreadNotifications(userId: number): CachedNotification[] {
    return this.getNotificationsByStatus(userId, 'unread');
  }

  /**
   * Update notification status
   */
  private updateStatus(
    createdAt: number,
    status: 'unread' | 'read' | 'dismissed',
    timestamp: number | null
  ): void {
    const updates: Record<string, any> = {
      status,
      synced_to_backend: 0, // Mark as needing sync
    };

    if (status === 'read') {
      updates.read_at = timestamp;
    } else if (status === 'dismissed') {
      updates.dismissed_at = timestamp;
    }

    const updateStmt = this.db.prepare(`
      UPDATE notifications
      SET status = ?, read_at = ?, dismissed_at = ?, synced_to_backend = ?
      WHERE created_at = ?
    `);

    updateStmt.run(
      status,
      updates.read_at || null,
      updates.dismissed_at || null,
      0,
      createdAt
    );
  }

  /**
   * Mark notification as read
   */
  async markAsRead(createdAt: number): Promise<void> {
    const now = Date.now();
    this.updateStatus(createdAt, 'read', now);

    // Sync to backend immediately
    try {
      await updateNotification(createdAt, 'read', now, null);

      // Mark as synced
      const markSyncedStmt = this.db.prepare(
        'UPDATE notifications SET synced_to_backend = 1 WHERE created_at = ?'
      );
      markSyncedStmt.run(createdAt);
    } catch (error) {
      console.error('Failed to sync mark as read to backend:', error);
      // Will be retried in next syncLocalChangesToBackend call
    }

    // Notify renderer
    if (this.mainWindow) {
      this.mainWindow.webContents.send('notification-updated', { created_at: createdAt, status: 'read' });
    }
  }

  /**
   * Dismiss notification
   */
  async dismissNotification(createdAt: number): Promise<void> {
    const now = Date.now();
    this.updateStatus(createdAt, 'dismissed', now);

    // Sync to backend immediately
    try {
      await updateNotification(createdAt, 'dismissed', null, now);

      // Mark as synced
      const markSyncedStmt = this.db.prepare(
        'UPDATE notifications SET synced_to_backend = 1 WHERE created_at = ?'
      );
      markSyncedStmt.run(createdAt);
    } catch (error) {
      console.error('Failed to sync dismiss to backend:', error);
      // Will be retried in next syncLocalChangesToBackend call
    }

    // Notify renderer
    if (this.mainWindow) {
      this.mainWindow.webContents.send('notification-updated', { created_at: createdAt, status: 'dismissed' });
    }
  }

  /**
   * Start polling for notifications
   */
  startPolling(userId: number, interval: number = 30000): void {
    this.currentUserId = userId;

    // Clear existing interval if any
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // Initial sync
    this.syncWithBackend(userId);

    // Start periodic sync
    this.pollingInterval = setInterval(() => {
      if (this.currentUserId) {
        this.syncWithBackend(this.currentUserId);
      }
    }, interval);

    console.log(`Started notification polling for user ${userId} with ${interval}ms interval`);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.currentUserId = null;
    console.log('Stopped notification polling');
  }

  /**
   * Clear all notifications for a user (for logout/testing)
   */
  clearNotifications(userId: number): void {
    const stmt = this.db.prepare('DELETE FROM notifications WHERE user_id = ?');
    stmt.run(userId);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.stopPolling();
    this.db.close();
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
