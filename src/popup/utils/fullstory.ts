import { FullStory, init } from '@fullstory/browser';

let isInitialized = false;
let initInProgress = false;

/**
 * Notify FullStory of webview visibility changes.
 *
 * FullStory is eagerly initialized on the FIRST call (even with `visible=false`)
 * so the recording script has time to load before the webview becomes visible.
 * This is critical for short-lived webviews like review-button and
 * review-status-overlay that may only be visible briefly.
 *
 * Visibility changes fire "${Context} Shown" / "${Context} Hidden" events and
 * set a page-level `visible` property so sessions can be filtered in the
 * FullStory dashboard.
 */
export async function onVisibilityChanged(context: string, visible: boolean): Promise<void> {
  const label = context.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const logPrefix = `[FullStory:${label}]`;

  // Eagerly initialize on the very first call (regardless of visibility).
  // This gives the recording script time to load while the webview is hidden.
  if (!isInitialized && !initInProgress) {
    initInProgress = true;
    try {
      await initFullStory(context);
    } catch (error) {
      console.error(`${logPrefix} Failed to initialize:`, error);
      return;
    } finally {
      initInProgress = false;
    }
  }

  if (!visible) {
    document.body.style.opacity = '0.2';
    if (isInitialized) {
      try {
        FullStory('trackEvent', { name: `${label} Hidden`, properties: {} });
        FullStory('setProperties', {
          type: 'page',
          properties: { visible: false },
        });
        console.log(`${logPrefix} ${label} Hidden event sent`);
      } catch (error) {
        console.warn(`${logPrefix} Failed to track ${label} Hidden:`, error);
      }
    }
    return;
  }

  // visible=true path
  document.body.style.opacity = '1';

  // Fire "${Context} Shown" event + property
  if (isInitialized) {
    try {
      FullStory('trackEvent', { name: `${label} Shown`, properties: {} });
      FullStory('setProperties', {
        type: 'page',
        properties: { visible: true },
      });
      console.log(`${logPrefix} ${label} Shown event sent`);
    } catch (error) {
      console.warn(`${logPrefix} Failed to track ${label} Shown:`, error);
    }
  }
}

/**
 * Intercept the <script> tag that @fullstory/snippet creates and redirect it
 * to a locally-served copy of fs.js. The snippet hardcodes the CDN URL in
 * executeSnippet(), so we monkey-patch Node.prototype.insertBefore and
 * appendChild to catch the script element before it hits the DOM.
 */
function interceptFullStoryScript(localSrc: string): void {
  const origInsertBefore = Node.prototype.insertBefore;
  const origAppendChild = Node.prototype.appendChild;

  function maybeRedirect<T extends Node>(node: T): boolean {
    if (node instanceof HTMLScriptElement && node.src.includes('edge.fullstory.com/s/fs.js')) {
      node.src = localSrc;
      Node.prototype.insertBefore = origInsertBefore;
      Node.prototype.appendChild = origAppendChild;
      return true;
    }
    return false;
  }

  Node.prototype.insertBefore = function <T extends Node>(newChild: T, refChild: Node | null): T {
    maybeRedirect(newChild);
    return origInsertBefore.call(this, newChild, refChild) as T;
  };

  Node.prototype.appendChild = function <T extends Node>(newChild: T): T {
    maybeRedirect(newChild);
    return origAppendChild.call(this, newChild) as T;
  };
}

/**
 * Internal: initialize FullStory, set identity, set page properties.
 * All API calls happen after init() completes.
 */
async function initFullStory(context: string): Promise<void> {
  const label = context.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const logPrefix = `[FullStory:${label}]`;

  const serverUrl = window.location.origin;
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const wid = urlParams.get('wid');

  if (!token) {
    console.warn(`${logPrefix} No auth token found in URL params, skipping init`);
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

  // Intercept the <script> tag that @fullstory/snippet will create, redirecting
  // it from the FullStory CDN to our locally-served copy for instant loading.
  const localFsSrc = `${serverUrl}/ui/popup/fs.js`;
  interceptFullStoryScript(localFsSrc);

  init({
    orgId: '17I9',
    devMode: forceRecording ? false : isDevMode,
  });

  isInitialized = true;
  if (forceRecording && isDevMode) {
    console.log(`${logPrefix} Initialized (FORCED recording enabled)`);
  } else {
    console.log(`${logPrefix} Initialized`, isDevMode ? '(dev mode - recording disabled)' : '');
  }

  // Set page properties
  try {
    FullStory('setProperties', {
      type: 'page',
      properties: {
        context,
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
          context,
        },
      });
      console.log(`${logPrefix} User identified:`, userInfo.userId);
    }
  } catch (error) {
    console.warn(`${logPrefix} Failed to identify user:`, error);
  }
}
