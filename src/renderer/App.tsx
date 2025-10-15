import React, { useState, useEffect, useRef } from 'react';
import LoginModal from './components/LoginModal';
import UploadSection from './components/UploadSection';
import SearchSection from './components/SearchSection';
import ScreenReader from './components/ScreenReader';
import SyncSection from './components/SyncSection';
import './App.css';

type Page = 'uploader' | 'notifications' | 'screenReader' | 'sync';

interface DesktopNotification {
  created_at: number;
  title: string;
  description: string;
  shown_at: number | null;
}

const App: React.FC = () => {
  const [showLogin, setShowLogin] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('uploader');
  const [userId, setUserId] = useState<number | null>(null);
  const isDevelopment = process.env.NODE_ENV === 'development';
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const shownNotificationsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    checkLoginStatus();
  }, []);

  useEffect(() => {
    if (userId) {
      // Start polling for notifications
      pollNotifications();
      pollingIntervalRef.current = setInterval(pollNotifications, 10000); // Poll every 10 seconds

      return () => {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
        }
      };
    }
  }, [userId]);

  const checkLoginStatus = async () => {
    const isLoggedIn = await window.electronAPI.invoke('check-login');
    if (!isLoggedIn) {
      setShowLogin(true);
      setUserId(null);
    } else {
      // Get current user ID
      const user = await window.electronAPI.invoke('get-current-user');
      if (user) {
        setUserId(user.id);
      }
    }
  };

  const pollNotifications = async () => {
    try {
      const response = await window.electronAPI.invoke('get-notifications');
      const notifications: DesktopNotification[] = response.notifications || [];

      // Filter notifications that haven't been shown yet
      const unshownNotifications = notifications.filter(
        (notif) => notif.shown_at === null && !shownNotificationsRef.current.has(notif.created_at)
      );

      // Show each unshown notification
      for (const notif of unshownNotifications) {
        showDesktopNotification(notif);
        shownNotificationsRef.current.add(notif.created_at);

        // Update the backend to mark as shown
        if (userId) {
          await window.electronAPI.invoke('update-notification', userId, notif.created_at);
        }
      }
    } catch (error) {
      console.error('Error polling notifications:', error);
    }
  };

  const showDesktopNotification = (notif: DesktopNotification) => {
    new Notification(notif.title, {
      body: notif.description,
    });
  };

  const handleLoginSuccess = async () => {
    setShowLogin(false);
    // Get user ID after successful login
    const user = await window.electronAPI.invoke('get-current-user');
    if (user) {
      setUserId(user.id);
    }
  };

  const handleLogout = async () => {
    const result = await window.electronAPI.invoke('logout');
    if (result.success) {
      setShowLogin(true);
      setUserId(null);
      shownNotificationsRef.current.clear();
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    }
  };

  return (
    <div className="app">
      {isDevelopment && (
        <div className="devBanner">
          🔧 DEVELOPMENT MODE
        </div>
      )}
      <div className="sidebar">
        <nav className="sidebarNav">
          <button
            className={`menuItem ${currentPage === 'uploader' ? 'active' : ''}`}
            onClick={() => setCurrentPage('uploader')}
          >
            Uploader
          </button>
          <button
            className={`menuItem ${currentPage === 'notifications' ? 'active' : ''}`}
            onClick={() => setCurrentPage('notifications')}
          >
            Notifications
          </button>
          <button
            className={`menuItem ${currentPage === 'screenReader' ? 'active' : ''}`}
            onClick={() => setCurrentPage('screenReader')}
          >
            Screen Reader
          </button>
          <button
            className={`menuItem ${currentPage === 'sync' ? 'active' : ''}`}
            onClick={() => setCurrentPage('sync')}
          >
            Sync Agent
          </button>
        </nav>
        <button id="logoutButton" onClick={handleLogout}>
          Logout
        </button>
      </div>
      <div className="mainContent">
        {currentPage === 'uploader' && (
          <>
            <h1>Select Folder to Upload</h1>
            <UploadSection />
            <hr />
            <SearchSection />
          </>
        )}
        {currentPage === 'notifications' && (
          <>
            <h1>Notifications</h1>
            <p>Notifications page coming soon...</p>
            <button onClick={() => {
              new Notification('Academia Uploader', {
                body: 'This is a test notification from your Academia Uploader app!'
              });
            }}>
              Test Notification
            </button>
          </>
        )}
        {currentPage === 'screenReader' && <ScreenReader />}
        {currentPage === 'sync' && <SyncSection />}
      </div>
      {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
    </div>
  );
};

export default App;
