// Shared types and constants for IPC communication

export const IPC_CHANNELS = {
  // Authentication
  CHECK_LOGIN: 'check-login',
  LOGIN: 'login',
  LOGOUT: 'logout',
  GET_CURRENT_USER: 'get-current-user',

  // QR Code Authentication
  START_QR_AUTH: 'start-qr-auth',
  VERIFY_QR_CODE: 'verify-qr-code',
  LOGIN_WITH_QR_TOKEN: 'login-with-qr-token',

  // API operations
  API_CALL: 'api-call',

  // File operations
  SELECT_FOLDER: 'select-folder',
  UPLOAD_FILES: 'upload-files',
  SEARCH_FILES: 'search-files',
  GET_FOLDER_FILES: 'get-folder-files',
  SCAN_FOLDER_FOR_FILES: 'scan-folder-for-files',

  // Notifications
  GET_NOTIFICATIONS: 'get-notifications',
  UPDATE_NOTIFICATION: 'update-notification',
  START_NOTIFICATION_POLLING: 'start-notification-polling',
  STOP_NOTIFICATION_POLLING: 'stop-notification-polling',
  MARK_NOTIFICATION_READ: 'mark-notification-read',
  DISMISS_NOTIFICATION: 'dismiss-notification',
  NEW_NOTIFICATION: 'new-notification',
  NOTIFICATION_UPDATED: 'notification-updated',

  // Screen and Word operations
  GET_SCREEN_SOURCES: 'get-screen-sources',
  GET_ALL_SOURCES: 'get-all-sources',
  GET_WORD_CONTENT: 'get-word-content',
  TEST_WORD_API: 'test-word-api',
  CHECK_WORD_FRONTMOST: 'check-word-frontmost',
  GET_WORD_SCROLL_POSITION: 'get-word-scroll-position',
  GET_WORD_TEXT: 'get-word-text',
  PROCESS_SCREEN_OCR: 'process-screen-ocr',
  PROCESS_WORD_WINDOW: 'process-word-window',

  // Sync operations
  GET_SYNC_FOLDERS: 'get-sync-folders',
  ADD_SYNC_FOLDER: 'add-sync-folder',
  REMOVE_SYNC_FOLDER: 'remove-sync-folder',
  SYNC_FOLDER_NOW: 'sync-folder-now',
  FILE_UPLOADED: 'file-uploaded',
  FILE_SYNCED: 'file-synced',
  FOLDER_SYNC_STATUS: 'folder-sync-status',
  INITIAL_SYNC_STATUS: 'initial-sync-status',
  INITIAL_SYNC_PROGRESS: 'initial-sync-progress',

  // Project sync operations
  START_PROJECT_FOLDER_SYNC: 'start-project-folder-sync',
  STOP_PROJECT_FOLDER_SYNC: 'stop-project-folder-sync',
  STOP_PROJECT_SYNC: 'stop-project-sync',
  PROJECT_SYNC_STATUS: 'project-sync-status',
  PROJECT_SYNC_PROGRESS: 'project-sync-progress',
  PROJECT_FILE_SYNCED: 'project-file-synced',

  // Selection tracking
  START_SELECTION_TRACKING: 'start-selection-tracking',
  STOP_SELECTION_TRACKING: 'stop-selection-tracking',
  SELECTION_BUTTON_CLICKED: 'selection-button-clicked',
  SELECTION_UPDATED: 'selection-updated',
  BUTTON_ACTION: 'button-action',

  // Window and UI
  CHANGE_TRAY_ICON: 'change-tray-icon',
  MINIMIZE_WINDOW: 'minimize-window',
  CLOSE_WINDOW: 'close-window',
  GET_POSITION_DEBUG_INFO: 'get-position-debug-info',
  GET_ALL_NOTIFICATIONS: 'get-all-notifications',
  OPEN_EXTERNAL_URL: 'open-external-url',
} as const;

// Feature flags
export const FEATURES = {
  CONVERSATIONS_ENABLED: true, // Toggle between old Projects UI and new Conversations UI
  MS_WORD_INTEGRATION_ENABLED: false, // Toggle MS Word integration
} as const;

export interface DesktopNotification {
  id: number;
  title: string;
  body_html: string;
  user_id: number;
  file_id: number;
  project_id: number;
  project_file_id: number;
  status: 'unread' | 'read' | 'dismissed';
  read_at: number | null;
  dismissed_at: number | null;
  delivered_at?: number | null;
}

export interface GetNotificationsResponse {
  notifications: DesktopNotification[];
}
