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
 * Response for GET /word/:pid/poll
 */
export interface WordPollResponse {
  /** Whether the button should be shown */
  shouldShow: boolean;
  /** Project ID (if valid manuscript) */
  projectId?: number;
  /** Project File ID (if valid manuscript) */
  projectFileId?: number;
  /** Notification count */
  notificationCount?: number;
  /** Whether this PID is the active/focused one */
  isActive: boolean;
  /** Latest review notification (if any) */
  latestReviewNotification?: {
    id: number;
    project_id: number;
    conversation_id: number;
  } | null;
  /** Active document path (if available) */
  activeDocumentPath?: string | null;
}
