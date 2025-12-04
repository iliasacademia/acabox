import log from 'electron-log';
import { BrowserWindow, app } from 'electron';
import {
  DevToolsLogCategory,
  DevToolsLogLevel,
  DevToolsLogPayload,
} from '../shared/types';

// Development logging configuration
export const DEV_LOGGING_CONFIG = {
  devToolsLogging: true,   // Send logs to renderer DevTools console
  terminalLogging: false,   // Output logs to terminal
};

// Helper function to detect channel from version string
export function getChannelFromVersion(): 'stable' | 'beta' {
  const version = app.getVersion();
  return version.includes('-beta') ? 'beta' : 'stable';
}

/**
 * Logger class that switches between console.log (development) and electron-log (production)
 *
 * In development: Uses console.log for familiar debugging
 * In production: Uses electron-log with channel-specific filenames and version numbers in log lines
 */
export class Logger {
  private isPackaged: boolean;
  private version: string;
  private channel: 'stable' | 'beta';
  private mainWindow: BrowserWindow | null = null;

  constructor(isPackaged: boolean, version: string, channel: 'stable' | 'beta') {
    this.isPackaged = isPackaged;
    this.version = version;
    this.channel = channel;

    if (this.isPackaged) {
      // Production configuration
      this.configureProductionLogging();
    }
  }

  private configureProductionLogging(): void {
    // Configure file transport
    log.transports.file.level = 'info';
    log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB max file size

    // Set filename to include channel: main-stable.log or main-beta.log
    log.transports.file.fileName = `main-${this.channel}.log`;

    // Set format to include version number after timestamp, before level
    // Format: [2025-01-06 14:30:22] [v20250106143022] [info] message
    log.transports.file.format = `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v${this.version}] [{level}] {text}`;

    // Configure console transport for production (optional - you may want to disable this)
    log.transports.console.level = 'info';
    log.transports.console.format = `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v${this.version}] [{level}] {text}`;
  }

  /**
   * Get the log file path (only available in production)
   */
  getLogFilePath(): string | null {
    if (this.isPackaged) {
      return log.transports.file.getFile().path;
    }
    return null;
  }

  /**
   * Set the main window reference for sending logs to renderer
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Send log to renderer DevTools (development only)
   */
  sendToDevTools(
    category: DevToolsLogCategory,
    level: DevToolsLogLevel,
    data: DevToolsLogPayload['data']
  ): void {
    if (this.isPackaged) {
      return;
    }

    if (!DEV_LOGGING_CONFIG.devToolsLogging) {
      return; // DevTools logging disabled
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        const payload: DevToolsLogPayload = {
          timestamp: new Date().toISOString(),
          category,
          level,
          data,
        };
        this.mainWindow.webContents.send('devtools-log', payload);
      } catch (error) {
        // Silently fail - don't want logging to break the app
        console.error('Failed to send log to DevTools:', error);
      }
    }
  }

  /**
   * Log an info message
   */
  info(...args: any[]): void {
    if (this.isPackaged) {
      log.info(...args);
    } else {
      if (DEV_LOGGING_CONFIG.terminalLogging) {
        console.log(...args);
      }
      this.sendToDevTools('general', 'info', { message: args });
    }
  }

  /**
   * Log an error message
   */
  error(...args: any[]): void {
    if (this.isPackaged) {
      log.error(...args);
    } else {
      if (DEV_LOGGING_CONFIG.terminalLogging) {
        console.error(...args);
      }
      this.sendToDevTools('general', 'error', { message: args });
    }
  }

  /**
   * Log a warning message
   */
  warn(...args: any[]): void {
    if (this.isPackaged) {
      log.warn(...args);
    } else {
      if (DEV_LOGGING_CONFIG.terminalLogging) {
        console.warn(...args);
      }
      this.sendToDevTools('general', 'warn', { message: args });
    }
  }

  /**
   * Log a debug message
   */
  debug(...args: any[]): void {
    if (this.isPackaged) {
      log.debug(...args);
    } else {
      if (DEV_LOGGING_CONFIG.terminalLogging) {
        console.debug(...args);
      }
      this.sendToDevTools('general', 'debug', { message: args });
    }
  }

  /**
   * Check if terminal logging is enabled (for external API logging)
   */
  isTerminalLoggingEnabled(): boolean {
    return !this.isPackaged && DEV_LOGGING_CONFIG.terminalLogging;
  }
}

// Default logger instance for use throughout the application
export const defaultLogger = new Logger(
  app.isPackaged,
  app.getVersion(),
  getChannelFromVersion()
);
