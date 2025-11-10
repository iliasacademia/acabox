import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useNativeEvent, useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';
import academiaLogos from '../assets/academia-logos.svg';
import './AcademiaNotificationsButton.css';

// Initialize bridge early
getBridgeInstance('academia-notifications-button');

console.log('[AcademiaNotificationsButton] Initializing...');
console.log('[AcademiaNotificationsButton] Platform:', window.__messageBridge?.getPlatform());

interface AcademiaNotificationsButtonProps {
  apiBaseUrl?: string;
}

const AcademiaNotificationsButton: React.FC<AcademiaNotificationsButtonProps> = ({
  apiBaseUrl = 'http://127.0.0.1:23111'
}) => {
  const [badgeCount, setBadgeCount] = useState<number>(0);
  const { sendRequest, loading } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[AcademiaNotificationsButton] Render - badgeCount:', badgeCount, 'isReady:', isReady);

  // Polling logic - fetch notification count every 10 seconds
  useEffect(() => {
    const fetchNotificationCount = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/notifications/count`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          console.error('[AcademiaNotificationsButton] HTTP error:', response.status);
          return;
        }

        const data = await response.json();
        const total = data.total || 0;

        console.log('[AcademiaNotificationsButton] Fetched notification count:', total);
        setBadgeCount(total);
      } catch (error) {
        console.error('[AcademiaNotificationsButton] Error fetching notification count:', error);
      }
    };

    // Fetch immediately on mount
    fetchNotificationCount();

    // Set up polling interval (10 seconds)
    const intervalId = setInterval(fetchNotificationCount, 10000);

    // Cleanup on unmount
    return () => {
      clearInterval(intervalId);
    };
  }, [apiBaseUrl]);

  const handleClick = async () => {
    console.log('[AcademiaNotificationsButton] Button clicked');

    try {
      const result = await sendRequest('buttonClicked', {});
      logJSON('[AcademiaNotificationsButton] Click response:', result);
    } catch (err) {
      console.error('[AcademiaNotificationsButton] Click failed:', err);
    }
  };

  // Format badge count (show "9+" for counts > 9)
  const displayCount = badgeCount > 9 ? '9+' : badgeCount.toString();

  return (
    <div className="button-container">
      <button
        className="button"
        onClick={handleClick}
        disabled={!isReady || loading}
        data-node-id="549:1574"
      >
        <img src={academiaLogos} alt="Academia" className="logo" data-node-id="549:1576" />
      </button>
      {badgeCount > 0 && (
        <div className="badge" data-node-id="549:1578">
          <span className="badge-text" data-node-id="549:1579">
            {displayCount}
          </span>
        </div>
      )}
    </div>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<AcademiaNotificationsButton />);
  console.log('[AcademiaNotificationsButton] Component mounted');
} else {
  console.error('[AcademiaNotificationsButton] Root element not found');
}

export default AcademiaNotificationsButton;
