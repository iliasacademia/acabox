import { BrowserWindow, app } from 'electron';
import {
  DevToolsLogCategory,
  DevToolsLogLevel,
  DevToolsLogPayload,
} from '../shared/types';
import { logLayer, devToolsTransport, getLogFilePath } from './logLayer';
import { LOGGING_CONFIG, DATADOG_DEBUG_LOGS_ENABLED } from './config/loggingConfig';
import { sanitizeForIpc } from './transports/devToolsTransport';

// Re-export for backward compatibility
export { getChannelFromVersion } from './config/loggingConfig';

// Re-export DEV_LOGGING_CONFIG for backward compatibility
export const DEV_LOGGING_CONFIG = {
  devToolsLogging: LOGGING_CONFIG.devToolsLogging,
  terminalLogging: LOGGING_CONFIG.terminalLogging,
};

/**
 * Logger class that wraps LogLayer for backward compatibility.
 *
 * This class maintains the existing API while delegating to LogLayer internally.
 * All existing code using `logger.info()`, `logger.error()`, etc. continues to work.
 *
 * For new code, you can use LogLayer directly for enhanced features:
 * - `logLayer.withMetadata({ userId: 123 }).info('message')`
 * - `logLayer.withError(error).error('message')`
 *
 * @example
 * ```typescript
 * // Existing API (still works)
 * import { defaultLogger as logger } from './utils/logger';
 * logger.info('Hello world');
 *
 * // New LogLayer API (recommended for new code)
 * import { logLayer } from './utils/logLayer';
 * logLayer.withMetadata({ action: 'login' }).info('User logged in');
 * ```
 */
export class Logger {
  private isPackaged: boolean;
  private mainWindow: BrowserWindow | null = null;

  constructor(isPackaged: boolean, _version: string, _channel: 'stable' | 'beta') {
    this.isPackaged = isPackaged;
    // Note: version and channel are now handled in loggingConfig.ts
    // These params are kept for backward compatibility
  }

  /**
   * Convert object arguments to JSON strings for logLayer.
   * Keeps string and primitive arguments as-is.
   * Error objects are preserved for proper stack trace handling.
   */
  private stringifyObjects(args: any[]): any[] {
    return args.map(arg => {
      if (arg !== null && typeof arg === 'object' && !(arg instanceof Error)) {
        return JSON.stringify(arg);
      }
      return arg;
    });
  }

  /**
   * Get the log file path
   */
  getLogFilePath(): string {
    return getLogFilePath();
  }

  /**
   * Set the main window reference for sending logs to renderer.
   * This updates the DevTools transport with the window reference.
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
    devToolsTransport.setMainWindow(window);
  }

  /**
   * Send log to renderer DevTools (development only).
   * This method is preserved for API-specific logging in apiClient.ts.
   */
  sendToDevTools(
    category: DevToolsLogCategory,
    level: DevToolsLogLevel,
    data: DevToolsLogPayload['data']
  ): void {
    if (this.isPackaged) {
      return;
    }

    if (!LOGGING_CONFIG.devToolsLogging) {
      return;
    }

    if (category === 'api') {
      // Use the DevTools transport's API-specific method
      devToolsTransport.sendApiLog(level, data);
    } else {
      // For general logs, let LogLayer handle it
      // This path is less common as general logs go through info/warn/error/debug
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try {
          const payload: DevToolsLogPayload = {
            timestamp: new Date().toISOString(),
            category,
            level,
            data: sanitizeForIpc(data),
          };
          this.mainWindow.webContents.send('devtools-log', payload);
        } catch {
          // Silently fail
        }
      }
    }
  }

  /**
   * Log an info message
   */
  info(...args: any[]): void {
    logLayer.info(...this.stringifyObjects(args));
    if (!this.isPackaged && LOGGING_CONFIG.terminalLogging) {
      console.log(...args);
    }
  }

  /**
   * Log an error message
   */
  error(...args: any[]): void {
    logLayer.error(...this.stringifyObjects(args));
    if (!this.isPackaged && LOGGING_CONFIG.terminalLogging) {
      console.error(...args);
    }
  }

  /**
   * Log a warning message
   */
  warn(...args: any[]): void {
    logLayer.warn(...this.stringifyObjects(args));
    if (!this.isPackaged && LOGGING_CONFIG.terminalLogging) {
      console.warn(...args);
    }
  }

  /**
   * Log a debug message
   * Sent to LogLayer (including Datadog) if DATADOG_DEBUG_LOGS_ENABLED or in development
   */
  debug(...args: any[]): void {
    // Send to LogLayer (including Datadog) if flag enabled OR in development
    if (!this.isPackaged || DATADOG_DEBUG_LOGS_ENABLED) {
      logLayer.debug(...this.stringifyObjects(args));
    }
    // Console output only in development
    if (!this.isPackaged && LOGGING_CONFIG.terminalLogging) {
      console.debug(...args);
    }
  }

  /**
   * Check if terminal logging is enabled (for external API logging)
   */
  isTerminalLoggingEnabled(): boolean {
    return !this.isPackaged && LOGGING_CONFIG.terminalLogging;
  }

  // ============================================
  // New LogLayer-powered methods
  // ============================================

  /**
   * Create a child logger with attached metadata.
   * This is a new feature powered by LogLayer.
   *
   * @example
   * ```typescript
   * const childLogger = logger.withMetadata({ requestId: '123' });
   * childLogger.info('Processing request'); // metadata is attached
   * ```
   */
  withMetadata(metadata: Record<string, any>) {
    return logLayer.withMetadata(metadata);
  }

  /**
   * Create a child logger with an attached error.
   * This is a new feature powered by LogLayer.
   *
   * @example
   * ```typescript
   * logger.withError(error).error('Operation failed');
   * ```
   */
  withError(error: Error) {
    return logLayer.withError(error);
  }

}

// Default logger instance for use throughout the application
export const defaultLogger = new Logger(
  app.isPackaged,
  app.getVersion(),
  (app.getVersion().includes('-beta') ? 'beta' : 'stable') as 'stable' | 'beta'
);

// Export LogLayer instance for direct access to advanced features
export { logLayer } from './logLayer';
