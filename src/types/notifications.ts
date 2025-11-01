/**
 * Shared notification type definitions for the Academia desktop app.
 * These types represent notifications from the database-backed API (WAGENT-87).
 */

/**
 * Notification from the backend API.
 * Replaces the old DesktopNotification type.
 */
export interface Notification {
  /** Unique identifier for the notification (primary key) */
  id: number;

  /** Title of the notification */
  title: string;

  /** HTML content of the notification body */
  body_html: string;

  /** ID of the user this notification belongs to */
  user_id: number;

  /** ID of the file associated with this notification */
  file_id: number;

  /** ID of the project associated with this notification */
  project_id: number;

  /** ID of the project file associated with this notification */
  project_file_id: number;

  /** Current status of the notification */
  status: 'unread' | 'read' | 'dismissed';

  /** Timestamp when the notification was read (null if unread) */
  read_at: number | null;

  /** Timestamp when the notification was dismissed (null if not dismissed) */
  dismissed_at: number | null;

  /** Timestamp when the notification was created */
  created_at: number;
}

/**
 * Response format for the getNotifications API endpoint
 */
export interface GetNotificationsResponse {
  notifications: Notification[];
}
