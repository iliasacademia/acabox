import log from 'electron-log';
import { BrowserWindow, app } from 'electron';

// Development logging configuration
export const DEV_LOGGING_CONFIG = {
  devToolsLogging: true,   // Send logs to renderer DevTools console
  terminalLogging: true,   // Output logs to terminal
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
  private sendToRenderer(level: string, args: any[]): void {
    if (!DEV_LOGGING_CONFIG.devToolsLogging) {
      return; // DevTools logging disabled
    }

    if (!this.isPackaged && this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('api-log', {
          type: level,
          message: args,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        // Silently fail - don't want logging to break the app
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
      this.sendToRenderer('info', args);
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
      this.sendToRenderer('error', args);
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
      this.sendToRenderer('warn', args);
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
      this.sendToRenderer('debug', args);
    }
  }

  /**
   * Log an API request
   */
  apiRequest(method: string, endpoint: string, data?: any): void {
    if (!this.isPackaged && this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('api-log', {
          type: 'request',
          method,
          endpoint,
          data,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        // Silently fail
        console.error('Error sending API request log to renderer:', error);
      }
    }

    // Also log to terminal if enabled
    if (!this.isPackaged && DEV_LOGGING_CONFIG.terminalLogging) {
      console.log(`[API REQUEST] ${method} ${endpoint}`, data || '');
    }
  }

  /**
   * Log an API response
   */
  apiResponse(method: string, endpoint: string, status: number, statusText: string, data?: any): void {
    if (!this.isPackaged && this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('api-log', {
          type: 'response',
          method,
          endpoint,
          status,
          statusText,
          data,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        // Silently fail
        console.error('Error sending API response log to renderer:', error);
      }
    }

    if (!this.isPackaged && DEV_LOGGING_CONFIG.terminalLogging) {
      console.log(`[API RESPONSE] ${method} ${endpoint} - ${status} ${statusText}`, JSON.stringify(data) || '');
    }
  }

  /**
   * Log an API error
   */
  apiError(method: string, endpoint: string, url: string, message: string, status?: number, data?: any): void {
    if (!this.isPackaged && this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('api-log', {
          type: 'error',
          method,
          endpoint,
          url,
          message,
          status,
          data,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        // Silently fail
      }
    }

    if (!this.isPackaged && DEV_LOGGING_CONFIG.terminalLogging) {
      console.error(`[API ERROR] ${method} ${endpoint}`, { url, message, status, data });
    }
  }
}

// Default logger instance for use throughout the application
export const defaultLogger = new Logger(
  app.isPackaged,
  app.getVersion(),
  getChannelFromVersion()
);
