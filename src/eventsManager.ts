import { BrowserWindow, app } from 'electron';
import { APIclient } from './apiClient';
import { CoScientistEvent, PollEventsResponse } from './types/events';
import { defaultLogger as logger } from './utils/logger';
import Store from 'electron-store';

interface EventsState {
  last_ts: string | null;
}

/**
 * Poll events from the Co-Scientist API
 * @param lastTimestamp - ISO 8601 timestamp for incremental polling
 * @returns Response with events since last timestamp
 */
export const pollEvents = async (lastTimestamp?: string): Promise<PollEventsResponse> => {
  const client = await APIclient();
  const params = lastTimestamp ? { last_ts: lastTimestamp } : {};

  const response = await client.get('/v0/co_scientist/events/poll', { params });
  return response.data;
};

class EventsManager {
  private pollingInterval: NodeJS.Timeout | null = null;
  private currentUserId: number | null = null;
  private isSyncing = false;
  private mainWindow: BrowserWindow | null = null;
  private store = new Store<EventsState>({
    name: app.isPackaged ? 'events-state' : 'events-state-dev',
  });

  /**
   * Set the main window reference for IPC communication
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Get the stored timestamp from disk
   */
  private getStoredTimestamp(): string | null {
    return this.store.get('last_ts', null);
  }

  /**
   * Update the stored timestamp on disk
   * Uses the server's timestamp directly to avoid clock skew issues
   */
  private updateStoredTimestamp(timestamp: string): void {
    this.store.set('last_ts', timestamp);
    logger.debug('[EventsManager] Updated last_ts:', timestamp);
  }

  /**
   * Send event to renderer via IPC
   */
  private sendEventToRenderer(event: CoScientistEvent): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      logger.error('[EventsManager] Cannot send event: mainWindow is null or destroyed', {
        eventName: event.event_name,
        projectId: event.project_id,
      });
      return;
    }

    if (!this.mainWindow.webContents || this.mainWindow.webContents.isDestroyed()) {
      logger.error('[EventsManager] Cannot send event: webContents is null or destroyed');
      return;
    }

    try {
      this.mainWindow.webContents.send('co-scientist-event', event);
      logger.debug('[EventsManager] Event sent to renderer', {
        eventName: event.event_name,
        projectId: event.project_id,
        timestamp: event.timestamp,
      });
    } catch (error) {
      logger.error('[EventsManager] Failed to send IPC event:', error);
    }
  }

  /**
   * Sync events from backend API
   *
   * Uses server_timestamp from the poll response to avoid clock skew issues.
   * The server timestamp is stored and used for the next poll, ensuring events
   * created between polls are never missed due to client/server clock differences.
   */
  async syncWithBackend(): Promise<void> {
    if (this.isSyncing) {
      logger.debug('[EventsManager] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    const lastTimestamp = this.getStoredTimestamp();

    logger.info('[EventsManager] Starting events poll', {
      userId: this.currentUserId,
      last_ts: lastTimestamp,
    });

    try {
      // Poll API with last timestamp
      const response = await pollEvents(lastTimestamp || undefined);

      logger.info('[EventsManager] Fetched events', {
        count: response.events.length,
        last_ts: lastTimestamp || 'none (full sync)',
        server_timestamp: response.server_timestamp,
      });

      // Process events in order (oldest to newest)
      for (const event of response.events) {
        // Validate event belongs to current user
        if (event.user_id !== this.currentUserId) {
          logger.warn('[EventsManager] Event user_id mismatch, skipping', {
            eventUserId: event.user_id,
            currentUserId: this.currentUserId,
            eventName: event.event_name,
          });
          continue;
        }

        // Send to renderer
        this.sendEventToRenderer(event);
      }

      // Update last_ts with server's timestamp (not event timestamps)
      // This uses the server's clock throughout to avoid clock skew
      this.updateStoredTimestamp(response.server_timestamp);

      logger.info('[EventsManager] Sync complete', {
        eventsProcessed: response.events.length,
        next_last_ts: response.server_timestamp,
      });
    } catch (error: any) {
      logger.error('[EventsManager] Failed to sync events:', error);
      // Don't throw - allow next poll attempt
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Start polling for events
   * @param userId - User ID to poll for
   * @param interval - Polling interval in milliseconds (default: 1000ms = 1s)
   */
  startPolling(userId: number, interval: number = 1000): void {
    this.currentUserId = userId;

    // Clear existing interval if any
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    logger.info('[EventsManager] Starting events polling', {
      userId: this.currentUserId,
      interval: interval,
      last_ts: this.getStoredTimestamp(),
    });

    // Initial sync
    this.syncWithBackend();

    // Start periodic sync
    this.pollingInterval = setInterval(() => {
      if (this.currentUserId) {
        this.syncWithBackend();
      }
    }, interval);
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
    logger.info('[EventsManager] Stopped events polling');
  }

  /**
   * Get current user ID (for debugging)
   */
  getCurrentUserId(): number | null {
    return this.currentUserId;
  }

  /**
   * Close/cleanup
   */
  close(): void {
    this.stopPolling();
    // Note: We keep the stored timestamp on disk for next session
  }
}

// Export singleton instance
export const eventsManager = new EventsManager();
