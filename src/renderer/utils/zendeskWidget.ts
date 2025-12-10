/**
 * Initialize and manage Zendesk Web Widget (Messenger) for customer support.
 *
 * Features:
 * - Live chat with support agents
 * - Ticket submission
 * - Help center articles
 * - User identification and context
 *
 * This runs in the renderer process and dynamically loads the Zendesk widget script.
 */

// Configuration from environment variables (injected at build time via webpack DefinePlugin)
const ZENDESK_CONFIG = {
  widgetKey: process.env.ZENDESK_WIDGET_KEY || '',
  enabled: process.env.ZENDESK_ENABLED === 'true',
};

// Global Zendesk API object (available after script loads)
declare global {
  interface Window {
    zE?: (api: string, method: string, ...args: any[]) => void;
    zESettings?: any;
  }
}

let isInitialized = false;
let isScriptLoaded = false;

/**
 * Initialize Zendesk Widget. Should be called once after user authentication.
 */
export function initZendeskWidget(user?: { id: string; email?: string; name?: string }): void {
  if (isInitialized) {
    console.log('[Zendesk Widget] Already initialized');
    return;
  }

  // Skip initialization if not enabled or no widget key configured
  if (!ZENDESK_CONFIG.enabled) {
    console.log('[Zendesk Widget] Skipped - disabled via ZENDESK_ENABLED flag');
    return;
  }

  if (!ZENDESK_CONFIG.widgetKey) {
    console.log('[Zendesk Widget] Skipped - ZENDESK_WIDGET_KEY not configured');
    return;
  }

  try {
    // Configure widget settings before loading script
    window.zESettings = {
      webWidget: {
        // Hide widget initially - we'll show it after user auth
        chat: {
          suppress: false, // Enable chat
        },
        contactForm: {
          suppress: false, // Enable contact form
        },
        helpCenter: {
          suppress: false, // Enable help center
        },
        // Position at bottom-right (default, but explicit for clarity)
        offset: {
          horizontal: '20px',
          vertical: '20px',
          mobile: {
            horizontal: '10px',
            vertical: '10px',
          },
        },
        // Customize color to match app theme
        color: {
          theme: '#1f73b7', // Academia blue
          launcher: '#1f73b7',
          launcherText: '#FFFFFF',
        },
        // Pre-fill user information if available
        ...(user && {
          contactForm: {
            fields: [
              { id: 'name', prefill: { '*': user.name || '' } },
              { id: 'email', prefill: { '*': user.email || '' } },
            ],
          },
        }),
      },
    };

    // Load Zendesk widget script dynamically
    loadZendeskScript();

    isInitialized = true;
    console.log('[Zendesk Widget] Initialized successfully', user ? `with user: ${user.name}` : '');

    // If user info provided, identify user after script loads
    if (user) {
      // Wait for script to load before identifying
      waitForScriptLoad(() => {
        identifyUser(user);
      });
    }
  } catch (error) {
    console.error('[Zendesk Widget] Failed to initialize:', error);
  }
}

/**
 * Load Zendesk widget script dynamically.
 */
function loadZendeskScript(): void {
  const script = document.createElement('script');
  script.id = 'ze-snippet';
  script.src = `https://static.zdassets.com/ekr/snippet.js?key=${ZENDESK_CONFIG.widgetKey}`;
  script.async = true;

  script.onload = () => {
    isScriptLoaded = true;
    console.log('[Zendesk Widget] Script loaded successfully');
  };

  script.onerror = (error) => {
    console.error('[Zendesk Widget] Failed to load script:', error);
  };

  document.head.appendChild(script);
}

/**
 * Wait for Zendesk script to load and API to be available.
 */
function waitForScriptLoad(callback: () => void, maxAttempts = 50): void {
  let attempts = 0;

  const checkLoaded = () => {
    attempts++;
    if (window.zE) {
      callback();
    } else if (attempts < maxAttempts) {
      setTimeout(checkLoaded, 100);
    } else {
      console.error('[Zendesk Widget] Timeout waiting for script to load');
    }
  };

  checkLoaded();
}

