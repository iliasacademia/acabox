import { app } from 'electron';
import { getDeviceId } from '../deviceId';

// Helper function to detect channel from version string
export function getChannelFromVersion(): 'stable' | 'beta' {
  const version = app.getVersion();
  return version.includes('-beta') ? 'beta' : 'stable';
}

/**
 * Centralized logging configuration for the application.
 *
 * This config controls:
 * - DevTools logging (IPC to renderer)
 * - Terminal logging (console output)
 * - Datadog cloud logging
 * - Default metadata attached to all logs
 */
export const LOGGING_CONFIG = {
  // Development logging toggles
  devToolsLogging: true, // Send logs to renderer DevTools console
  terminalLogging: false, // Output logs to terminal

  // Datadog configuration (using Client Token - safe for packaged apps)
  datadog: {
    // Enabled in production, or when feature flag is set in development
    enabled: process.env.DATADOG_ENABLED === 'true' || app.isPackaged,
    clientToken: process.env.DATADOG_CLIENT_TOKEN || '',
    site: process.env.DATADOG_SITE || 'datadoghq.com',
    service: 'academia-electron',
    env: app.isPackaged ? 'production' : 'development',
  },

  // electron-log file configuration
  file: {
    maxSize: 5 * 1024 * 1024, // 5MB max file size
    devFileName: 'main-dev.log',
    getProductionFileName: () => `main-${getChannelFromVersion()}.log`,
  },

  // Default metadata attached to all logs
  getDefaultMetadata: () => ({
    appVersion: app.getVersion(),
    channel: getChannelFromVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    deviceId: getDeviceId(),
  }),
};

export type LoggingConfig = typeof LOGGING_CONFIG;
