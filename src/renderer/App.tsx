import React, { useState, useEffect, useRef } from 'react';
import LoginModal from './components/LoginModal';
import UploadSection from './components/UploadSection';
import SearchSection from './components/SearchSection';
import ScreenReader from './components/ScreenReader';
import SyncSection from './components/SyncSection';
import WordReader from './components/WordReader';
import SelectionTracker from './components/SelectionTracker';
import TrayIconSwitcher from './components/TrayIconSwitcher';
import PositionDebugger from './components/PositionDebugger';
import CustomTitleBar from './components/CustomTitleBar';
import { Notification as NotificationType } from '../types/notifications';
import { stripHtml } from '../shared/utils';
import Projects from './components/Projects';
import './App.css';

type Page = 'positionDebugger' | 'uploader' | 'notifications' | 'screenReader' | 'sync' | 'wordReader' | 'selectionTracker' | 'trayIconSwitcher';

const App: React.FC = () => {
  const [showLogin, setShowLogin] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('positionDebugger');
  const [userId, setUserId] = useState<number | null>(null);
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Detect if this is the main window (Projects UI) or dev window
  const isMainWindow = new URLSearchParams(window.location.search).get('window') === 'main';

  useEffect(() => {
    checkLoginStatus();

    // Listen for button actions from the native popup
    const handleButtonAction = (_event: any, data: { action: string; text: string }) => {
      console.log('[App] Button action received:', data.action);

      if (data.action === 'copy') {
        // Show success notification
        new Notification('Copied Successfully', {
          body: 'Text has been copied to clipboard',
        });
      } else if (data.action === 'lookup') {
        // Switch to Selection Tracker page to show the lookup
        setCurrentPage('selectionTracker');
      }
    };

    window.electronAPI.on('button-action', handleButtonAction);

    return () => {
      window.electronAPI.removeListener('button-action', handleButtonAction);
    };
  }, []);

  useEffect(() => {
    if (userId) {
      // Listen for new notifications
      const handleNewNotification = (_event: any, notif: NotificationType) => {
        showDesktopNotification(notif);
      };
      window.electronAPI.on('new-notification', handleNewNotification);

      return () => {
        window.electronAPI.removeListener('new-notification', handleNewNotification);
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

  const showDesktopNotification = (notif: NotificationType) => {
    // Show native OS notification with HTML stripped from body
    new Notification(notif.title, {
      body: stripHtml(notif.body_html),
      tag: notif.id.toString(), // Use id for deduplication
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
    }
  };

  // If this is the main window, render the Projects UI
  if (isMainWindow) {
    return <Projects />;
  }

  // Otherwise, render the development tools UI
  return (
    <div className="app">
      <CustomTitleBar />
      {isDevelopment && (
        <div className="devBanner">
          🔧 DEVELOPMENT MODE
        </div>
      )}
      <div className="app-body">
        <div className="sidebar">
        <nav className="sidebarNav">
          <button
            className={`menuItem ${currentPage === 'positionDebugger' ? 'active' : ''}`}
            onClick={() => setCurrentPage('positionDebugger')}
          >
            Position Debugger
          </button>
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
          <button
            className={`menuItem ${currentPage === 'wordReader' ? 'active' : ''}`}
            onClick={() => setCurrentPage('wordReader')}
          >
            Word Reader
          </button>
          <button
            className={`menuItem ${currentPage === 'selectionTracker' ? 'active' : ''}`}
            onClick={() => setCurrentPage('selectionTracker')}
          >
            Selection Tracker
          </button>
          <button
            className={`menuItem ${currentPage === 'trayIconSwitcher' ? 'active' : ''}`}
            onClick={() => setCurrentPage('trayIconSwitcher')}
          >
            Tray Icon
          </button>
        </nav>
        <button id="logoutButton" onClick={handleLogout}>
          Logout
        </button>
      </div>
      <div className="mainContent">
        {currentPage === 'positionDebugger' && <PositionDebugger />}
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
              new Notification('Test Notification', {
                body: 'This is a test notification from your Academia Uploader app!',
                tag: 'test-notification'
              });
            }}>
              Test Notification
            </button>
          </>
        )}
        {currentPage === 'screenReader' && <ScreenReader />}
        {currentPage === 'sync' && <SyncSection />}
        {currentPage === 'wordReader' && <WordReader />}
        {currentPage === 'selectionTracker' && <SelectionTracker />}
        {currentPage === 'trayIconSwitcher' && <TrayIconSwitcher />}
      </div>
      </div>
      {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
    </div>
  );
};

export default App;
