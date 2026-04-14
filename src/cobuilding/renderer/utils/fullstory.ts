import { FullStory, init } from '@fullstory/browser';

let isInitialized = false;

export function initFullStory(isPackaged?: boolean): void {
  if (isInitialized) return;

  // Use isPackaged (runtime) when available; fall back to NODE_ENV (build-time)
  const isDevMode = isPackaged !== undefined
    ? !isPackaged
    : process.env.NODE_ENV !== 'production';

  try {
    init({
      orgId: '17I9',
      devMode: isDevMode,
    });

    isInitialized = true;
    console.log('[FullStory] Initialized, devMode:', isDevMode);
  } catch (error) {
    console.error('[FullStory] Failed to initialize:', error);
  }
}

export function identifyUser(
  userId: number,
  email?: string,
  displayName?: string,
  deviceId?: string,
  appVersion?: string
): void {
  if (!isInitialized) return;

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
    console.log('[FullStory] User identified:', userId);
  } catch (error) {
    console.error('[FullStory] Failed to identify user:', error);
  }
}

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
