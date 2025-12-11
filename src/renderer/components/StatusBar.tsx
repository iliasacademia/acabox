import React from 'react';
import './StatusBar.css';

type ConnectivityStatus = 'online' | 'offline' | 'checking';

interface StatusBarProps {
  connectivityStatus: ConnectivityStatus;
  lastChecked?: Date | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  connectivityStatus,
  lastChecked
}) => {
  const getStatusIcon = () => {
    switch (connectivityStatus) {
      case 'online': return '🟢';
      case 'offline': return '🔴';
      case 'checking': return '🟡';
    }
  };

  const getStatusText = () => {
    switch (connectivityStatus) {
      case 'online': return 'Connected';
      case 'offline': return 'Offline';
      case 'checking': return 'Checking connection...';
    }
  };

  return (
    <div className={`statusBar statusBar--${connectivityStatus}`}>
      <div className="statusBar__item">
        <span className="statusBar__icon">{getStatusIcon()}</span>
        <span className="statusBar__text">{getStatusText()}</span>
        {lastChecked && (
          <span className="statusBar__timestamp" title={lastChecked.toLocaleString()}>
            Last checked: {lastChecked.toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
};
