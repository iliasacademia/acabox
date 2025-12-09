import { datadogRum } from "@datadog/browser-rum";
import { IPC_CHANNELS } from "../../shared/types";

/**
 * Analytics service for tracking user interactions and events.
 * Sends events to Academia.edu's Arbitrary Events API.
 *
 * Backend API: POST /api/v0/arbitrary_event
 * - Automatically adds: timestamp, actor_id (user_id), ip, user_agent
 * - Data goes to: AWS Firehose → Redshift
 * - Max size: 5KB per event
 *
 * Frontend sends:
 * {
 *   arbitrary_event: {
 *     event_type: "DesktopAppEvent",
 *     data: {
 *       event_name: string (e.g., "project", "notification", "conversation_message")
 *       action: string (e.g., "click", "view", "sent", "received")
 *       source: "desktop" | "overlay"
 *       metadata: object (event-specific data)
 *       project_id: number (when applicable)
 *       // actor_id is NOT sent - backend adds it automatically from session
 *     }
 *   }
 * }
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

// Check if in development mode
const isDevelopment = process.env.NODE_ENV === "development";

/**
 * Send event to Academia.edu backend API.
 *
 * @param eventName - Event name with underscores (e.g., "new_project", "conversation_message")
 * @param action - Action performed (e.g., "click", "view", "sent", "received")
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

    await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'POST',
      endpoint: 'v0/arbitrary_event',
      data: {
        arbitrary_event: {
          event_type: 'DesktopAppEvent',
          data: eventData,
        },
      },
    });

    if (isDevelopment) {
      console.log("[Analytics]", eventName, action, source, metadata);
    }
  } catch (error) {
    // Don't throw - analytics failures shouldn't break the app
    console.error(
      "[Analytics] Failed to send event:",
      eventName,
      action,
      error,
    );
  }
}

/**
 * Also send to Datadog RUM for debugging/monitoring (optional).
 */
function sendToDatadog(
  eventName: string,
  action: string,
  context: Record<string, unknown>,
): void {
  try {
    if (datadogRum && typeof datadogRum.addAction === "function") {
      datadogRum.addAction(`${eventName}.${action}`, context);
    }
  } catch (error) {
    // Silently fail
  }
}

// =============================================================================
// PROJECT EVENTS
// =============================================================================

/**
 * Track when user views the projects list
 */
export function trackProjectsView(): void {
  sendToBackend("projects", "view", "desktop");
  sendToDatadog("projects", "view", {});
}

/**
 * Track when user clicks on a project
 */
export function trackProjectClick(projectId: number): void {
  sendToBackend("project", "click", "desktop", {}, projectId);
  sendToDatadog("project", "click", { projectId });
}

/**
 * Track when user views a project
 */
export function trackProjectView(projectId: number): void {
  sendToBackend("project", "view", "desktop", {}, projectId);
  sendToDatadog("project", "view", { projectId });
}

// =============================================================================
// ONBOARDING EVENTS (Project Creation Flow)
// =============================================================================

/**
 * Track when user clicks "New Project" button
 */
export function trackNewProjectClick(): void {
  sendToBackend("new_project", "click", "desktop", {});
  sendToDatadog("new_project", "click", {});
}

/**
 * Track when new project modal is shown
 */
export function trackNewProjectModalView(): void {
  sendToBackend("new_project_modal", "view", "desktop", {});
  sendToDatadog("new_project_modal", "view", {});
}

/**
 * Track when folder selection modal is shown
 */
export function trackSelectFolderModalView(): void {
  sendToBackend("select_folder_modal", "view", "desktop", {});
  sendToDatadog("select_folder_modal", "view", {});
}

/**
 * Track when manuscript selection step is shown
 */
export function trackSelectManuscriptView(): void {
  sendToBackend("select_manuscript", "view", "desktop", {});
  sendToDatadog("select_manuscript", "view", {});
}

