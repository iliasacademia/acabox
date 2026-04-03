import { FullStory, init } from '@fullstory/browser';

let isInitialized = false;
let initInProgress = false;

export interface FullStoryConfig {
  userId: number | null;
  email: string;
  displayName: string;
  deviceId: string;
  appVersion: string;
  isPackaged: boolean;
  forceFullStoryRecording: boolean;
}

let cachedConfig: FullStoryConfig | null = null;
let identifiedUserId: number | null = null;

/**
 * Cache the FullStory config received from poll data.
 * Always updates cachedConfig so new user data is stored.
 * If FullStory is already initialized and the userId changed,
 * re-identifies with the new user or shuts down.
 */
export function cacheFullStoryConfig(config: FullStoryConfig): void {
  cachedConfig = config;

  // Re-identify if userId changed (e.g. logout → login with different account)
  if (isInitialized && config.userId !== identifiedUserId) {
    if (config.userId) {
      FullStory('setIdentity', {
        uid: String(config.userId),
        properties: {
          email: config.email || '',
          displayName: config.displayName || '',
          deviceId: config.deviceId || '',
          appVersion: config.appVersion || '',
        },
      });
      console.log(`[FullStory] Re-identified user: ${config.userId}`);
      identifiedUserId = config.userId;
    } else {
      console.warn('[FullStory] User logged out, shutting down');
      FullStory('shutdown');
      isInitialized = false;
      identifiedUserId = null;
    }
  }
}

/**
 * Notify FullStory of webview visibility changes.
 *
 * FullStory is eagerly initialized on the FIRST call (even with `visible=false`)
 * so the recording script has time to load before the webview becomes visible.
 * This is critical for short-lived webviews like review-button that may
 * only be visible briefly.
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
 * Internal: initialize FullStory using cached config from poll data.
 * No HTTP fetches — all data comes from the module-level cachedConfig.
 */
async function initFullStory(context: string): Promise<void> {
  const label = context.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const logPrefix = `[FullStory:${label}]`;

  if (!cachedConfig) {
    console.warn(`${logPrefix} No FullStory config cached, shutting down`);
    return;
  }

  const serverUrl = window.location.origin;
  const urlParams = new URLSearchParams(window.location.search);
  const wid = urlParams.get('wid');

  const isDevMode = !cachedConfig.isPackaged;
  const forceRecording = cachedConfig.forceFullStoryRecording === true;

  // Intercept the <script> tag that @fullstory/snippet will create, redirecting
  // it from the FullStory CDN to our locally-served copy for instant loading.
  const localFsSrc = `${serverUrl}/ui/popup/fs.js`;
  interceptFullStoryScript(localFsSrc);

  init({
    orgId: '17I9',
    devMode: forceRecording ? false : isDevMode,
  });

  if (forceRecording && isDevMode) {
    console.log(`${logPrefix} Initialized (FORCED recording enabled)`);
  } else {
    console.log(`${logPrefix} Initialized`, isDevMode ? '(dev mode - recording disabled)' : '');
  }

  // Identify user — if no userId, shut down FullStory to prevent anonymous sessions
  if (cachedConfig.userId) {
    FullStory('setIdentity', {
      uid: String(cachedConfig.userId),
      properties: {
        email: cachedConfig.email || '',
        displayName: cachedConfig.displayName || '',
        deviceId: cachedConfig.deviceId || '',
        appVersion: cachedConfig.appVersion || '',
        context,
      },
    });
    identifiedUserId = cachedConfig.userId;
    console.log(`${logPrefix} User identified:`, cachedConfig.userId);
  } else {
    console.warn(`${logPrefix} Shutting down FullStory — no userId in config`);
    FullStory('shutdown');
    return;
  }

  isInitialized = true;

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
}
