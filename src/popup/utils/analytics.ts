/**
 * Analytics service for popup/overlay contexts
 *
 * Sends events to the HTTP server which forwards to Academia.edu's Arbitrary Events API.
 * Uses fetch() instead of window.electronAPI since popups don't have IPC access.
 */

// Event source
type EventSource = "desktop" | "overlay";

// Event metadata interface
interface EventMetadata {
  conversation_id?: number;
  agent_name?: string;
  file_id?: number;
  duration_seconds?: number;
  [key: string]: unknown;
}

// Get serverUrl from window.location.origin (popup is served from the HTTP server)
// This ensures we use the correct port even when server binds to fallback port
const serverUrl = window.location.origin;

// Get auth token from query params (passed by native bridge)
const urlParams = new URLSearchParams(window.location.search);
const authToken = urlParams.get('token') || '';

// Check if in development mode
const isDevelopment = false; // Popup always runs in production-like mode

/**
 * Send event to HTTP server which forwards to backend API.
 *
 * @param eventName - Event name with underscores (e.g., "academia_button", "trigger_full_review")
 * @param action - Action performed (e.g., "click", "view")
 * @param source - Event source ("desktop" or "overlay")
 * @param metadata - Event-specific metadata
 * @param projectId - Project ID (when applicable)
 */
async function sendToBackend(
  eventName: string,
  action: string,
  source: EventSource,
  metadata: EventMetadata = {},
  projectId?: number,
): Promise<void> {
  try {
    const eventData: Record<string, unknown> = {
      event_name: eventName,
      action,
      source,
      metadata,
    };

    if (projectId !== undefined) {
      eventData.project_id = projectId;
    }

    const response = await fetch(`${serverUrl}/api/analytics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(eventData),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (isDevelopment) {
      console.log("[Popup Analytics]", eventName, action, source, metadata);
    }
  } catch (error) {
    // Don't throw - analytics failures shouldn't break the app
    console.error(
      "[Popup Analytics] Failed to send event:",
      eventName,
      action,
      error,
    );
  }
}

// =============================================================================
// REVIEW TRIGGER EVENTS (can be called from overlay)
// =============================================================================

/**
 * Track when user triggers a full review
 */
export function trackTriggerFullReview(
  source: EventSource,
  projectId: number,
  fileId: number,
): void {
  sendToBackend(
    "trigger_full_review",
    "click",
    source,
    { file_id: fileId },
    projectId,
  );
}

/**
 * Track when user triggers a diff review
 */
export function trackTriggerDiffReview(
  source: EventSource,
  projectId: number,
  fileId: number,
): void {
  sendToBackend(
    "trigger_diff_review",
    "click",
    source,
    { file_id: fileId },
    projectId,
  );
}

// =============================================================================
// OVERLAY EVENTS (Word Integration)
// =============================================================================

/**
 * Track when Academia button is shown in Word overlay
 */
export function trackAcademiaButtonView(
  projectId: number,
  fileId: number,
): void {
  sendToBackend(
    "academia_button",
    "view",
    "overlay",
    { file_id: fileId },
    projectId,
  );
}

/**
 * Track when user clicks Academia button in Word overlay
 */
export function trackAcademiaButtonClick(
  projectId: number,
  fileId: number,
): void {
  sendToBackend(
    "academia_button",
    "click",
    "overlay",
    { file_id: fileId },
    projectId,
  );
}

/**
 * Track when notification popup is shown in Word overlay
 */
export function trackAcademiaButtonNotificationPopupView(
  projectId: number,
  fileId: number,
): void {
  sendToBackend(
    "academia_button_notification_popup",
    "view",
    "overlay",
    { file_id: fileId },
    projectId,
  );
}

/**
 * Track when user clicks "new review" from Word overlay notification
 */
export function trackAcademiaButtonNewReviewClick(
  projectId: number,
  fileId: number,
  conversationId: number,
  agentName: string,
): void {
  sendToBackend(
    "academia_button_new_review",
    "click",
    "overlay",
    {
      file_id: fileId,
      conversation_id: conversationId,
      agent_name: agentName,
    },
    projectId,
  );
}
