import React, { useState, useEffect } from 'react';
import LoginModal from './components/LoginModal';
import UploadSection from './components/UploadSection';
import SearchSection from './components/SearchSection';
import './App.css';

type Page = 'uploader' | 'notifications';

const App: React.FC = () => {
  const [showLogin, setShowLogin] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('uploader');
  const isDevelopment = process.env.NODE_ENV === 'development';

  useEffect(() => {
    checkLoginStatus();
  }, []);

  const checkLoginStatus = async () => {
    const isLoggedIn = await window.electronAPI.invoke('check-login');
    if (!isLoggedIn) {
      setShowLogin(true);
    }
  };

  const handleLoginSuccess = () => {
    setShowLogin(false);
  };

  const handleLogout = async () => {
    const result = await window.electronAPI.invoke('logout');
    if (result.success) {
      setShowLogin(true);
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
      </div>
      {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
    </div>
  );
};

export default App;
