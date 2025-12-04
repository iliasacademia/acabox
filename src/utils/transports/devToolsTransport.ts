import { LoggerlessTransport, type LogLayerTransportParams } from '@loglayer/transport';
import { BrowserWindow, app } from 'electron';
import type {
  DevToolsLogCategory,
  DevToolsLogLevel,
  DevToolsLogPayload,
} from '../../shared/types';
import { LOGGING_CONFIG } from '../config/loggingConfig';

/**
 * Custom LogLayer transport that sends logs to the renderer process DevTools console.
 *
 * This transport:
 * - Only activates in development (!app.isPackaged)
 * - Sends logs via IPC to the renderer's DevTools console
 * - Preserves the existing color-coded log formatting
 * - Requires a BrowserWindow reference to send messages
 *
 * @example
 * ```typescript
 * const transport = new DevToolsTransport({ id: 'devtools' });
 * transport.setMainWindow(mainWindow);
 * ```
 */
export class DevToolsTransport extends LoggerlessTransport {
  private mainWindow: BrowserWindow | null = null;
  private isDisposed = false;

  /**
   * Set the main window reference for IPC communication.
   * Must be called after the BrowserWindow is created.
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Maps LogLayer log levels to DevTools log levels
   */
  private mapLogLevel(level: string): DevToolsLogLevel {
    switch (level) {
      case 'trace':
      case 'debug':
        return 'debug';
      case 'info':
        return 'info';
      case 'warn':
        return 'warn';
      case 'error':
      case 'fatal':
        return 'error';
      default:
        return 'info';
    }
  }

  /**
   * Ship logs to the renderer DevTools console via IPC.
   * This is called by LogLayer for each log message.
   */
  shipToLogger(params: LogLayerTransportParams): string[] {
    const { logLevel, messages, data, hasData } = params;

    // Skip if disposed, in production, or DevTools logging disabled
    if (this.isDisposed || app.isPackaged || !LOGGING_CONFIG.devToolsLogging) {
      return messages;
    }

    // Skip if no window or window is destroyed
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return messages;
    }

    try {
      const level = this.mapLogLevel(logLevel);
      const category: DevToolsLogCategory = 'general';

      // Build the message content
      const messageContent = messages.length > 0 ? messages : [];

      // Include metadata if present
      const logData: { message: any[] } = {
        message: hasData && data ? [...messageContent, data] : messageContent,
      };

      const payload: DevToolsLogPayload = {
        timestamp: new Date().toISOString(),
        category,
        level,
        data: logData,
      };

      this.mainWindow.webContents.send('devtools-log', payload);
    } catch {
      // Silently fail - logging should never break the app
    }

    return messages;
  }

  /**
   * Send API-specific logs to DevTools with the 'api' category.
   * This preserves the existing API logging behavior.
   */
  sendApiLog(
    level: DevToolsLogLevel,
    data: DevToolsLogPayload['data']
  ): void {
    if (this.isDisposed || app.isPackaged || !LOGGING_CONFIG.devToolsLogging) {
      return;
    }

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      const payload: DevToolsLogPayload = {
        timestamp: new Date().toISOString(),
        category: 'api',
        level,
        data,
      };

      this.mainWindow.webContents.send('devtools-log', payload);
    } catch {
      // Silently fail
    }
  }

  /**
   * Cleanup when the transport is disposed.
   */
  [Symbol.dispose](): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.mainWindow = null;
  }
}