/**
 * Identify user to Zendesk for personalized support.
 * Note: The new Zendesk Messaging SDK handles user info automatically from conversations.
 * Pre-filling requires JWT authentication which we're not implementing yet.
 */
export function identifyUser(user: { id: string; email?: string; name?: string }): void {
  if (!isInitialized || !isScriptLoaded) {
    console.warn('[Zendesk Widget] Cannot identify user - widget not initialized');
    return;
  }

  if (!window.zE) {
    console.warn('[Zendesk Widget] zE API not available');
    return;
  }

  try {
    // For the Zendesk Messaging SDK, user identification happens through conversations
    // The widget will prompt users to enter their details when they start a conversation
    // To enable automatic identification, you would need to implement JWT authentication
    console.log('[Zendesk Widget] User context available:', {
      id: user.id,
      email: user.email,
      name: user.name,
    });

    // Note: If JWT authentication is implemented in the future, use:
    // window.zE('messenger', 'loginUser', function (callback: (token: string) => void) {
    //   callback(jwtToken);
    // });
  } catch (error) {
    console.error('[Zendesk Widget] Failed to identify user:', error);
  }
}

/**
 * Set additional context for the support conversation.
 * For example, current project ID.
 */
export function setConversationContext(context: Record<string, any>): void {
  if (!isInitialized || !window.zE) {
    return;
  }

  try {
    // Add context as conversation fields
    // Note: This requires custom fields to be configured in Zendesk
    const fields = Object.entries(context).map(([key, value]) => ({
      id: key,
      value: String(value),
    }));

    if (fields.length > 0) {
      window.zE('messenger', 'setConversationFields', fields);
      console.log('[Zendesk Widget] Context updated:', context);
    }
  } catch (error) {
    console.error('[Zendesk Widget] Failed to set context:', error);
  }
}

/**
 * Open the Zendesk widget programmatically.
 */
export function openWidget(): void {
  if (!isInitialized || !window.zE) {
    return;
  }

  try {
    window.zE('messenger', 'open');
  } catch (error) {
    console.error('[Zendesk Widget] Failed to open widget:', error);
  }
}

/**
 * Close the Zendesk widget programmatically.
 */
export function closeWidget(): void {
  if (!isInitialized || !window.zE) {
    return;
  }

  try {
    window.zE('messenger', 'close');
  } catch (error) {
    console.error('[Zendesk Widget] Failed to close widget:', error);
  }
}

/**
 * Show the Zendesk widget launcher button.
 */
export function showWidget(): void {
  if (!isInitialized || !window.zE) {
    return;
  }

  try {
    window.zE('messenger', 'show');
    console.log('[Zendesk Widget] Widget shown');
  } catch (error) {
    console.error('[Zendesk Widget] Failed to show widget:', error);
  }
}

/**
 * Hide the Zendesk widget launcher button.
 */
export function hideWidget(): void {
  if (!isInitialized || !window.zE) {
    return;
  }

  try {
    window.zE('messenger', 'hide');
    console.log('[Zendesk Widget] Widget hidden');
  } catch (error) {
    console.error('[Zendesk Widget] Failed to hide widget:', error);
  }
}

/**
 * Clean up Zendesk widget on logout.
 */
export function cleanupZendeskWidget(): void {
  if (!isInitialized) {
    return;
  }

  try {
    // Logout user from Zendesk
    if (window.zE) {
      window.zE('messenger', 'logoutUser');
      hideWidget();
    }

    console.log('[Zendesk Widget] Cleaned up');
  } catch (error) {
    console.error('[Zendesk Widget] Failed to cleanup:', error);
  }
}

/**
 * Check if Zendesk widget is initialized and ready.
 */
export function isZendeskReady(): boolean {
  return isInitialized && isScriptLoaded && !!window.zE;
}
