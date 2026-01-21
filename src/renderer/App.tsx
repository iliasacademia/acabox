import React, { useState, useEffect } from 'react';
import LoginModal from './components/LoginModal';
import DevTools from './components/DevTools';
import { UpdateBanner } from './components/UpdateBanner';
import { PermissionsBanner } from './components/PermissionsBanner';
import { Notification as NotificationType } from '../types/notifications';
import { stripHtml } from '../shared/utils';
import { IPC_CHANNELS, NavigateToPagePayload } from '../shared/types';
import { useDevToolsLog } from './hooks/useDevToolsLog';
import { trackNotificationView, trackNotificationClick } from './utils/analytics';
import { initZendeskWidget, cleanupZendeskWidget, showWidget } from './utils/zendeskWidget';
import { initFullStory, identifyUser, clearUserIdentity } from './utils/fullstory';
import { FEATURES } from '../shared/types';
import Projects from './components/Projects';
import { StatusBar } from './components/StatusBar';
import { useConnectivityStatus } from './hooks/useConnectivityStatus';
import './App.css';

// Initialize FullStory early (fire and forget - async init happens in background)
initFullStory().catch((error) => console.error('[App] FullStory init failed:', error));

const App: React.FC = () => {
  const [showLogin, setShowLogin] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [pendingNavigation, setPendingNavigation] = useState<NavigateToPagePayload | null>(null);

  // Auto-update banner state
  const [updateState, setUpdateState] = useState<{
    show: boolean;
    status: 'available' | 'downloading' | 'downloaded' | 'error';
    version?: string;
    progress?: number;
    errorMessage?: string;
  }>({ show: false, status: 'available' });

  // Permissions banner state
  const [permissionState, setPermissionState] = useState<{
    show: boolean;
    isChecking: boolean;
  }>({ show: false, isChecking: false });

  // Detect if this is the main window (Projects UI) or dev window
  const isMainWindow = new URLSearchParams(window.location.search).get('window') === 'main';

  // Detect if we're in development mode
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Listen for devtools logs from main process
  useDevToolsLog();

  // Monitor connectivity status
  const connectivity = useConnectivityStatus();

  // Add body class for development banner padding and status bar (when offline)
  useEffect(() => {
    // Add status bar padding only when offline
    if (connectivity.status === 'offline') {
      document.body.classList.add('has-status-bar');
    } else {
      document.body.classList.remove('has-status-bar');
    }
  }, [connectivity.status]);

  // Development mode is now shown in title bar instead of banner
  // No need to add body class for banner padding

  // Detect platform and add appropriate class for styling
  useEffect(() => {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('mac')) {
      document.body.classList.add('platform-mac');
    }
  }, []);

  useEffect(() => {
    checkLoginStatus();
  }, []);

  useEffect(() => {
    if (userId) {
      // Start polling in main process
      window.electronAPI.invoke(IPC_CHANNELS.START_NOTIFICATION_POLLING, userId)
        .catch((error) => console.error('[Renderer] Failed to start notification polling:', error));

      // Start events polling
      window.electronAPI.invoke(IPC_CHANNELS.START_EVENTS_POLLING, userId)
        .catch((error) => console.error('[Renderer] Failed to start events polling:', error));

      // Listen for new notifications
      const handleNewNotification = (_event: any, notif: NotificationType) => {
        // Track analytics - notification.view
        if (notif.data?.conversation_id && notif.data?.agent_name) {
          trackNotificationView(
            notif.project_id,
            notif.data.conversation_id,
            notif.data.agent_name
          );
        }
        showDesktopNotification(notif);
      };
      window.electronAPI.on('new-notification', handleNewNotification);

      return () => {
        window.electronAPI.removeListener('new-notification', handleNewNotification);
        // Note: Don't stop polling here - on macOS, the app continues running when window closes.
        // Polling is stopped when user logs out or app quits (handled in main.ts 'before-quit' event)
      };
    }
  }, [userId]);

  // Listen for navigation events from main process (triggered by notification clicks)
  useEffect(() => {
    const handleNavigateToPage = (_event: any, payload: NavigateToPagePayload) => {
      setPendingNavigation(payload);
    };

    window.electronAPI.on(IPC_CHANNELS.NAVIGATE_TO_PAGE, handleNavigateToPage);

    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.NAVIGATE_TO_PAGE, handleNavigateToPage);
    };
  }, []);

  // Listen for auto-update events from main process
  useEffect(() => {
    const handleUpdateAvailable = (_event: any, data: { version: string; formattedVersion: string }) => {
      setUpdateState({
        show: true,
        status: 'available',
        version: data.formattedVersion,
      });
    };

    const handleDownloadProgress = (_event: any, data: { percent: number }) => {
      setUpdateState(prev => ({
        ...prev,
        status: 'downloading',
        progress: data.percent,
      }));
    };

    const handleUpdateDownloaded = () => {
      setUpdateState(prev => ({
        ...prev,
        status: 'downloaded',
      }));
    };

    const handleUpdateError = (_event: any, data: { message: string }) => {
      console.error('[App] Update error:', data.message);
      setUpdateState(prev => ({
        ...prev,
        status: 'error',
        errorMessage: data.message,
      }));
    };

    window.electronAPI.on(IPC_CHANNELS.UPDATE_AVAILABLE, handleUpdateAvailable);
    window.electronAPI.on(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, handleDownloadProgress);
    window.electronAPI.on(IPC_CHANNELS.UPDATE_DOWNLOADED, handleUpdateDownloaded);
    window.electronAPI.on(IPC_CHANNELS.UPDATE_ERROR, handleUpdateError);

    return () => {
      window.electronAPI.off(IPC_CHANNELS.UPDATE_AVAILABLE, handleUpdateAvailable);
      window.electronAPI.off(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, handleDownloadProgress);
      window.electronAPI.off(IPC_CHANNELS.UPDATE_DOWNLOADED, handleUpdateDownloaded);
      window.electronAPI.off(IPC_CHANNELS.UPDATE_ERROR, handleUpdateError);
    };
  }, []);

  // Listen for accessibility permission status from main process
  useEffect(() => {
    // Initial permission check on mount (only on main window)
    if (isMainWindow) {
      const checkInitialPermission = async () => {
        try {
          const result = await window.electronAPI.invoke(IPC_CHANNELS.CHECK_ACCESSIBILITY_PERMISSION);
          if (result && !result.hasPermission) {
            setPermissionState({ show: true, isChecking: false });
          }
        } catch (error) {
          console.error('[App] Failed to check initial permission:', error);
        }
      };

      checkInitialPermission();
    }

    // Listen for permission status updates from main process
    const handlePermissionStatus = (_event: any, data: { hasPermission: boolean }) => {
      setPermissionState({
        show: !data.hasPermission,
        isChecking: false,
      });
    };

    window.electronAPI.on(IPC_CHANNELS.ACCESSIBILITY_PERMISSION_STATUS, handlePermissionStatus);

    return () => {
      window.electronAPI.off(IPC_CHANNELS.ACCESSIBILITY_PERMISSION_STATUS, handlePermissionStatus);
    };
  }, [isMainWindow]);

  const handleNavigationHandled = () => {
    setPendingNavigation(null);
  };

  const checkLoginStatus = async () => {
    try {
      const isLoggedIn = await window.electronAPI.invoke(IPC_CHANNELS.CHECK_LOGIN);
      if (!isLoggedIn) {
        setShowLogin(true);
        setUserId(null);
        setUserName(null);
      } else {
        // Get current user info
        const user = await window.electronAPI.invoke(IPC_CHANNELS.GET_CURRENT_USER);
        if (user) {
          setUserId(user.id);
          setUserName(user.first_name || user.name || null);

          // Identify user in FullStory for session attribution (with device ID and version)
          const [deviceId, appInfo] = await Promise.all([
            window.electronAPI.invoke(IPC_CHANNELS.GET_DEVICE_ID),
            window.electronAPI.invoke(IPC_CHANNELS.GET_APP_INFO),
          ]);
          identifyUser(user.id, user.email, user.first_name || user.name, deviceId, appInfo.version);

          // Initialize Zendesk for already-logged-in user
          if (FEATURES.ZENDESK_WIDGET_ENABLED) {
            initZendeskWidget({
              id: user.id.toString(),
              email: user.email || undefined,
              name: user.first_name || user.name || undefined,
            });
            showWidget();
          }
        }
        // Refresh manuscript paths for Word integration tracking on app startup
        await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);
      }
    } finally {
      setAuthLoading(false);
    }
  };

  const showDesktopNotification = (notif: NotificationType) => {
    try {
      // Show native OS notification with HTML stripped from body
      const osNotification = new Notification(notif.title, {
        body: stripHtml(notif.body_html),
        tag: notif.id.toString(), // Use id for deduplication
      });

      osNotification.onclick = () => {
        // Track analytics - notification.click
        if (notif.data?.conversation_id && notif.data?.agent_name) {
          trackNotificationClick(
            notif.project_id,
            notif.data.conversation_id,
            notif.data.agent_name
          );
        }

        // Navigate to conversation if notification has the required data
        if (notif.data?.conversation_id && notif.project_id) {
          window.electronAPI.invoke(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
            page: 'conversation',
            projectId: notif.project_id,
            conversationId: notif.data.conversation_id,
          } as NavigateToPagePayload);
        }

        // Mark as read
        window.electronAPI.invoke(IPC_CHANNELS.MARK_NOTIFICATION_READ, notif.id);
      };

      osNotification.onerror = (error) => {
        console.error(`[Renderer] OS notification error for ${notif.id}:`, error);
      };
    } catch (error) {
      console.error(`[Renderer] Failed to create OS notification for ${notif.id}:`, error);
    }
  };

  const handleLoginSuccess = async () => {
    // Get user info FIRST, before hiding modal
    // This prevents race condition with Projects' onLoginRequired effect
    const user = await window.electronAPI.invoke(IPC_CHANNELS.GET_CURRENT_USER);
    if (user) {
      setUserId(user.id);
      setUserName(user.first_name || user.name || null);
      setShowLogin(false); // Only hide modal AFTER userId is set

      // Identify user in FullStory for session attribution (with device ID and version)
      const [deviceId, appInfo] = await Promise.all([
        window.electronAPI.invoke(IPC_CHANNELS.GET_DEVICE_ID),
        window.electronAPI.invoke(IPC_CHANNELS.GET_APP_INFO),
      ]);
      identifyUser(user.id, user.email, user.first_name || user.name, deviceId, appInfo.version);

      // Initialize Zendesk widget with user info
      if (FEATURES.ZENDESK_WIDGET_ENABLED) {
        initZendeskWidget({
          id: user.id.toString(),
          email: user.email || undefined,
          name: user.first_name || user.name || undefined,
        });
        showWidget();
      }

      // Refresh manuscript paths for Word integration tracking
      await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);
      // Reinitialize sync services now that user is logged in
      // This handles the case where app started without a user logged in
      await window.electronAPI.invoke(IPC_CHANNELS.REINITIALIZE_SYNC);
    } else {
      // get-current-user returned null - login didn't complete properly
      // Keep modal open so user can retry
      console.error('[App] Login success but get-current-user returned null');
    }
  };

  const handleLogout = async () => {
    // Clean up Zendesk before logout
    if (FEATURES.ZENDESK_WIDGET_ENABLED) {
      cleanupZendeskWidget();
    }

    // Clear FullStory user identity
    clearUserIdentity();

    const result = await window.electronAPI.invoke(IPC_CHANNELS.LOGOUT);
    if (result.success) {
      setShowLogin(true);
      setUserId(null);
      setUserName(null);
    }
  };

  // Auto-update handlers
  const handleDownloadUpdate = async () => {
    setUpdateState(prev => ({ ...prev, status: 'downloading', progress: 0 }));
    try {
      await window.electronAPI.invoke(IPC_CHANNELS.DOWNLOAD_UPDATE);
    } catch (error) {
      console.error('[App] Download update failed:', error);
      // Error will be handled by UPDATE_ERROR event
    }
  };

  const handleRetryUpdate = async () => {
    setUpdateState(prev => ({ ...prev, status: 'downloading', progress: 0, errorMessage: undefined }));
    try {
      await window.electronAPI.invoke(IPC_CHANNELS.DOWNLOAD_UPDATE);
    } catch (error) {
      console.error('[App] Retry update failed:', error);
      // Error will be handled by UPDATE_ERROR event
    }
  };

  // Permission handlers
  const handleGrantPermission = async () => {
    setPermissionState(prev => ({ ...prev, isChecking: true }));
    try {
      // Opens System Settings > Accessibility
      await window.electronAPI.invoke(IPC_CHANNELS.REQUEST_ACCESSIBILITY_PERMISSION);
    } catch (error) {
      console.error('[App] Failed to open settings:', error);
    } finally {
      setPermissionState(prev => ({ ...prev, isChecking: false }));
    }
  };

  const handleResetPermission = async () => {
    setPermissionState(prev => ({ ...prev, isChecking: true }));
    try {
      // This will reset TCC (with admin password prompt) and open System Settings
      await window.electronAPI.invoke(IPC_CHANNELS.RESET_ACCESSIBILITY_PERMISSION);
    } catch (error) {
      console.error('[App] Failed to reset permission:', error);
    } finally {
      setPermissionState(prev => ({ ...prev, isChecking: false }));
    }
  };

  const handleRestartApp = async () => {
    try {
      await window.electronAPI.restartApp();
    } catch (error) {
      console.error('[App] Failed to restart app:', error);
    }
  };

  // If this is the main window, render the Projects UI
  if (isMainWindow) {
    // Wait for auth check to complete before rendering Projects
    if (authLoading) {
      return null; // Or a loading spinner
    }
    return (
      <>
        {/* titleBarDragRegion not needed with native frame */}
        {/* Development mode now shown in window title bar instead of banner */}
        {permissionState.show && (
          <PermissionsBanner
            onGrantPermission={handleGrantPermission}
            onResetPermission={handleResetPermission}
            onRestartApp={handleRestartApp}
            isWorking={permissionState.isChecking}
            isDevelopment={isDevelopment}
            hasUpdateBanner={updateState.show}
          />
        )}
        <Projects
          userId={userId}
          userName={userName}
          onLogout={handleLogout}
          onLoginRequired={() => setShowLogin(true)}
          pendingNavigation={pendingNavigation}
          onNavigationHandled={handleNavigationHandled}
        />
        {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
        {updateState.show && (
          <UpdateBanner
            status={updateState.status}
            version={updateState.version}
            progress={updateState.progress}
            errorMessage={updateState.errorMessage}
            onDownloadClick={handleDownloadUpdate}
            onRetryClick={handleRetryUpdate}
          />
        )}
        {connectivity.status === 'offline' && (
          <StatusBar
            connectivityStatus={connectivity.status}
            lastChecked={connectivity.lastChecked}
          />
        )}
      </>
    );
  }

  // Otherwise, render the development tools UI
  return (
    <>
      {/* Development mode now shown in window title bar instead of banner */}
      <DevTools onLogout={handleLogout} />
      {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
      {updateState.show && (
        <UpdateBanner
          status={updateState.status}
          version={updateState.version}
          progress={updateState.progress}
          errorMessage={updateState.errorMessage}
          onDownloadClick={handleDownloadUpdate}
          onRetryClick={handleRetryUpdate}
        />
      )}
      {connectivity.status === 'offline' && (
        <StatusBar
          connectivityStatus={connectivity.status}
          lastChecked={connectivity.lastChecked}
        />
      )}
    </>
  );
};

export default App;
