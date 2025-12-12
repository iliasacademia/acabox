import { LoggerlessTransport, type LogLayerTransportParams } from '@loglayer/transport';
import { BrowserWindow, app } from 'electron';
import { serializeError } from 'serialize-error';
import type {
  DevToolsLogCategory,
  DevToolsLogLevel,
  DevToolsLogPayload,
} from '../../shared/types';
import { LOGGING_CONFIG } from '../config/loggingConfig';

/**
 * Safely serialize an Error object for IPC.
 * The serialize-error package can return objects with non-serializable properties
 * in edge cases (native errors, Electron errors), so we validate the result.
 */
function safeSerializeError(error: Error): Record<string, any> {
  try {
    const serialized = serializeError(error);
    // Validate it's actually serializable by round-tripping through JSON
    return JSON.parse(JSON.stringify(serialized));
  } catch {
    // Fallback: extract only safe properties manually
    return {
      name: String(error.name || 'Error'),
      message: String(error.message || 'Unknown error'),
      stack: error.stack ? String(error.stack) : undefined,
    };
  }
}

/**
 * Sanitize data to make it safe for IPC serialization.
 * Handles Error objects, circular references, functions, and other non-serializable types.
 */
export function sanitizeForIpc(data: any): any {
  // Handle null/undefined
  if (data == null) {
    return data;
  }

  // Handle Error objects with extra safety
  if (data instanceof Error) {
    return safeSerializeError(data);
  }

  // Handle primitives
  const type = typeof data;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return data;
  }

  // Handle functions - convert to string representation
  if (type === 'function') {
    return `[Function: ${data.name || 'anonymous'}]`;
  }

  // Handle Date objects
  if (data instanceof Date) {
    return data.toISOString();
  }

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForIpc(item));
  }

  // Handle objects (with circular reference protection)
  if (type === 'object') {
    try {
      // Use JSON stringify/parse to detect circular references
      // This also removes functions and non-serializable properties
      return JSON.parse(JSON.stringify(data, (key, value) => {
        // Handle nested Error objects
        if (value instanceof Error) {
          return safeSerializeError(value);
        }
        // Handle functions
        if (typeof value === 'function') {
          return `[Function: ${value.name || 'anonymous'}]`;
        }
        // Handle undefined (JSON.stringify removes it, but we want to show it)
        if (value === undefined) {
          return '[undefined]';
        }
        return value;
      }));
    } catch (error) {
      // If serialization fails, return a safe representation
      return {
        __type: data.constructor?.name || 'Object',
        __error: 'Failed to serialize object',
        __toString: String(data),
      };
    }
  }

  // Fallback for unknown types
  return String(data);
}

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

      // Build the message content - sanitize each message item
      const messageContent = messages.length > 0 ? messages.map(sanitizeForIpc) : [];

      // Include metadata if present - sanitize data as well
      const sanitizedData = hasData && data ? sanitizeForIpc(data) : undefined;
      const logData: { message: any[] } = {
        message: sanitizedData ? [...messageContent, sanitizedData] : messageContent,
      };

      const payload: DevToolsLogPayload = {
        timestamp: new Date().toISOString(),
        category,
        level,
        data: logData,
      };

      this.mainWindow.webContents.send('devtools-log', payload);
    } catch (error) {
      // Log serialization errors to electron-log (file) for debugging
      // but don't throw - logging should never break the app
      console.error('[DevToolsTransport] Failed to send log to DevTools:', error);
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
      // Sanitize the data before sending through IPC
      const sanitizedData = sanitizeForIpc(data);

      const payload: DevToolsLogPayload = {
        timestamp: new Date().toISOString(),
        category: 'api',
        level,
        data: sanitizedData,
      };

      this.mainWindow.webContents.send('devtools-log', payload);
    } catch (error) {
      // Log serialization errors for debugging
      console.error('[DevToolsTransport] Failed to send API log to DevTools:', error);
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
