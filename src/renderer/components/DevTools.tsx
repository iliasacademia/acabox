import React, { useState, useEffect } from 'react';
import UploadSection from './UploadSection';
import SearchSection from './SearchSection';
import ScreenReader from './ScreenReader';
import SyncSection from './SyncSection';
import WordReader from './WordReader';
import SelectionTracker from './SelectionTracker';
import TrayIconSwitcher from './TrayIconSwitcher';
import PositionDebugger from './PositionDebugger';

type Page = 'positionDebugger' | 'uploader' | 'notifications' | 'screenReader' | 'sync' | 'wordReader' | 'selectionTracker' | 'trayIconSwitcher';

interface DevToolsProps {
  onLogout: () => void;
}

const DevTools: React.FC<DevToolsProps> = ({ onLogout }) => {
  const [currentPage, setCurrentPage] = useState<Page>('positionDebugger');
  const isDevelopment = process.env.NODE_ENV === 'development';

  useEffect(() => {
    // Listen for button actions from the native popup
    const handleButtonAction = (_event: any, data: { action: string; text: string }) => {
      console.log('[DevTools] Button action received:', data.action);

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

  return (
    <div className="app">
      <div className="titleBarDragRegion" />
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
          <button id="logoutButton" onClick={onLogout}>
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
    </div>
  );
};

export default DevTools;