/**
 * Track when user completes project creation
 */
export function trackCreateProjectClick(): void {
  sendToBackend("create_project", "click", "desktop", {});
  sendToDatadog("create_project", "click", {});
}

/**
 * Track when user closes a modal
 */
export function trackCloseModalClick(): void {
  sendToBackend("close_modal", "click", "desktop", {});
  sendToDatadog("close_modal", "click", {});
}

// =============================================================================
// CONVERSATION EVENTS
// =============================================================================

/**
 * Track when user views a conversation
 */
export function trackConversationView(
  projectId: number,
  conversationId: number,
  agentName: string,
): void {
  sendToBackend(
    "conversation",
    "view",
    "desktop",
    { conversation_id: conversationId, agent_name: agentName },
    projectId,
  );
  sendToDatadog("conversation", "view", {
    projectId,
    conversationId,
    agentName,
  });
}

/**
 * Track when user sends a message in conversation
 */
export function trackConversationMessageSent(
  projectId: number,
  conversationId: number,
  agentName: string,
): void {
  sendToBackend(
    "conversation_message",
    "sent",
    "desktop",
    { conversation_id: conversationId, agent_name: agentName },
    projectId,
  );
  sendToDatadog("conversation_message", "sent", {
    projectId,
    conversationId,
    agentName,
  });
}

/**
 * Track when user receives a message from agent
 */
export function trackConversationMessageReceived(
  projectId: number,
  conversationId: number,
  agentName: string,
  durationSeconds?: number,
): void {
  const metadata: EventMetadata = {
    conversation_id: conversationId,
    agent_name: agentName,
  };

  if (durationSeconds !== undefined) {
    metadata.duration_seconds = durationSeconds;
  }

  sendToBackend(
    "conversation_message",
    "received",
    "desktop",
    metadata,
    projectId,
  );
  sendToDatadog("conversation_message", "received", {
    projectId,
    conversationId,
    agentName,
    durationSeconds,
  });
}

// =============================================================================
// NOTIFICATION EVENTS
// =============================================================================

/**
 * Track when notification is shown to user
 */
export function trackNotificationView(
  projectId: number,
  conversationId: number,
  agentName: string,
): void {
  sendToBackend(
    "notification",
    "view",
    "desktop",
    { conversation_id: conversationId, agent_name: agentName },
    projectId,
  );
  sendToDatadog("notification", "view", {
    projectId,
    conversationId,
    agentName,
  });
}

/**
 * Track when user clicks on a notification
 */
export function trackNotificationClick(
  projectId: number,
  conversationId: number,
  agentName: string,
): void {
  sendToBackend(
    "notification",
    "click",
    "desktop",
    { conversation_id: conversationId, agent_name: agentName },
    projectId,
  );
  sendToDatadog("notification", "click", {
    projectId,
    conversationId,
    agentName,
  });
}

// =============================================================================
// REVIEW TRIGGER EVENTS
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
  sendToDatadog("trigger_full_review", "click", { source, projectId, fileId });
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
  sendToDatadog("trigger_diff_review", "click", { source, projectId, fileId });
}

// =============================================================================
// FILE EVENTS
// =============================================================================

/**
 * Track when manuscript file is saved
 */
export function trackManuscriptFileSaved(
  projectId: number,
  fileId: number,
): void {
  sendToBackend(
    "manuscript_file",
    "saved",
    "desktop",
    { file_id: fileId },
    projectId,
  );
  sendToDatadog("manuscript_file", "saved", { projectId, fileId });
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
  sendToDatadog("academia_button", "view", { projectId, fileId });
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
  sendToDatadog("academia_button", "click", { projectId, fileId });
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
  sendToDatadog("academia_button_notification_popup", "view", {
    projectId,
    fileId,
  });
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
  sendToDatadog("academia_button_new_review", "click", {
    projectId,
    fileId,
    conversationId,
    agentName,
  });
}
