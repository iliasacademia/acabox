/**
 * Notifications API Client
 *
 * Provides a clean interface for React components to fetch notification data
 * from the HTTP server instead of using MessageBridge.
 *
 * Benefits over MessageBridge:
 * - Standard fetch() API familiar to web developers
 * - Better DevTools support (Network tab)
 * - Easier mocking for tests (can use MSW, fetch-mock, etc.)
 * - Works with standard React data fetching libraries (react-query, SWR)
 */

import { Notification } from '../../types/notifications';

/**
 * API client configuration
 */
interface ApiConfig {
  baseUrl: string;
}

let apiConfig: ApiConfig | null = null;

/**
 * Initialize the API client with server info
 * Must be called before making any API requests
 *
 * @param baseUrl Base URL of the HTTP server (e.g., http://127.0.0.1:23111)
 */
export function initializeNotificationsApi(baseUrl: string): void {
  apiConfig = { baseUrl };
  console.log(`[Notifications API] Initialized with baseUrl: ${baseUrl}`);
}

/**
 * Check if API client is initialized
 */
export function isApiInitialized(): boolean {
  return apiConfig !== null;
}

/**
 * Get current API configuration
 * Throws if not initialized
 */
function getConfig(): ApiConfig {
  if (!apiConfig) {
    throw new Error('Notifications API not initialized. Call initializeNotificationsApi() first.');
  }
  return apiConfig;
}

/**
 * Make a fetch request to the API
 *
 * @param endpoint API endpoint (e.g., /api/notifications)
 * @param options Fetch options
 * @returns Response data
 */
async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const config = getConfig();

  const url = `${config.baseUrl}${endpoint}`;

  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.message || `HTTP ${response.status}: ${response.statusText}`
    );
  }

  return response.json();
}

/**
 * Fetch notifications from the server
 *
 * @param options Query options
 * @returns List of notifications
 */
export async function fetchNotifications(options?: {
  status?: 'unread' | 'read' | 'dismissed';
  limit?: number;
}): Promise<Notification[]> {
  const params = new URLSearchParams();

  if (options?.status) {
    params.set('status', options.status);
  }

  if (options?.limit) {
    params.set('limit', options.limit.toString());
  }

  const query = params.toString();
  const endpoint = `/api/notifications${query ? `?${query}` : ''}`;

  console.log(`[Notifications API] Fetching notifications: ${endpoint}`);

  const response = await apiFetch<{
    notifications: Notification[];
    count: number;
  }>(endpoint);

  console.log(`[Notifications API] Received ${response.count} notifications`);

  return response.notifications;
}

/**
 * Fetch unread notifications
 * Convenience method for fetchNotifications({ status: 'unread' })
 */
export async function fetchUnreadNotifications(): Promise<Notification[]> {
  return fetchNotifications({ status: 'unread' });
}

/**
 * Mark a notification as read
 *
 * @param notificationId Notification ID to mark as read
 * @returns Updated notification
 */
export async function markNotificationAsRead(
  notificationId: number
): Promise<Notification | null> {
  console.log(`[Notifications API] Marking notification ${notificationId} as read`);

  const response = await apiFetch<{
    success: boolean;
    notification: Notification | null;
  }>(`/api/notifications/${notificationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'read' }),
  });

  if (!response.success) {
    throw new Error('Failed to mark notification as read');
  }

  console.log(`[Notifications API] Notification ${notificationId} marked as read`);

  return response.notification;
}

/**
 * Dismiss a notification
 *
 * @param notificationId Notification ID to dismiss
 * @returns Updated notification
 */
export async function dismissNotification(
  notificationId: number
): Promise<Notification | null> {
  console.log(`[Notifications API] Dismissing notification ${notificationId}`);

  const response = await apiFetch<{
    success: boolean;
    notification: Notification | null;
  }>(`/api/notifications/${notificationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'dismissed' }),
  });

  if (!response.success) {
    throw new Error('Failed to dismiss notification');
  }

  console.log(`[Notifications API] Notification ${notificationId} dismissed`);

  return response.notification;
}

/**
 * Health check endpoint
 * Useful for testing connectivity
 *
 * @returns Health status
 */
export async function healthCheck(): Promise<{
  status: string;
  uptime: number;
  timestamp: number;
}> {
  const config = getConfig();
  const url = `${config.baseUrl}/api/health`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Reset the API client configuration
 * Useful for testing or when server restarts
 */
export function resetNotificationsApi(): void {
  apiConfig = null;
  console.log('[Notifications API] Reset');
}
