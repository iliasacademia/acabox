// Shared types and constants for IPC communication

export const IPC_CHANNELS = {
  // Authentication
  CHECK_LOGIN: "check-login",
  LOGIN: "login",
  LOGOUT: "logout",
  GET_CURRENT_USER: "get-current-user",

  // QR Code Authentication
  START_QR_AUTH: "start-qr-auth",
  VERIFY_QR_CODE: "verify-qr-code",
  LOGIN_WITH_QR_TOKEN: "login-with-qr-token",

  // API operations
  API_CALL: "api-call",
  DEVTOOLS_LOG: "devtools-log",

  // System
  GET_DEVICE_ID: "get-device-id",
  GET_APP_INFO: "get-app-info",

  // File operations
  SELECT_FOLDER: "select-folder",
  SELECT_FILE: "select-file",
  UPLOAD_FILES: "upload-files",
  UPLOAD_SUPPORTING_MATERIAL: "upload-supporting-material",
  CREATE_CONVERSATION_WITH_FILE: "create-conversation-with-file",
  SEND_MESSAGE_WITH_FILE: "send-message-with-file",
  SEARCH_FILES: "search-files",
  GET_FOLDER_FILES: "get-folder-files",
  SCAN_FOLDER_FOR_FILES: "scan-folder-for-files",
  OPEN_FILE: "open-file",
  SHOW_FILE_IN_FOLDER: "show-file-in-folder",
  CHECK_FILE_EXISTS: "check-file-exists",

  // Notifications
  GET_NOTIFICATIONS: "get-notifications",
  UPDATE_NOTIFICATION: "update-notification",
  START_NOTIFICATION_POLLING: "start-notification-polling",
  STOP_NOTIFICATION_POLLING: "stop-notification-polling",
  MARK_NOTIFICATION_READ: "mark-notification-read",
  DISMISS_NOTIFICATION: "dismiss-notification",
  CLEAR_NOTIFICATIONS_FOR_PROJECT: "clear-notifications-for-project",
  NEW_NOTIFICATION: "new-notification",
  NOTIFICATION_UPDATED: "notification-updated",

  // Events polling
  START_EVENTS_POLLING: "start-events-polling",
  STOP_EVENTS_POLLING: "stop-events-polling",
  CO_SCIENTIST_EVENT: "co-scientist-event",

  // Screen and Word operations
  GET_SCREEN_SOURCES: "get-screen-sources",
  GET_ALL_SOURCES: "get-all-sources",
  GET_WORD_CONTENT: "get-word-content",
  TEST_WORD_API: "test-word-api",
  CHECK_WORD_FRONTMOST: "check-word-frontmost",
  GET_WORD_SCROLL_POSITION: "get-word-scroll-position",
  GET_WORD_TEXT: "get-word-text",
  PROCESS_SCREEN_OCR: "process-screen-ocr",
  PROCESS_WORD_WINDOW: "process-word-window",
  REFRESH_MANUSCRIPT_PATHS: "refresh-manuscript-paths",
  SCHEDULE_POPUP_AUTO_OPEN: "schedule-popup-auto-open",
  REVIEW_PRE_CHECK: "review-pre-check",
  WORD_SAVE_DOCUMENT: "word-save-document",
  GET_ALWAYS_SAVE_BEFORE_REVIEW: "get-always-save-before-review",
  SET_ALWAYS_SAVE_BEFORE_REVIEW: "set-always-save-before-review",

  // Sync operations
  REINITIALIZE_SYNC: "reinitialize-sync",
  GET_SYNC_FOLDERS: "get-sync-folders",
  ADD_SYNC_FOLDER: "add-sync-folder",
  REMOVE_SYNC_FOLDER: "remove-sync-folder",
  SYNC_FOLDER_NOW: "sync-folder-now",
  FILE_UPLOADED: "file-uploaded",
  FILE_SYNCED: "file-synced",
  FOLDER_SYNC_STATUS: "folder-sync-status",
  INITIAL_SYNC_STATUS: "initial-sync-status",
  INITIAL_SYNC_PROGRESS: "initial-sync-progress",

  // Startup sync operations
  STARTUP_SYNC_BEGIN: "startup-sync-begin",
  STARTUP_SYNC_PROGRESS: "startup-sync-progress",
  STARTUP_SYNC_COMPLETE: "startup-sync-complete",
  SYNC_PROGRESS: "sync-progress",
  SYNC_COMPLETE: "sync-complete",
  FILE_SYNC_ERROR: "file-sync-error",

  // Project sync operations
  START_PROJECT_FOLDER_FILE_SYNC: "start-project-folder-file-sync",
  START_PROJECT_FOLDER_SYNC: "start-project-folder-sync",
  STOP_PROJECT_FOLDER_SYNC: "stop-project-folder-sync",
  STOP_PROJECT_SYNC: "stop-project-sync",
  UPDATE_PROJECT_MANUSCRIPT_PATH: "update-project-manuscript-path",
  PROJECT_SYNC_STATUS: "project-sync-status",
  PROJECT_SYNC_PROGRESS: "project-sync-progress",
  PROJECT_FILE_SYNCED: "project-file-synced",
  PROJECT_STARTUP_SYNC_BEGIN: "project-startup-sync-begin",
  PROJECT_STARTUP_SYNC_PROGRESS: "project-startup-sync-progress",
  PROJECT_STARTUP_SYNC_COMPLETE: "project-startup-sync-complete",
  START_PROJECT_FILE_SYNC: "start-project-file-sync",
  SYNC_PROJECT_FILE_ONCE: "sync-project-file-once",
  GET_PROJECT_WATCHER_STATUS: "get-project-watcher-status",
  PROJECT_WATCHER_STATUS_CHANGED: "project-watcher-status-changed",

  // Selection tracking
  START_SELECTION_TRACKING: "start-selection-tracking",
  STOP_SELECTION_TRACKING: "stop-selection-tracking",
  SELECTION_BUTTON_CLICKED: "selection-button-clicked",
  SELECTION_UPDATED: "selection-updated",
  BUTTON_ACTION: "button-action",

  // Window and UI
  MINIMIZE_WINDOW: "minimize-window",
  CLOSE_WINDOW: "close-window",
  GET_POSITION_DEBUG_INFO: "get-position-debug-info",
  GET_ALL_NOTIFICATIONS: "get-all-notifications",
  OPEN_EXTERNAL_URL: "open-external-url",

  // Podman sandbox
  PODMAN_OPEN_SANDBOX: "podman-open-sandbox",
  PODMAN_OPEN_PREVIEW: "podman-open-preview",
  PODMAN_OPEN_FOLDER: "podman-open-folder",
  PODMAN_GET_STATUS: "podman-get-status",
  PODMAN_STOP: "podman-stop",
  PODMAN_UNINSTALL: "podman-uninstall",
  PODMAN_GET_SKIP_CHECKSUM: "podman-get-skip-checksum",
  PODMAN_SET_SKIP_CHECKSUM: "podman-set-skip-checksum",
  PODMAN_GET_TRUSTED_DOMAINS: "podman-get-trusted-domains",
  PODMAN_SET_TRUSTED_DOMAINS: "podman-set-trusted-domains",
  PODMAN_UPDATE_FIREWALL: "podman-update-firewall",
  PODMAN_GET_ALLOW_ALL_TRAFFIC: "podman-get-allow-all-traffic",
  PODMAN_SET_ALLOW_ALL_TRAFFIC: "podman-set-allow-all-traffic",

  // Navigation
  NAVIGATE_TO_PAGE: "navigate-to-page",

  // Auto-update
  UPDATE_AVAILABLE: "update-available",
  UPDATE_DOWNLOAD_PROGRESS: "update-download-progress",
  UPDATE_DOWNLOADED: "update-downloaded",
  UPDATE_ERROR: "update-error",
  DOWNLOAD_UPDATE: "download-update",

  // Permissions
  CHECK_ACCESSIBILITY_PERMISSION: "check-accessibility-permission",
  REQUEST_ACCESSIBILITY_PERMISSION: "request-accessibility-permission",
  RESET_ACCESSIBILITY_PERMISSION: "reset-accessibility-permission",
  ACCESSIBILITY_PERMISSION_STATUS: "accessibility-permission-status",

  // App lifecycle
  RESTART_APP: "restart-app",

  // Debug
  DEBUG_GET_ACTIVE_WATCHERS: "debug-get-active-watchers",
  DEV_CLEANUP_NATIVE: "dev-cleanup-native",

  // App info
  GET_APP_VERSION: "get-app-version",
  GET_HTTP_SERVER_INFO: "get-http-server-info",

  // Deep link / URI handler callbacks
  DEEP_LINK_CALLBACK: "deep-link-callback",

  // Feature flags
  GET_ALL_APPS_MONITOR_ENABLED: "get-all-apps-monitor-enabled",
  SET_ALL_APPS_MONITOR_ENABLED: "set-all-apps-monitor-enabled",
  INTEGRATION_GET_ENABLED: "integration:get-enabled",
  INTEGRATION_SET_ENABLED: "integration:set-enabled",

  // Zotero local client (per-reference "Add to Zotero" button)
  ZOTERO_LOCAL_GET_STATUS: "zotero-local-get-status",
  ZOTERO_LOCAL_ADD_DOI: "zotero-local-add-doi",
  ZOTERO_LOCAL_GET_DOI_METADATA: "zotero-local-get-doi-metadata",
  ZOTERO_LOCAL_LIST_ADDED_DOIS: "zotero-local-list-added-dois",
  ZOTERO_LOCAL_CHECK_DOI: "zotero-local-check-doi",
  ZOTERO_OPEN_DOI: "zotero-open-doi",

  // Local Agent
  LOCAL_AGENT_GET_API_KEY: "local-agent-get-api-key",
  LOCAL_AGENT_SET_API_KEY: "local-agent-set-api-key",
  LOCAL_AGENT_GET_MODEL: "local-agent-get-model",
  LOCAL_AGENT_SET_MODEL: "local-agent-set-model",
  LOCAL_AGENT_CREATE_CONVERSATION: "local-agent-create-conversation",
  LOCAL_AGENT_SEND_MESSAGE: "local-agent-send-message",
  LOCAL_AGENT_LIST_CONVERSATIONS: "local-agent-list-conversations",
  LOCAL_AGENT_GET_CONVERSATION: "local-agent-get-conversation",
  LOCAL_AGENT_ARCHIVE_CONVERSATION: "local-agent-archive-conversation",
  LOCAL_AGENT_UNARCHIVE_CONVERSATION: "local-agent-unarchive-conversation",
  LOCAL_AGENT_STOP: "local-agent-stop",
  LOCAL_AGENT_STREAM_UPDATE: "local-agent-stream-update",
} as const;

