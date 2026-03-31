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
} as const;

// Type for valid IPC channel values - enforces compile-time validation
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// Feature flags
export const FEATURES: {
  CONVERSATIONS_ENABLED: boolean;
  MS_WORD_INTEGRATION_ENABLED: boolean;
  MS_WORD_V2_ENABLED: boolean;
  ONBOARDING_V2_ENABLED: boolean;
  ONBOARDING_V3_ENABLED: boolean;
  SESSION_CAPTURE_ENABLED: boolean;
} = {
  CONVERSATIONS_ENABLED: true, // Toggle between old Projects UI and new Conversations UI
  MS_WORD_INTEGRATION_ENABLED: true, // Toggle MS Word integration
  MS_WORD_V2_ENABLED: true, // V2: new implementation
  ONBOARDING_V2_ENABLED: true, // V2 onboarding: single-file picker flow
  ONBOARDING_V3_ENABLED: true, // V3 onboarding: guided setup flow with steps
  SESSION_CAPTURE_ENABLED: true, // Toggle local activity session tracking
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
  page: "conversation" | "conversations" | "external"; // Extensible: 'project' | 'settings' | etc.
  projectId?: number; // Required for 'conversation' and 'conversations' pages
  conversationId?: number; // Required for 'conversation' page
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
