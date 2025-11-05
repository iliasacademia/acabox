import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Notification } from '../types/notifications';
import { getBridgeInstance, useSendMessage } from './hooks/useBridge';
import {
  initializeNotificationsApi,
  fetchNotifications,
  markNotificationAsRead as apiMarkAsRead,
  dismissNotification as apiDismiss,
} from './api/notifications';

// Initialize bridge early
getBridgeInstance('notifications-popup');

console.log('[AcademiaNotificationsPopup] Initializing...');
console.log('[AcademiaNotificationsPopup] Platform:', window.__messageBridge?.getPlatform());

// Initialize API client with server base URL from window.location
// The popup is loaded from http://127.0.0.1:{port}/ui/popup/academiaNotifications/
// We need to extract the base URL
const getBaseUrl = (): string => {
  const { protocol, hostname, port } = window.location;
  return `${protocol}//${hostname}:${port}`;
};

const baseUrl = getBaseUrl();
console.log('[AcademiaNotificationsPopup] Initializing API client with base URL:', baseUrl);
initializeNotificationsApi(baseUrl);

const AcademiaNotificationsPopup: React.FC = () => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { sendRequest } = useSendMessage();

  useEffect(() => {
    // Load notifications from HTTP API
    const loadNotifications = async () => {
      try {
        console.log('[AcademiaNotificationsPopup] Loading notifications from API...');

        // Fetch notifications from the HTTP server
        const fetchedNotifications = await fetchNotifications();

        console.log(`[AcademiaNotificationsPopup] Loaded ${fetchedNotifications.length} notifications`);
        setNotifications(fetchedNotifications);
        setLoading(false);
      } catch (err: any) {
        console.error('[AcademiaNotificationsPopup] Error loading notifications:', err);
        setError(err.message || 'Failed to load notifications');
        setLoading(false);
      }
    };

    loadNotifications();
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
    console.log('[AcademiaNotificationsPopup] Notification clicked:', notification.id);

    try {
      // Mark as read if currently unread
      if (notification.status === 'unread') {
        console.log('[AcademiaNotificationsPopup] Marking notification', notification.id, 'as read');

        // Call API to mark notification as read
        const updatedNotification = await apiMarkAsRead(notification.id);

        // Update local state to reflect the change
        if (updatedNotification) {
          setNotifications((prev) =>
            prev.map((n) =>
              n.id === notification.id ? updatedNotification : n
            )
          );
        }

        console.log('[AcademiaNotificationsPopup] Notification marked as read');
      }

      // TODO: Navigate to notification content (e.g., open document location)
    } catch (err: any) {
      console.error('[AcademiaNotificationsPopup] Error marking notification as read:', err);
      setError(`Failed to mark notification as read: ${err.message}`);
    }
  };

  // Note: Individual dismiss functionality removed to match Figma design
  // Keeping function for potential future use
  // const handleDismiss = async (notificationId: number, event: React.MouseEvent) => {
  //   event.stopPropagation();
  //   console.log('[AcademiaNotificationsPopup] Dismissing notification:', notificationId);
  //   try {
  //     await apiDismiss(notificationId);
  //     setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
  //     console.log('[AcademiaNotificationsPopup] Notification dismissed');
  //   } catch (err: any) {
  //     console.error('[AcademiaNotificationsPopup] Error dismissing notification:', err);
  //     setError(`Failed to dismiss notification: ${err.message}`);
  //   }
  // };

  const handleSeeMore = () => {
    console.log('[AcademiaNotificationsPopup] See previous notifications clicked');
    // TODO: Show all notifications including dismissed, or open full view
  };

  const handleClose = async () => {
    console.log('[AcademiaNotificationsPopup] Close button clicked');

    try {
      await sendRequest('closeWindow', {});
      console.log('[AcademiaNotificationsPopup] Close window request sent');
    } catch (err) {
      console.error('[AcademiaNotificationsPopup] Close failed:', err);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>Notifications</h1>
          <button
            style={styles.closeButton}
            onClick={handleClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
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
            <div style={styles.notificationsContainer}>
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  style={styles.notificationItem}
                  className="notification-item"
                  onClick={() => handleNotificationClick(notification)}
                >
                  {/* Content: blue dot + text */}
                  <div style={styles.notificationContent}>
                    {/* Blue dot indicator for unread */}
                    {notification.status === 'unread' && (
                      <div style={styles.unreadDot} />
                    )}
                    <div style={styles.notificationText}>
                      <div style={styles.notificationTitle}>{notification.title}</div>
                      {notification.body_html && (
                        <div
                          style={styles.notificationLocation}
                          dangerouslySetInnerHTML={{
                            __html: notification.body_html
                          }}
                        />
                      )}
                    </div>
                  </div>
                  {/* Timestamp on the right */}
                  <div style={styles.notificationTimestamp}>
                    {formatTimestamp(notification.created_at)}
                  </div>
                </div>
              ))}
            </div>
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
    width: '370px',
    height: '460px',
    background: '#F9F8F6', // Figma: background-beige-light
    borderRadius: '16px',
    border: '1px solid #CCC9BC', // Figma: stroke-beige-light
    boxShadow: '0 4px 12px 0 rgba(0, 0, 0, 0.25)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '24px 24px 0 24px', // Adjusted padding
    paddingBottom: '4px', // Reduced bottom padding
    position: 'relative', // For absolute positioned close button
  },
  title: {
    fontSize: '20px', // Figma: body/lg size
    fontWeight: 400, // Figma: regular weight
    color: '#000000',
    margin: 0,
    lineHeight: '32px', // Figma: body/lg line-height
  },
  closeButton: {
    width: '20px',
    height: '20px',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: '20px',
    fontWeight: 300,
    color: '#141413', // Figma: text-primary
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    transition: 'background-color 0.2s ease',
    padding: 0,
    lineHeight: 1,
    position: 'absolute',
    top: '12px',
    right: '16px',
  },
  notificationsList: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 24px 0 24px', // Top padding only
  },
  notificationsContainer: {
    border: '1px solid #CCC9BC', // Figma: stroke-beige-light
    borderRadius: '16px', // Figma: corner-radius/radius-lg
    overflow: 'hidden',
    backgroundColor: '#ffffff', // White background for container
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 24px',
  },
  loadingText: {
    fontSize: '16px',
    color: '#535366', // Figma: text-secondary
  },
  emptyContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 24px',
  },
  emptyText: {
    fontSize: '16px',
    color: '#535366', // Figma: text-secondary
  },
  notificationItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '16px 16px 16px 12px', // Figma: 12px left, 16px right
    height: '80px', // Figma: fixed height
    backgroundColor: '#ffffff', // Figma: background-white
    borderBottom: '1px solid #DDDDE2', // Figma: stroke-grey-light
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
    boxSizing: 'border-box',
  },
  notificationContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px', // Figma: spacing/xs-12
    flex: 1,
    minWidth: 0,
  },
  unreadDot: {
    width: '12px', // Figma: 12px size
    height: '12px',
    borderRadius: '50%',
    backgroundColor: '#386AC1', // Figma: rgba(56, 106, 193, 1)
    flexShrink: 0,
  },
  notificationText: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '0', // No gap between lines
    minWidth: 0,
  },
  notificationTitle: {
    fontSize: '16px', // Figma: body/md size
    fontWeight: 600, // Figma: semibold-600
    color: '#141413', // Figma: text-primary
    lineHeight: '20px', // Figma: body/md line-height
  },
  notificationLocation: {
    fontSize: '16px', // Figma: body/md size
    fontWeight: 400, // Figma: regular
    color: '#535366', // Figma: text-secondary
    lineHeight: '20px', // Figma: body/md line-height
  },
  notificationTimestamp: {
    fontSize: '12px', // Figma: body/xs size
    fontWeight: 400, // Figma: regular
    color: '#535366', // Figma: text-secondary
    lineHeight: '16px', // Figma: body/xs line-height
    flexShrink: 0,
    paddingTop: '8px', // Align to top
  },
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 24px',
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
    padding: '16px 24px', // Adjusted padding
  },
  seeMoreButton: {
    width: '100%',
    padding: '4px 8px', // Figma: button/xs padding
    height: '32px', // Figma: button xs height
    fontSize: '14px', // Figma: body/sm size
    fontWeight: 400, // Figma: regular
    color: '#141413', // Figma: text-primary
    backgroundColor: '#ffffff', // Figma: button-xs-fill
    border: '1px solid #141413', // Figma: button-xs-stroke
    borderRadius: '8px', // Figma: extra-small-buttons/corner-radius
    cursor: 'pointer',
    transition: 'background-color 0.15s ease, border-color 0.15s ease',
    fontFamily: 'inherit',
    lineHeight: '20px', // Figma: body/sm line-height
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};

