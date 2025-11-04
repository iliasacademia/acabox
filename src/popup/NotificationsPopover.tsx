import React, { useState, useEffect } from 'react';
import { Notification } from '../types/notifications';
import {
  initializeNotificationsApi,
  fetchNotifications,
  markNotificationAsRead,
  dismissNotification,
} from './api/notifications';

interface NotificationsPopoverProps {
  onClose?: () => void;
}

const NotificationsPopover: React.FC<NotificationsPopoverProps> = ({ onClose }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Initialize API client and fetch notifications
    const initializeAndFetch = async () => {
      try {
        console.log('[NotificationsPopover] Initializing HTTP API client...');

        // Get HTTP server info from main process
        const serverInfo = await (window as any).electron.invoke('get-http-server-info');

        if (!serverInfo.running) {
          throw new Error('HTTP server not running');
        }

        console.log('[NotificationsPopover] HTTP server running at:', serverInfo.baseUrl);

        // Generate authentication token
        const { token } = await (window as any).electron.invoke('generate-http-token', 'NotificationsPopover');

        console.log('[NotificationsPopover] Generated auth token:', token.substring(0, 16) + '...');

        // Initialize API client
        initializeNotificationsApi(serverInfo.baseUrl, token);

        console.log('[NotificationsPopover] API client initialized, fetching notifications...');

        // Fetch notifications (unread + read, but not dismissed)
        const fetchedNotifications = await fetchNotifications();

        console.log('[NotificationsPopover] Fetched', fetchedNotifications.length, 'notifications');

        setNotifications(fetchedNotifications);
        setLoading(false);
      } catch (err: any) {
        console.error('[NotificationsPopover] Error initializing or fetching:', err);
        setError(err.message || 'Failed to load notifications');
        setLoading(false);

        // Fallback to mock data for development/testing
        console.log('[NotificationsPopover] Falling back to mock data');
        const mockNotifications: Notification[] = [
      {
        id: 1,
        title: 'Overall review | Wed, 29 Oct',
        body_html: 'Review your document',
        user_id: 1,
        file_id: 1,
        project_id: 1,
        project_file_id: 1,
        status: 'unread',
        read_at: null,
        dismissed_at: null,
        created_at: Date.now(),
      },
      {
        id: 2,
        title: 'Citation suggestion',
        body_html: 'Introduction > Paragraph 1',
        user_id: 1,
        file_id: 1,
        project_id: 1,
        project_file_id: 1,
        status: 'unread',
        read_at: null,
        dismissed_at: null,
        created_at: Date.now(),
      },
      {
        id: 3,
        title: 'Argument strength',
        body_html: 'Introduction > Paragraph 1',
        user_id: 1,
        file_id: 1,
        project_id: 1,
        project_file_id: 1,
        status: 'unread',
        read_at: null,
        dismissed_at: null,
        created_at: Date.now(),
      },
      {
        id: 4,
        title: 'Citation suggestion',
        body_html: 'Introduction > Paragraph 1',
        user_id: 1,
        file_id: 1,
        project_id: 1,
        project_file_id: 1,
        status: 'read',
        read_at: Date.now() - 86400000, // Yesterday
        dismissed_at: null,
        created_at: Date.now() - 86400000,
      },
    ];

        setNotifications(mockNotifications);
        setLoading(false);
      }
    };

    initializeAndFetch();
  }, []);

  const formatTimestamp = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const dayInMs = 86400000;

    if (diff < dayInMs) {
      return 'Today';
    } else if (diff < dayInMs * 2) {
      return 'Yesterday';
    } else {
      const date = new Date(timestamp);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const handleNotificationClick = async (notification: Notification) => {
    console.log('[NotificationsPopover] Notification clicked:', notification.id);

    try {
      // Mark as read if currently unread
      if (notification.status === 'unread') {
        console.log('[NotificationsPopover] Marking notification', notification.id, 'as read');

        await markNotificationAsRead(notification.id);

        // Update local state to reflect the change
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notification.id
              ? { ...n, status: 'read' as const, read_at: Date.now() }
              : n
          )
        );

        console.log('[NotificationsPopover] Notification marked as read successfully');
      }

      // TODO: Navigate to notification content (e.g., open document location)
    } catch (err: any) {
      console.error('[NotificationsPopover] Error marking notification as read:', err);
      setError(`Failed to mark notification as read: ${err.message}`);
    }
  };

  const handleDismiss = async (notificationId: number, event: React.MouseEvent) => {
    // Prevent triggering the parent onClick
    event.stopPropagation();

    console.log('[NotificationsPopover] Dismissing notification:', notificationId);

    try {
      await dismissNotification(notificationId);

      // Remove from local state
      setNotifications((prev) => prev.filter((n) => n.id !== notificationId));

      console.log('[NotificationsPopover] Notification dismissed successfully');
    } catch (err: any) {
      console.error('[NotificationsPopover] Error dismissing notification:', err);
      setError(`Failed to dismiss notification: ${err.message}`);
    }
  };

  const handleSeeMore = () => {
    console.log('[NotificationsPopover] See previous notifications clicked');
    // TODO: Show all notifications including dismissed, or open full view
  };

  return (
    <div style={styles.container}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>Notifications</h1>
          {onClose && (
            <button
              style={styles.closeButton}
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div style={styles.errorBanner}>
            <span style={styles.errorText}>{error}</span>
            <button
              style={styles.errorDismiss}
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {/* Notifications List */}
        <div style={styles.notificationsList}>
          {loading ? (
            <div style={styles.loadingContainer}>
              <p style={styles.loadingText}>Loading notifications...</p>
            </div>
          ) : notifications.length === 0 ? (
            <div style={styles.emptyContainer}>
              <p style={styles.emptyText}>No notifications</p>
            </div>
          ) : (
            notifications.map((notification) => (
              <div
                key={notification.id}
                style={styles.notificationItem}
                className="notification-item"
                onClick={() => handleNotificationClick(notification)}
              >
                {/* Blue dot indicator for unread */}
                <div style={styles.notificationContent}>
                  {notification.status === 'unread' && (
                    <div style={styles.unreadDot} />
                  )}
                  <div style={styles.notificationText}>
                    <div style={styles.notificationTitle}>{notification.title}</div>
                    {notification.body_html && (
                      <div
                        style={styles.notificationSubtitle}
                        dangerouslySetInnerHTML={{
                          __html: notification.body_html
                        }}
                      />
                    )}
                  </div>
                </div>
                <div style={styles.notificationActions}>
                  <div style={styles.notificationTimestamp}>
                    {formatTimestamp(notification.created_at)}
                  </div>
                  <button
                    style={styles.dismissButton}
                    onClick={(e) => handleDismiss(notification.id, e)}
                    aria-label="Dismiss notification"
                    title="Dismiss"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={styles.seeMoreButton}
            onClick={handleSeeMore}
          >
            See previous notifications
          </button>
        </div>
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  modal: {
    width: '700px',
    maxHeight: '600px',
    backgroundColor: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '24px 32px',
    borderBottom: '1px solid #f0f0f0',
  },
  title: {
    fontSize: '28px',
    fontWeight: 600,
    color: '#000000',
    margin: 0,
  },
  closeButton: {
    width: '32px',
    height: '32px',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: '32px',
    fontWeight: 300,
    color: '#666666',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    transition: 'background-color 0.2s ease',
    padding: 0,
    lineHeight: 1,
  },
  notificationsList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 0',
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 32px',
  },
  loadingText: {
    fontSize: '16px',
    color: '#666666',
  },
  emptyContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 32px',
  },
  emptyText: {
    fontSize: '16px',
    color: '#666666',
  },
  notificationItem: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '20px 32px',
    borderBottom: '1px solid #f0f0f0',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  },
  notificationContent: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '16px',
    flex: 1,
  },
  unreadDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: '#007AFF',
    flexShrink: 0,
    marginTop: '6px',
  },
  notificationText: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  notificationTitle: {
    fontSize: '17px',
    fontWeight: 600,
    color: '#000000',
    lineHeight: 1.4,
  },
  notificationSubtitle: {
    fontSize: '15px',
    fontWeight: 400,
    color: '#666666',
    lineHeight: 1.4,
  },
  notificationActions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '8px',
    flexShrink: 0,
    marginLeft: '16px',
  },
  notificationTimestamp: {
    fontSize: '15px',
    fontWeight: 400,
    color: '#666666',
  },
  dismissButton: {
    width: '24px',
    height: '24px',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: '24px',
    fontWeight: 300,
    color: '#999999',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    transition: 'background-color 0.2s ease, color 0.2s ease',
    padding: 0,
    lineHeight: 1,
  },
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 32px',
    backgroundColor: '#ffebee',
    borderBottom: '1px solid #ffcdd2',
  },
  errorText: {
    fontSize: '14px',
    color: '#c62828',
    flex: 1,
  },
  errorDismiss: {
    width: '24px',
    height: '24px',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: '24px',
    fontWeight: 300,
    color: '#c62828',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    padding: 0,
    lineHeight: 1,
  },
  footer: {
    padding: '16px 32px',
    borderTop: '1px solid #f0f0f0',
  },
  seeMoreButton: {
    width: '100%',
    padding: '14px',
    fontSize: '16px',
    fontWeight: 500,
    color: '#000000',
    backgroundColor: 'transparent',
    border: '1px solid #d0d0d0',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease, border-color 0.15s ease',
    fontFamily: 'inherit',
  },
};

// Add hover styles using CSS-in-JS workaround
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    .notification-item:hover {
      background-color: #f8f8f8 !important;
    }
    .close-button:hover {
      background-color: #f0f0f0 !important;
    }
    .see-more-button:hover {
      background-color: #f8f8f8 !important;
      border-color: #999999 !important;
    }
    button[aria-label="Dismiss notification"]:hover {
      background-color: #f0f0f0 !important;
      color: #666666 !important;
    }
    button[aria-label="Dismiss error"]:hover {
      background-color: rgba(0, 0, 0, 0.1) !important;
    }
  `;

  // Only append if not already added
  if (!document.getElementById('notifications-popover-styles')) {
    styleElement.id = 'notifications-popover-styles';
    document.head.appendChild(styleElement);
  }
}

export default NotificationsPopover;
