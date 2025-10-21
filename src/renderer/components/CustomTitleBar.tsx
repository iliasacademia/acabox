import React from 'react';
import './CustomTitleBar.css';

const CustomTitleBar: React.FC = () => {
  const handleMinimize = () => {
    window.electronAPI.invoke('minimize-window');
  };

  const handleClose = () => {
    window.electronAPI.invoke('close-window');
  };

  return (
    <div className="custom-title-bar">
      <div className="title-bar-content">
        <div className="title-bar-title">Academia Electron</div>
        <div className="title-bar-controls">
          <button
            className="title-bar-button minimize-button"
            onClick={handleMinimize}
            title="Minimize"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="0" y1="6" x2="12" y2="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <button
            className="title-bar-button close-button"
            onClick={handleClose}
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default CustomTitleBar;