// Add hover styles using CSS-in-JS workaround
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    .notification-item:hover {
      background-color: #f5f5f5 !important;
    }
    button[aria-label="Dismiss error"]:hover {
      background-color: rgba(0, 0, 0, 0.1) !important;
    }
    button[aria-label="Close"]:hover {
      background-color: rgba(0, 0, 0, 0.05) !important;
    }
  `;

  // Only append if not already added
  if (!document.getElementById('academia-notifications-popup-styles')) {
    styleElement.id = 'academia-notifications-popup-styles';
    document.head.appendChild(styleElement);
  }
}

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<AcademiaNotificationsPopup />);
  console.log('[AcademiaNotificationsPopup] React app initialized');
} else {
  console.error('[AcademiaNotificationsPopup] Root container not found!');
}

// Wait for bridge to be ready
const checkReady = setInterval(() => {
  const bridge = window.__messageBridge;
  if (bridge && bridge.isConnected()) {
    console.log('[AcademiaNotificationsPopup] Bridge connected and ready');
    clearInterval(checkReady);
  }
}, 100);

// Timeout after 5 seconds
setTimeout(() => {
  const bridge = window.__messageBridge;
  if (!bridge || !bridge.isConnected()) {
    console.error('[AcademiaNotificationsPopup] Bridge connection timeout - native bridge may not be initialized');
    clearInterval(checkReady);
  }
}, 5000);
