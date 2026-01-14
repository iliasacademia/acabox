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
   * Adds 1 millisecond to ensure the next poll doesn't return the same event
   */
  private updateStoredTimestamp(timestamp: string): void {
    // Parse timestamp and add 1ms to avoid re-fetching the same event
    // This handles the case where backend uses >= instead of > for timestamp comparison
    const date = new Date(timestamp);
    date.setMilliseconds(date.getMilliseconds() + 1);
    const incrementedTimestamp = date.toISOString();

    this.store.set('last_ts', incrementedTimestamp);
    logger.debug('[EventsManager] Updated last_ts:', {
      original: timestamp,
      incremented: incrementedTimestamp,
    });
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
   * IMPORTANT: This method updates the `last_ts` timestamp after processing EACH event,
   * including events that are skipped due to user_id mismatch. This ensures that the
   * same events are not returned on subsequent polls.
   *
   * Example: If events arrive for users [456, 789, 456] and current user is 456:
   * - Event 1 (user 456): processed, timestamp updated
   * - Event 2 (user 789): skipped, but timestamp still updated to mark as "seen"
   * - Event 3 (user 456): processed, timestamp updated
   *
   * Next poll will use the timestamp of Event 3, ensuring none of these events are re-fetched.
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
          // Still update timestamp to mark this event as "seen"
          // so we don't keep polling it on every request
          this.updateStoredTimestamp(event.timestamp);
          continue;
        }

        // Send to renderer
        this.sendEventToRenderer(event);

        // Update last_ts after successfully processing event
        // This ensures next poll won't return events we've already seen
        this.updateStoredTimestamp(event.timestamp);
      }

      logger.info('[EventsManager] Sync complete', {
        eventsProcessed: response.events.length,
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
   * @param interval - Polling interval in milliseconds (default: 10000ms = 10s)
   */
  startPolling(userId: number, interval: number = 10000): void {
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
