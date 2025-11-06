import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useNativeEvent, useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';
import academiaLogos from '../assets/academia-logos.svg';

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

  // Container style - fill entire window and position button at bottom-left
  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '24px',
    height: '24px',
  };

  // Circular button style (matching Figma: black background, black stroke)
  const buttonStyle: React.CSSProperties = {
    width: '24px',
    height: '24px',
    backgroundColor: '#141413',
    border: '1px solid #000000',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    outline: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    padding: 0,
    position: 'relative',
  };

  // Academia logo style (white logo on black background)
  const logoStyle: React.CSSProperties = {
    width: '13.81px',
    height: '12.185px',
    filter: 'brightness(0) invert(1)', // Make logo white
  };

  // Badge container style (red circle at top-right)
  const badgeStyle: React.CSSProperties = {
    position: 'absolute',
    top: '-12px',
    right: '-12px',
    width: '20px',
    height: '20px',
    backgroundColor: '#f10000',
    border: '1.25px solid #f2f0ec',
    borderRadius: '50%',
    display: badgeCount > 0 ? 'flex' : 'none',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  };

  // Badge text style (white text, 12px, Roboto ExtraBold)
  const badgeTextStyle: React.CSSProperties = {
    fontFamily: 'Roboto, sans-serif',
    fontWeight: 800,
    fontSize: '12px',
    lineHeight: '12px',
    color: '#f2f0ec',
    textAlign: 'center',
  };

  // Format badge count (show "9+" for counts > 9)
  const displayCount = badgeCount > 9 ? '9+' : badgeCount.toString();

  return (
    <div style={containerStyle}>
      <button
        style={buttonStyle}
        onClick={handleClick}
        disabled={!isReady || loading}
        data-node-id="549:1574"
      >
        <img src={academiaLogos} alt="Academia" style={logoStyle} data-node-id="549:1576" />
      </button>
      {badgeCount > 0 && (
        <div style={badgeStyle} data-node-id="549:1578">
          <span style={badgeTextStyle} data-node-id="549:1579">
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
