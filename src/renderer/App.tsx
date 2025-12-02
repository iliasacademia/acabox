import React, { useState, useEffect } from 'react';
import LoginModal from './components/LoginModal';
import DevTools from './components/DevTools';
import { Notification as NotificationType } from '../types/notifications';
import { stripHtml } from '../shared/utils';
import { IPC_CHANNELS, NavigateToPagePayload } from '../shared/types';
import Projects from './components/Projects';
import './App.css';

const App: React.FC = () => {
  const [showLogin, setShowLogin] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [pendingNavigation, setPendingNavigation] = useState<NavigateToPagePayload | null>(null);

  // Detect if this is the main window (Projects UI) or dev window
  const isMainWindow = new URLSearchParams(window.location.search).get('window') === 'main';

  useEffect(() => {
    checkLoginStatus();

    // Listen for API logs from main process
    const handleApiLog = (_event: any, logData: any) => {
      const timestamp = logData.timestamp || new Date().toISOString();
      if (logData.type === 'request') {
        console.log(
          `%c[${timestamp}] [API REQUEST] ${logData.method} ${logData.endpoint}`,
          'color: #0645b1; font-weight: bold',
          logData.data || ''
        );
      } else if (logData.type === 'response') {
        console.log(
          `%c[${timestamp}] [API RESPONSE] ${logData.method} ${logData.endpoint} - ${logData.status} ${logData.statusText}`,
          'color: #28a745; font-weight: bold',
          logData.data || ''
        );
      } else if (logData.type === 'error') {
        console.error(
          `%c[${timestamp}] [API ERROR] ${logData.method} ${logData.endpoint} - ${logData.status || 'No status'}`,
          'color: #dc3545; font-weight: bold',
          {
            url: logData.url,
            message: logData.message,
            data: logData.data,
          }
        );
      }
    };

    window.electronAPI.on('api-log', handleApiLog);

    return () => {
      window.electronAPI.removeListener('api-log', handleApiLog);
    };
  }, []);

  useEffect(() => {
    if (userId) {
      console.log(`[Renderer] Starting notification polling for user ${userId}`);
      // Start polling in main process
      window.electronAPI.invoke('start-notification-polling', userId)
        .then(() => console.log('[Renderer] Notification polling started successfully'))
        .catch((error) => console.error('[Renderer] Failed to start notification polling:', error));

      // Listen for new notifications
      const handleNewNotification = (_event: any, notif: NotificationType) => {
        console.log('[Renderer] Received new-notification event:', {
          id: notif.id,
          title: notif.title,
          status: notif.status,
          delivered_at: notif.delivered_at,
        });
        showDesktopNotification(notif);
      };
      window.electronAPI.on('new-notification', handleNewNotification);

      console.log('[Renderer] new-notification event listener registered');

      return () => {
        console.log('[Renderer] Cleaning up notification listeners and stopping polling');
        window.electronAPI.removeListener('new-notification', handleNewNotification);
        // Stop polling on cleanup
        window.electronAPI.invoke('stop-notification-polling');
      };
    }
  }, [userId]);

  // Listen for navigation events from main process (triggered by notification clicks)
  useEffect(() => {
    const handleNavigateToPage = (_event: any, payload: NavigateToPagePayload) => {
      console.log('[App] Navigate to page event received:', payload);
      setPendingNavigation(payload);
    };

    window.electronAPI.on(IPC_CHANNELS.NAVIGATE_TO_PAGE, handleNavigateToPage);
    console.log('[App] navigate-to-page event listener registered');

    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.NAVIGATE_TO_PAGE, handleNavigateToPage);
    };
  }, []);

  const handleNavigationHandled = () => {
    setPendingNavigation(null);
  };

  const checkLoginStatus = async () => {
    try {
      const isLoggedIn = await window.electronAPI.invoke('check-login');
      if (!isLoggedIn) {
        setShowLogin(true);
        setUserId(null);
        setUserName(null);
      } else {
        // Get current user info
        const user = await window.electronAPI.invoke('get-current-user');
        if (user) {
          setUserId(user.id);
          setUserName(user.first_name || user.name || null);
        }
        // Refresh manuscript paths for Word integration tracking on app startup
        await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);
      }
    } finally {
      setAuthLoading(false);
    }
  };

  const showDesktopNotification = (notif: NotificationType) => {
    console.log(`[Renderer] Showing OS notification for ${notif.id}: "${notif.title}"`);

    try {
      // Show native OS notification with HTML stripped from body
      const osNotification = new Notification(notif.title, {
        body: stripHtml(notif.body_html),
        tag: notif.id.toString(), // Use id for deduplication
      });

      console.log(`[Renderer] OS notification created successfully for ${notif.id}`);

      osNotification.onclick = () => {
        console.log(`[Renderer] Notification ${notif.id} clicked`);

        // Navigate to conversation if notification has the required data
        if (notif.data?.conversation_id && notif.project_id) {
          console.log(`[Renderer] Navigating to conversation ${notif.data.conversation_id} in project ${notif.project_id}`);
          window.electronAPI.invoke(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
            page: 'conversation',
            projectId: notif.project_id,
            conversationId: notif.data.conversation_id,
          } as NavigateToPagePayload);
        }

        // Mark as read
        window.electronAPI.invoke('mark-notification-read', notif.id);
      };

      osNotification.onerror = (error) => {
        console.error(`[Renderer] OS notification error for ${notif.id}:`, error);
      };
    } catch (error) {
      console.error(`[Renderer] Failed to create OS notification for ${notif.id}:`, error);
    }
  };

  const handleLoginSuccess = async () => {
    setShowLogin(false);
    // Get user info after successful login
    const user = await window.electronAPI.invoke('get-current-user');
    if (user) {
      setUserId(user.id);
      setUserName(user.first_name || user.name || null);
    }
    // Refresh manuscript paths for Word integration tracking
    await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);
  };

  const handleLogout = async () => {
    const result = await window.electronAPI.invoke('logout');
    if (result.success) {
      setShowLogin(true);
      setUserId(null);
      setUserName(null);
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
        <Projects
          userId={userId}
          userName={userName}
          onLogout={handleLogout}
          onLoginRequired={() => setShowLogin(true)}
          pendingNavigation={pendingNavigation}
          onNavigationHandled={handleNavigationHandled}
        />
        {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
      </>
    );
  }

  // Otherwise, render the development tools UI
  return (
    <>
      <DevTools onLogout={handleLogout} />
      {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
    </>
  );
};

export default App;
