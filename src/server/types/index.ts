/**
 * Type definitions for the HTTP server
 */

import { Notification } from '../../types/notifications';

/**
 * Server configuration
 */
export interface ServerConfig {
  /** Port to listen on (0 = random available port) */
  port: number;
  /** Host to bind to (default: 127.0.0.1) */
  host: string;
}

/**
 * Authentication token metadata
 */
export interface TokenMetadata {
  /** The token string */
  token: string;
  /** When the token was created */
  createdAt: number;
  /** Optional identifier for debugging */
  identifier?: string;
}

/**
 * Request query parameters for GET /api/notifications
 */
export interface GetNotificationsQuery {
  /** Filter by status */
  status?: 'unread' | 'read' | 'dismissed';
  /** Limit number of results */
  limit?: number;
}

/**
 * Request body for PATCH /api/notifications/:id
 */
export interface UpdateNotificationBody {
  /** New status for the notification */
  status: 'read' | 'dismissed';
}

/**
 * Response for GET /api/notifications
 */
export interface GetNotificationsResponse {
  notifications: Notification[];
  count: number;
}

/**
 * Response for PATCH /api/notifications/:id
 */
export interface UpdateNotificationResponse {
  success: boolean;
  notification: Notification | null;
}

/**
 * Response for GET /api/notifications/count
 */
export interface NotificationCountResponse {
  /** Total number of undismissed notifications */
  total: number;
  /** Number of unread notifications */
  unread: number;
  /** Number of read (but not dismissed) notifications */
  read: number;
}

/**
 * Error response format
 */
export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'ok';
  uptime: number;
  timestamp: number;
}

/**
 * Proxy request metadata
 */
export interface ProxyRequest {
  /** HTTP method */
  method: string;
  /** API path (without /proxy-api/ prefix) */
  path: string;
  /** Request body */
  body?: any;
  /** Query parameters */
  query?: Record<string, any>;
}

/**
 * Proxy response (generic, forwards Academia.edu API responses)
 */
export type ProxyResponse = any;

/**
 * Response for GET /word/:pid/project_file
 */
export interface WordProjectFileResponse {
  /** Project ID */
  project_id: number;
  /** Project file ID */
  project_file_id: number;
}

/**
 * Poll response for the floating overlay (button + popup) over any registered
 * host app — Word, Obsidian, etc. Was historically named `WordPollResponse`;
 * the legacy name is kept as a type alias at the bottom of the interface for
 * back-compat. Prefer `OverlayPollResponse` in new code.
 */
export interface OverlayPollResponse {
  /** Whether this is an "Enable feedback" button (document exists but no project) */
  isEnableFeedback?: boolean;
  /** Whether the document is unsaved (no file path from accessibility API) */
  isUnsavedDocument?: boolean;
  /** Project ID (if valid manuscript) */
  projectId?: number;
  /** Project File ID (if valid manuscript) */
  projectFileId?: number;
  /** Notification count */
  notificationCount?: number;
  /** Whether this PID is the active/focused one */
  isActive: boolean;
  /** Up to 2 most recent review notifications (any type: full, diff, selected_text) */
  recentReviewNotifications?: Array<{
    id: number;
    project_id: number;
    conversation_id: number;
    conversation_title?: string;
    created_at: number;
    title: string;
    body_html?: string;
    isRead: boolean;
    selected_text?: string;
    review_type?: 'full-paper' | 'selected-text' | 'review-changes';
    isInProgress?: boolean;
  }>;
  /** Whether a selected text review is currently in progress for this window */
  isReviewingSelectedText?: boolean;
  /** Timestamp (ms) when the selected text review was triggered */
  selectedTextReviewStartedAt?: number;
  /** Type of review in progress */
  reviewType?: 'full-paper' | 'selected-text' | 'review-changes';
  /** The selected text being reviewed (if available) */
  selectedText?: string;
  /** Error message from a failed review attempt */
  reviewErrorMessage?: string;
  /** Active document path (if available) */
  activeDocumentPath?: string | null;
  /**
   * Human-readable name for the active document. For file-based hosts the
   * renderer can derive this from `activeDocumentPath` (basename), but for
   * synthetic-scheme hosts (e.g. `gdocs://<id>`) the path is opaque, so the
   * server supplies the actual title (Google Doc title, Apple Note name, ...).
   * When set, the renderer should prefer this over deriving from the path.
   */
  activeDocumentDisplayName?: string | null;
  /** Whether button-v2 webview is visible (from webview manager desired state) */
  shouldShowButtonV2?: boolean;
  /** Whether popup-v2 webview is visible (from webview manager desired state) */
  shouldShowPopupV2?: boolean;
  /** Whether review-button webview is visible (from webview manager desired state) */
  shouldShowReviewButton?: boolean;
  /** Whether the overlay is in input mode (awaiting user prompt before review) */
  isAwaitingReviewInput?: boolean;
  /** Whether the window has selected text (regardless of bounds availability) */
  hasSelectedText?: boolean;
  /** Review state for the project file, derived from events polling */
  projectReviewState?: 'idle' | 'reviewing' | 'completed' | 'failed';
  /** Whether the overlay is currently rendered in the docked position (false when Word is maximized and panel fell back to floating) */
  isDockedActive?: boolean;
  /** Whether the open document is within the cobuilding workspace directory */
  isInWorkspace?: boolean;
  /** Cobuilding workspace sessions (included when isInWorkspace is true) */
  workspaceSessions?: Array<{
    id: string;
    title: string;
    created_at: string;
  }>;
  /**
   * Pending kickoff prompt for the active document, set by surfaces like the
   * Writing-Agent flow. Consumed exactly once per pollData arrival.
   */
  pendingKickoffPrompt?: string;
  /**
   * Unique id for the current kickoff. Popup dedups by this id rather than by
   * prompt text, so repeat clicks (or identical prompts from different
   * surfaces) each force a fresh chat.
   */
  pendingKickoffId?: string;
  /** FullStory configuration for popup initialization (avoids extra HTTP calls) */
  fullStoryConfig?: {
    userId: number | null;
    email: string;
    displayName: string;
    deviceId: string;
    appVersion: string;
    isPackaged: boolean;
    forceFullStoryRecording: boolean;
  };
}

/** Back-compat alias — prefer `OverlayPollResponse`. */
export type WordPollResponse = OverlayPollResponse;

/**
 * Request body for POST /api/navigate
 */
export interface NavigateRequestBody {
  /** Target page */
  page: 'conversation' | 'conversations' | 'external' | 'session';
  /** Project ID (required for 'conversation' and 'conversations' pages) */
  projectId?: number;
  /** Conversation ID (required for 'conversation' page) */
  conversationId?: number;
  /** Session ID (required for 'session' page — cobuilding workspace session) */
  sessionId?: string;
  /** Whether to auto-open the diff modal */
  openDiffModal?: boolean;
  /** URL to open (required for 'external' page) */
  url?: string;
}
