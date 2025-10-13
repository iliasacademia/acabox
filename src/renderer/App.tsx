import React, { useState, useEffect } from 'react';
import LoginModal from './components/LoginModal';
import UploadSection from './components/UploadSection';
import SearchSection from './components/SearchSection';
import './App.css';

const App: React.FC = () => {
  const [showLogin, setShowLogin] = useState(false);
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
        <button id="logoutButton" onClick={handleLogout}>
          Logout
        </button>
      </div>
      <div className="mainContent">
        <h1>Select Folder to Upload</h1>
        <UploadSection />
        <hr />
        <SearchSection />
      </div>
      {showLogin && <LoginModal onSuccess={handleLoginSuccess} />}
    </div>
  );
};

export default App;
