import { FullStory, init } from '@fullstory/browser';
import { IPC_CHANNELS } from '../../shared/types';

let isInitialized = false;

/**
 * Initialize FullStory session recording.
 * Call this early in the app lifecycle (e.g., in App.tsx).
 *
 * Note: FullStory doesn't officially support Electron. Session replay
 * may have issues in production builds using file:// protocol.
 */
export async function initFullStory(): Promise<void> {
  if (isInitialized) return;

  try {
    // Get app info to determine if we're in development mode
    const appInfo = await window.electronAPI.invoke(IPC_CHANNELS.GET_APP_INFO);
    const isDevMode = !appInfo.isPackaged;
    const forceRecording = process.env.FULLSTORY_FORCE_RECORDING === 'true';

    init({
      orgId: '17I9',
      // Disable recording in development (unpackaged) builds unless forced
      devMode: forceRecording ? false : isDevMode,
    });

    isInitialized = true;
    if (forceRecording && isDevMode) {
      console.log('[FullStory] Initialized (FORCED recording enabled)');
    } else {
      console.log('[FullStory] Initialized', isDevMode ? '(dev mode - recording disabled)' : '');
    }

    // Log diagnostic info for debugging session visibility
    console.log('[FullStory] Page URL:', window.location.href);
    console.log('[FullStory] devMode passed to init:', forceRecording ? false : isDevMode);
    try {
      const sessionUrl = FullStory('getSession');
      console.log('[FullStory] Session URL:', sessionUrl || '(not available yet)');
    } catch {
      console.log('[FullStory] Session URL: (not available yet)');
    }
  } catch (error) {
    console.error('[FullStory] Failed to initialize:', error);
  }
}

/**
 * Identify the current user for session attribution.
 * Call this after successful login.
 *
 * @param userId - The user's numeric ID
 * @param email - Optional email address
 * @param displayName - Optional display name
 * @param deviceId - Optional device/machine ID for cross-device tracking
 * @param appVersion - Optional app version string
 */
export function identifyUser(
  userId: number,
  email?: string,
  displayName?: string,
  deviceId?: string,
  appVersion?: string
): void {
  if (!isInitialized) {
    console.warn('[FullStory] Cannot identify user - not initialized');
    return;
  }

  try {
    FullStory('setIdentity', {
      uid: String(userId),
      properties: {
        email: email || '',
        displayName: displayName || '',
        deviceId: deviceId || '',
        appVersion: appVersion || '',
      },
    });

    console.log('[FullStory] User identified:', { userId, email, displayName, deviceId, appVersion });
    try {
      const sessionUrl = FullStory('getSession');
      console.log('[FullStory] Session URL after identify:', sessionUrl || '(not available)');
    } catch {
      console.log('[FullStory] Session URL after identify: (not available)');
    }
  } catch (error) {
    console.error('[FullStory] Failed to identify user:', error);
  }
}

/**
 * Clear user identity on logout.
 * Resets to anonymous session tracking.
 */
export function clearUserIdentity(): void {
  if (!isInitialized) return;

  try {
    FullStory('setIdentity', { anonymous: true });
    console.log('[FullStory] User identity cleared');
  } catch (error) {
    console.error('[FullStory] Failed to clear identity:', error);
  }
}

/**
 * Track custom events (optional - supplements session replay).
 * Use this for important user actions you want to highlight.
 *
 * @param eventName - Name of the event (e.g., 'Project Created', 'File Uploaded')
 * @param properties - Optional event properties
 */
export function trackEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (!isInitialized) return;

  try {
    FullStory('trackEvent', {
      name: eventName,
      properties: properties || {},
    });
  } catch (error) {
    console.error('[FullStory] Failed to track event:', error);
  }
}

/**
 * Get the current session URL for debugging or support tickets.
 * Returns null if FullStory is not initialized or session URL is unavailable.
 */
export function getSessionUrl(): string | null {
  if (!isInitialized) return null;

  try {
    const sessionUrl = FullStory('getSession');
    return sessionUrl || null;
  } catch (error) {
    console.error('[FullStory] Failed to get session URL:', error);
    return null;
  }
}
