import { FullStory, init } from '@fullstory/browser';
import { app } from 'electron';

let isInitialized = false;

/**
 * Initialize FullStory session recording.
 * Call this early in the app lifecycle (e.g., in App.tsx).
 *
 * Note: FullStory doesn't officially support Electron. Session replay
 * may have issues in production builds using file:// protocol.
 */
export function initFullStory(): void {
  if (isInitialized) return;

  try {
    init({
      orgId: '17I9',
      // Set devMode to true to disable recording in development
      devMode: !app.isPackaged,
    });

    isInitialized = true;
    console.log('[FullStory] Initialized');
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
 */
export function identifyUser(userId: number, email?: string, displayName?: string): void {
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
      },
    });

    console.log('[FullStory] User identified:', userId);
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
