import { LogLayer } from 'loglayer';
import { ElectronLogTransport } from '@loglayer/transport-electron-log';
import { HttpTransport } from '@loglayer/transport-http';
import { serializeError } from 'serialize-error';
import log from 'electron-log';
import { app } from 'electron';
import { LOGGING_CONFIG } from './config/loggingConfig';
import { DevToolsTransport } from './transports/devToolsTransport';
import { createDatadogTransport } from './transports/datadogTransport';

/**
 * Configure electron-log based on environment.
 *
 * In development:
 * - Debug level file logging to main-dev.log
 * - Console transport disabled (use DevTools instead)
 *
 * In production:
 * - Info level file logging to main-{channel}.log
 * - Console transport enabled at info level
 */
function configureElectronLog(): void {
  const version = app.getVersion();
  const isPackaged = app.isPackaged;

  if (isPackaged) {
    // Production configuration
    log.transports.file.level = 'info';
    log.transports.file.maxSize = LOGGING_CONFIG.file.maxSize;
    log.transports.file.fileName = LOGGING_CONFIG.file.getProductionFileName();
    log.transports.file.format = `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v${version}] [{level}] {text}`;
    log.transports.console.level = 'info';
    log.transports.console.format = `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v${version}] [{level}] {text}`;
  } else {
    // Development configuration
    log.transports.file.level = 'debug';
    log.transports.file.maxSize = LOGGING_CONFIG.file.maxSize;
    log.transports.file.fileName = LOGGING_CONFIG.file.devFileName;
    log.transports.file.format = `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v${version}] [{level}] {text}`;
    // Disable console in dev - use DevTools instead
    log.transports.console.level = false;
  }
}

/**
 * Create the array of transports based on configuration.
 *
 * Transports:
 * - ElectronLogTransport: File logging (always enabled)
 * - DevToolsTransport: IPC to renderer DevTools console (dev only)
 * - DatadogTransport: HTTP to Datadog Logs API (when enabled)
 *
 * The Datadog transport sends logs directly from the main process,
 * ensuring logs are captured even when the renderer window is closed.
 */
function createTransports(): Array<ElectronLogTransport | DevToolsTransport | HttpTransport> {
  const transports: Array<ElectronLogTransport | DevToolsTransport | HttpTransport> = [];

  // Always add electron-log transport for file logging
  transports.push(
    new ElectronLogTransport({
      id: 'electron-log',
      logger: log,
    })
  );

  // Add DevTools transport for development
  if (!app.isPackaged) {
    transports.push(devToolsTransport);
  }

  // Add Datadog transport when enabled (production or explicit DATADOG_ENABLED=true)
  const datadogTransport = createDatadogTransport();
  if (datadogTransport) {
    transports.push(datadogTransport);
  }

  return transports;
}

// Configure electron-log before creating transports
configureElectronLog();

// Create the DevTools transport instance (singleton for window reference management)
export const devToolsTransport = new DevToolsTransport({
  id: 'devtools',
});

/**
 * Main LogLayer instance with multi-transport support.
 *
 * Features:
 * - electron-log for file logging (always enabled)
 * - DevTools IPC transport for development debugging
 * - Datadog HTTP transport for cloud logging (works even when window is closed)
 * - Structured metadata support via withMetadata()
 * - Proper error serialization
 *
 * @example
 * ```typescript
 * // Simple logging
 * logLayer.info('User logged in');
 *
 * // With metadata
 * logLayer.withMetadata({ userId: 123 }).info('User action');
 *
 * // With error
 * logLayer.withError(error).error('Operation failed');
 * ```
 */
const baseLogLayer = new LogLayer({
  errorSerializer: serializeError,
  errorFieldName: 'error',
  transport: createTransports(),
});

/**
 * LogLayer instance with default metadata pre-attached.
 *
 * Default metadata includes: appVersion, channel, platform, arch, isPackaged
 * Additional metadata can be added with .withMetadata()
 */
export const logLayer = baseLogLayer.withMetadata(LOGGING_CONFIG.getDefaultMetadata());

/**
 * Get the log file path from electron-log.
 */
export function getLogFilePath(): string {
  return log.transports.file.getFile().path;
}
