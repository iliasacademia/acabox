import { FullStory, init } from '@fullstory/browser';

let isInitialized = false;
let initInProgress = false;

/**
 * Notify FullStory of popup visibility changes.
 *
 * On the first call with `visible=true`, this lazily initializes FullStory
 * (fetching app-info and user-info), then fires a "Popup Shown" event.
 * Subsequent calls fire "Popup Shown" / "Popup Hidden" events and set a
 * page-level `popupVisible` property so sessions can be filtered in the
 * FullStory dashboard.
 *
 * Unlike the previous implementation, this does NOT use shutdown/restart —
 * recording runs continuously, and visibility is tracked via events and
 * properties.
 */
export async function onPopupVisibilityChanged(visible: boolean): Promise<void> {
  if (!visible) {
    document.body.style.opacity = '0.2';
    if (isInitialized) {
      try {
        FullStory('trackEvent', { name: 'Popup Hidden', properties: {} });
        FullStory('setProperties', {
          type: 'page',
          properties: { popupVisible: false },
        });
        console.log('[FullStory:Popup] Popup Hidden event sent');
      } catch (error) {
        console.warn('[FullStory:Popup] Failed to track Popup Hidden:', error);
      }
    }
    return;
  }

  // visible=true path
  document.body.style.opacity = '1';
  if (!isInitialized) {
    if (initInProgress) return; // another call is already initializing
    initInProgress = true;

    try {
      await initFullStory();
    } catch (error) {
      console.error('[FullStory:Popup] Failed to initialize:', error);
      initInProgress = false;
      return;
    }
  }

  // Fire "Popup Shown" event + property
  try {
    FullStory('trackEvent', { name: 'Popup Shown', properties: {} });
    FullStory('setProperties', {
      type: 'page',
      properties: { popupVisible: true },
    });
    console.log('[FullStory:Popup] Popup Shown event sent');
  } catch (error) {
    console.warn('[FullStory:Popup] Failed to track Popup Shown:', error);
  }
}

/**
 * Internal: initialize FullStory, set identity, set page properties.
 * All API calls happen after init() completes.
 */
async function initFullStory(): Promise<void> {
  const serverUrl = window.location.origin;
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const wid = urlParams.get('wid');

  if (!token) {
    console.warn('[FullStory:Popup] No auth token found in URL params, skipping init');
    return;
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Fetch app info to determine dev mode
  const appInfoRes = await fetch(`${serverUrl}/api/app-info`, { headers });
  const appInfo = await appInfoRes.json();
  const isDevMode = !appInfo.isPackaged;
  const forceRecording = appInfo.forceFullStoryRecording === true;

  init({
    orgId: '17I9',
    devMode: forceRecording ? false : isDevMode,
  });

  isInitialized = true;
  if (forceRecording && isDevMode) {
    console.log('[FullStory:Popup] Initialized (FORCED recording enabled)');
  } else {
    console.log('[FullStory:Popup] Initialized', isDevMode ? '(dev mode - recording disabled)' : '');
  }

  // Set popup-specific page properties
  try {
    FullStory('setProperties', {
      type: 'page',
      properties: {
        context: 'popup',
        wid: wid || '',
      },
    });
  } catch {
    // Non-critical — continue without properties
  }

  // Identify user
  try {
    const userInfoRes = await fetch(`${serverUrl}/api/user-info`, { headers });
    const userInfo = await userInfoRes.json();

    if (userInfo.userId) {
      FullStory('setIdentity', {
        uid: String(userInfo.userId),
        properties: {
          email: userInfo.email || '',
          displayName: userInfo.displayName || '',
          deviceId: userInfo.deviceId || '',
          appVersion: userInfo.appVersion || '',
          context: 'popup',
        },
      });
      console.log('[FullStory:Popup] User identified:', userInfo.userId);
    }
  } catch (error) {
    console.warn('[FullStory:Popup] Failed to identify user:', error);
  }
}
