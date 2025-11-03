import { BrowserWindow } from 'electron';
import { getNotifications, updateNotification } from './uploader';
import { Notification } from './types/notifications';

export interface CachedNotification extends Notification {
  fetched_at: number;
  synced_to_backend: boolean;
}

class NotificationManager {
  private notifications: Map<number, CachedNotification> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private currentUserId: number | null = null;
  private isSyncing = false;

  setMainWindow(window: BrowserWindow | null) {
    this.mainWindow = window;
  }

  /**
   * Sync notifications from backend API and merge into memory
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

      console.log(`[NotificationManager] Received ${response.notifications.length} notifications from backend`);

      // Log the raw response to see field names
      if (response.notifications.length > 0) {
        console.log('[NotificationManager] Raw first notification from backend:', JSON.stringify(response.notifications[0], null, 2));
        console.log('[NotificationManager] Field names:', Object.keys(response.notifications[0]));
      }

      // Get existing notification IDs
      const existingIds = new Set<number>();
      for (const [id, notif] of this.notifications) {
        if (notif.user_id === userId) {
          existingIds.add(id);
        }
      }

      const newNotifications: Notification[] = [];

      // Upsert notifications from API
      for (const notif of response.notifications) {
        // Log each notification details
        console.log(`[NotificationManager] Notification ${notif.id}:`, {
          title: notif.title,
          status: notif.status,
          delivered_at: notif.delivered_at,
          delivered_at_type: typeof notif.delivered_at,
          is_null_or_undefined: notif.delivered_at == null,
          raw_keys: Object.keys(notif),
        });

        const cached: CachedNotification = {
          ...notif,
          fetched_at: fetchedAt,
          synced_to_backend: true,
        };

        // Check if this is a new notification (not yet delivered)
        // Use == null to check for both null and undefined explicitly
        const shouldShowPopup = notif.status === 'unread' && notif.delivered_at == null;
        console.log(`[NotificationManager] Notification ${notif.id} should show popup: ${shouldShowPopup} (status=${notif.status}, delivered_at=${notif.delivered_at})`);

        if (shouldShowPopup) {
          newNotifications.push(notif);
        }

        // Store in memory
        this.notifications.set(notif.id, cached);
      }

      // Sync local changes to backend
      await this.syncLocalChangesToBackend();

      console.log(`[NotificationManager] ${newNotifications.length} notifications will trigger popups`);
      console.log(`[NotificationManager] MainWindow available: ${!!this.mainWindow}`);

      // Notify renderer about new notifications and mark as delivered
      if (newNotifications.length > 0 && this.mainWindow) {
        console.log(`[NotificationManager] Sending popups for ${newNotifications.length} notifications`);
        for (const notif of newNotifications) {
          console.log(`[NotificationManager] Sending popup for notification ${notif.id}: "${notif.title}"`);
          // Send popup event
          this.mainWindow.webContents.send('new-notification', notif);

          // Mark as delivered immediately
          try {
            const deliveredAt = Date.now();
            await updateNotification(
              notif.id,
              notif.status,
              notif.read_at,
              notif.dismissed_at,
              deliveredAt
            );

            console.log(`[NotificationManager] Marked notification ${notif.id} as delivered at ${deliveredAt}`);

            // Update in memory
            const cached = this.notifications.get(notif.id);
            if (cached) {
              cached.delivered_at = deliveredAt;
              this.notifications.set(notif.id, cached);
            }
          } catch (error) {
            console.error(`Failed to mark notification ${notif.id} as delivered:`, error);
          }
        }
      } else if (newNotifications.length > 0 && !this.mainWindow) {
        console.warn(`[NotificationManager] Have ${newNotifications.length} new notifications but mainWindow is not set!`);
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
    const unsynced: CachedNotification[] = [];

    for (const notif of this.notifications.values()) {
      if (!notif.synced_to_backend) {
        unsynced.push(notif);
      }
    }

    for (const notif of unsynced) {
      try {
        await updateNotification(
          notif.id,
          notif.status,
          notif.read_at,
          notif.dismissed_at,
          notif.delivered_at
        );

        // Mark as synced
        notif.synced_to_backend = true;
        this.notifications.set(notif.id, notif);
      } catch (error) {
        console.error(`Failed to sync notification ${notif.id} to backend:`, error);
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
    const results: CachedNotification[] = [];

    for (const notif of this.notifications.values()) {
      if (notif.user_id === userId) {
        if (!status || notif.status === status) {
          results.push(notif);
        }
      }
    }

    // Sort by created_at descending
    return results.sort((a, b) => b.created_at - a.created_at);
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
    id: number,
    status: 'unread' | 'read' | 'dismissed',
    timestamp: number | null
  ): void {
    const notif = this.notifications.get(id);
    if (!notif) {
      console.error(`Notification ${id} not found`);
      return;
    }

    notif.status = status;
    notif.synced_to_backend = false;

    if (status === 'read') {
      notif.read_at = timestamp;
    } else if (status === 'dismissed') {
      notif.dismissed_at = timestamp;
    }

    this.notifications.set(id, notif);
  }

  /**
   * Mark notification as read
   */
  async markAsRead(id: number): Promise<void> {
    const now = Date.now();
    this.updateStatus(id, 'read', now);

    // Sync to backend immediately
    try {
      const notif = this.notifications.get(id);
      await updateNotification(id, 'read', now, null, notif?.delivered_at);

      // Mark as synced
      if (notif) {
        notif.synced_to_backend = true;
        this.notifications.set(id, notif);
      }
    } catch (error) {
      console.error('Failed to sync mark as read to backend:', error);
      // Will be retried in next syncLocalChangesToBackend call
    }

    // Notify renderer
    if (this.mainWindow) {
      this.mainWindow.webContents.send('notification-updated', { id, status: 'read' });
    }
  }

  /**
   * Dismiss notification
   */
  async dismissNotification(id: number): Promise<void> {
    const now = Date.now();
    this.updateStatus(id, 'dismissed', now);

    // Sync to backend immediately
    try {
      const notif = this.notifications.get(id);
      await updateNotification(id, 'dismissed', null, now, notif?.delivered_at);

      // Mark as synced
      if (notif) {
        notif.synced_to_backend = true;
        this.notifications.set(id, notif);
      }
    } catch (error) {
      console.error('Failed to sync dismiss to backend:', error);
      // Will be retried in next syncLocalChangesToBackend call
    }

    // Notify renderer
    if (this.mainWindow) {
      this.mainWindow.webContents.send('notification-updated', { id, status: 'dismissed' });
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
    const toDelete: number[] = [];

    for (const [id, notif] of this.notifications) {
      if (notif.user_id === userId) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.notifications.delete(id);
    }
  }

  /**
   * Close/cleanup
   */
  close(): void {
    this.stopPolling();
    // No database to close, just clear memory
    this.notifications.clear();
  }
}

// Export singleton instance
export const notificationManager = new NotificationManager();
