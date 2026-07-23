import { HttpTransport } from '@loglayer/transport-http';
import { LOGGING_CONFIG } from '../config/loggingConfig';

/**
 * Get the Datadog browser logs intake URL for the configured site.
 *
 * Uses the browser-intake endpoint which accepts client tokens.
 * This is the same endpoint the Datadog Browser Logs SDK uses internally.
 */
function getDatadogLogsIntakeUrl(): string {
  const { site, clientToken } = LOGGING_CONFIG.datadog;

  // Map site to browser logs intake URL
  const siteMap: Record<string, string> = {
    'datadoghq.com': 'https://logs.browser-intake-datadoghq.com/api/v2/logs',
    'datadoghq.eu': 'https://logs.browser-intake-datadoghq.eu/api/v2/logs',
    'us3.datadoghq.com': 'https://logs.browser-intake-us3-datadoghq.com/api/v2/logs',
    'us5.datadoghq.com': 'https://logs.browser-intake-us5-datadoghq.com/api/v2/logs',
    'ap1.datadoghq.com': 'https://logs.browser-intake-ap1-datadoghq.com/api/v2/logs',
  };

  const baseUrl = siteMap[site] || siteMap['datadoghq.com'];
  // Client token passed as dd-api-key query parameter (this is correct even for client tokens)
  // Also include ddsource for proper log categorization
  return `${baseUrl}?dd-api-key=${clientToken}&ddsource=acabox-electron-main`;
}

/**
 * Map LogLayer log levels to Datadog status values.
 */
function mapLogLevel(level: string): string {
  const levelMap: Record<string, string> = {
    trace: 'debug',
    debug: 'debug',
    info: 'info',
    warn: 'warn',
    error: 'error',
    fatal: 'critical',
  };
  return levelMap[level] || 'info';
}

/**
 * Create a Datadog HTTP transport for LogLayer.
 *
 * This transport sends logs directly from the main process to Datadog's
 * browser HTTP intake endpoint, which works independently of the renderer
 * window. This ensures logs are captured even when the main window is closed.
 *
 * Features:
 * - Uses client token authentication (safe for packaged apps)
 * - Batches logs for efficient network usage (50 logs or 5 seconds)
 * - Compresses payloads with gzip
 * - Retries on transient failures with exponential backoff
 * - Gracefully handles offline scenarios
 *
 * @returns HttpTransport instance or null if Datadog is not enabled
 */
export function createDatadogTransport(): HttpTransport | null {
  const { enabled, clientToken, service, env } = LOGGING_CONFIG.datadog;

  // Return null if Datadog is not enabled or no client token
  if (!enabled || !clientToken) {
    return null;
  }

  // Get default metadata to attach to all logs
  const metadata = LOGGING_CONFIG.getDefaultMetadata();

  return new HttpTransport({
    id: 'datadog',
    url: getDatadogLogsIntakeUrl(),
    // No Content-Type header - Datadog browser SDK intentionally omits it
    // to avoid CORS preflight. The intake accepts newline-delimited JSON.
    headers: {},

    // Transform log data to Datadog format
    // Note: HttpTransport provides { logLevel, message, data } where message is already a string
    payloadTemplate: ({ logLevel, message, data }) => {
      return JSON.stringify({
        // Required Datadog fields
        message,
        status: mapLogLevel(logLevel),
        service,

        // Standard Datadog attributes
        ddsource: 'acabox-electron-main',
        ddtags: `env:${env},version:${metadata.appVersion},channel:${metadata.channel}`,

        // Custom attributes
        ...metadata,
        ...(data || {}),
      });
    },

    // Batching configuration
    enableBatchSend: true,
    batchSize: 50, // Send when 50 logs accumulated
    batchSendTimeout: 5000, // Or every 5 seconds, whichever first
    // Use delimiter mode (newline-separated) - Datadog expects NDJSON, not JSON array
    batchMode: 'delimiter',
    batchSendDelimiter: '\n',

    // Compression disabled - Datadog's browser intake doesn't accept gzip from Node.js
    // (causes 415 Unsupported Media Type error)
    compression: false,

    // Retry configuration
    maxRetries: 3,
    retryDelay: 1000, // 1 second base delay with exponential backoff

    // Error handling - log to file as fallback (avoid circular logging)
    onError: (error) => {
      // Use electron-log directly to avoid circular logging through LogLayer
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const log = require('electron-log');
      log.warn('[Datadog Transport] Failed to send logs:', error);
    },
  });
}
