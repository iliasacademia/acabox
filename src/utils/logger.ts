import log from 'electron-log';

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
   * Log an info message
   */
  info(...args: any[]): void {
    if (this.isPackaged) {
      log.info(...args);
    } else {
      console.log(...args);
    }
  }

  /**
   * Log an error message
   */
  error(...args: any[]): void {
    if (this.isPackaged) {
      log.error(...args);
    } else {
      console.error(...args);
    }
  }

  /**
   * Log a warning message
   */
  warn(...args: any[]): void {
    if (this.isPackaged) {
      log.warn(...args);
    } else {
      console.warn(...args);
    }
  }

  /**
   * Log a debug message
   */
  debug(...args: any[]): void {
    if (this.isPackaged) {
      log.debug(...args);
    } else {
      console.debug(...args);
    }
  }
}