// Type for valid IPC channel values - enforces compile-time validation
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// Feature flags
export const FEATURES: {
  MS_WORD_INTEGRATION_ENABLED: boolean;
  MS_WORD_V2_ENABLED: boolean;
  OBSIDIAN_INTEGRATION_ENABLED: boolean;
  ONBOARDING_V2_ENABLED: boolean;
  ONBOARDING_V3_ENABLED: boolean;
  SESSION_CAPTURE_ENABLED: boolean;
  SELECTION_REVIEW_V2_ENABLED: boolean;
} = {
  MS_WORD_INTEGRATION_ENABLED: true, // Build-time gate; runtime enable lives in user settings
  MS_WORD_V2_ENABLED: true, // V2: new implementation
  OBSIDIAN_INTEGRATION_ENABLED: false, // Build-time default; runtime enable lives in user settings (Settings → Obsidian Integration)
  ONBOARDING_V2_ENABLED: true, // V2 onboarding: single-file picker flow
  ONBOARDING_V3_ENABLED: true, // V3 onboarding: guided setup flow with steps
  SESSION_CAPTURE_ENABLED: true, // Toggle local activity session tracking
  SELECTION_REVIEW_V2_ENABLED: true, // V2: file-based selection review (backend reads document from S3)
};

export interface DesktopNotification {
  id: number;
  title: string;
  body_html: string;
  user_id: number;
  file_id: number;
  project_id: number;
  project_file_id: number;
  status: "unread" | "read" | "dismissed";
  read_at: number | null;
  dismissed_at: number | null;
  delivered_at?: number | null;
}

export interface GetNotificationsResponse {
  notifications: DesktopNotification[];
}

// Navigation payload for navigate-to-page IPC
export interface NavigateToPagePayload {
  page: "conversation" | "conversations" | "external" | "session"; // Extensible: 'project' | 'settings' | etc.
  projectId?: number; // Required for 'conversation' and 'conversations' pages
  conversationId?: number; // Required for 'conversation' page
  sessionId?: string; // Required for 'session' page (cobuilding workspace session)
  openDiffModal?: boolean; // Auto-open diff modal when navigating to conversation
  url?: string; // Required for 'external' page
}

// DevTools logging types
export type DevToolsLogCategory = "api" | "general";
export type DevToolsLogLevel = "info" | "warn" | "error" | "debug";

export interface GeneralLogData {
  message: any[];
}

export interface ApiLogData {
  type: "request" | "response" | "error";
  method: string;
  endpoint: string;
  status?: number;
  statusText?: string;
  url?: string;
  message?: string;
  requestData?: any;
}

export interface DevToolsLogPayload {
  timestamp: string;
  category: DevToolsLogCategory;
  level: DevToolsLogLevel;
  data: GeneralLogData | ApiLogData;
}
