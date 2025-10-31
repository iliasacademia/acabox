// Shared types and constants for IPC communication

export const IPC_CHANNELS = {
  // Authentication
  CHECK_LOGIN: 'check-login',
  LOGIN: 'login',
  LOGOUT: 'logout',
  GET_CURRENT_USER: 'get-current-user',

  // File operations
  SELECT_FOLDER: 'select-folder',
  UPLOAD_FILES: 'upload-files',
  SEARCH_FILES: 'search-files',
  GET_FOLDER_FILES: 'get-folder-files',

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
}

export interface GetNotificationsResponse {
  notifications: DesktopNotification[];
}
