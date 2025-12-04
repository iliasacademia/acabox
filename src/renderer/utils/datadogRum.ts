import { datadogRum } from '@datadog/browser-rum';

/**
 * Initialize Datadog RUM (Real User Monitoring) for the renderer process.
 *
 * RUM provides:
 * - Session tracking and replay
 * - Error tracking with stack traces
 * - Performance monitoring
 * - Custom action and log tracking
 *
 * This runs in the renderer process (browser environment) where Datadog's
 * browser SDK is fully supported.
 */

// Get configuration from environment or use defaults
const DATADOG_CONFIG = {
  applicationId: '210900a6-7493-4824-82dd-84f67aabe95f',
  clientToken: 'pub3ff81d1497ab83741b388cd92525d9e7',
  site: 'datadoghq.com',
  service: 'academia-electron',
  env: 'development',
};

let isInitialized = false;

/**
 * Initialize Datadog RUM. Should be called once at app startup.
 */
export function initDatadogRum(): void {
  if (isInitialized) {
    return;
  }

  try {
    datadogRum.init({
      applicationId: DATADOG_CONFIG.applicationId,
      clientToken: DATADOG_CONFIG.clientToken,
      site: DATADOG_CONFIG.site,
      service: DATADOG_CONFIG.service,
      env: DATADOG_CONFIG.env,
      // Version from package.json (injected by webpack)
      version: '0.0.1',
      // Sample 100% of sessions
      sessionSampleRate: 100,
      // Record 20% of sessions for replay
      sessionReplaySampleRate: 20,
      // Allow fallback to localStorage if cookies are blocked
      allowFallbackToLocalStorage: true,
      // Track back/forward cache navigations
      trackBfcacheViews: true,
      // Privacy settings
      defaultPrivacyLevel: 'mask-user-input',
      // Track user interactions
      trackUserInteractions: true,
      // Track resources (XHR, fetch, etc.)
      trackResources: true,
      // Track long tasks
      trackLongTasks: true,
    });

    isInitialized = true;
    console.log('[Datadog RUM] Initialized successfully');
  } catch (error) {
    console.error('[Datadog RUM] Failed to initialize:', error);
  }
}

/**
 * Log an info message to Datadog RUM as a custom action.
 */
export function logInfo(message: string, context?: Record<string, unknown>): void {
  if (!isInitialized) return;
  datadogRum.addAction(message, { level: 'info', ...context });
}

/**
 * Log a warning to Datadog RUM as a custom action.
 */
export function logWarn(message: string, context?: Record<string, unknown>): void {
  if (!isInitialized) return;
  datadogRum.addAction(message, { level: 'warn', ...context });
}

/**
 * Log an error to Datadog RUM.
 */
export function logError(message: string, error?: Error, context?: Record<string, unknown>): void {
  if (!isInitialized) return;

  if (error) {
    datadogRum.addError(error, { message, ...context });
  } else {
    datadogRum.addAction(message, { level: 'error', ...context });
  }
}

/**
 * Log a debug message to Datadog RUM as a custom action.
 * Only logs in development mode.
 */
export function logDebug(message: string, context?: Record<string, unknown>): void {
  if (!isInitialized) return;
  if (DATADOG_CONFIG.env !== 'development') return;
  datadogRum.addAction(message, { level: 'debug', ...context });
}

/**
 * Set user information for the current session.
 */
export function setUser(user: { id: string; email?: string; name?: string }): void {
  if (!isInitialized) return;
  datadogRum.setUser(user);
}

/**
 * Clear user information (on logout).
 */
export function clearUser(): void {
  if (!isInitialized) return;
  datadogRum.clearUser();
}

/**
 * Add global context that will be attached to all events.
 */
export function setGlobalContext(key: string, value: unknown): void {
  if (!isInitialized) return;
  datadogRum.setGlobalContextProperty(key, value);
}

// Export the raw datadogRum instance for advanced usage
export { datadogRum };
