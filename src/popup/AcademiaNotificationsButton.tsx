import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import academiaLogos from '../assets/academia-logos.svg';
import './AcademiaNotificationsButton.css';

// Initialize bridge early
getBridgeInstance('academia-notifications-button');

// Get serverUrl from window.location.origin (popup is served from the HTTP server)
// This ensures we use the correct port even when server binds to fallback port
const serverUrl = window.location.origin;

// Generate unique instance ID for logging (uses PID from URL or random ID)
const urlParams = new URLSearchParams(window.location.search);
const pidParam = urlParams.get('pid');
const instanceId = `AcademiaNotificationsButton-${pidParam || Math.random().toString(36).substring(2, 8)}`;

interface AcademiaNotificationsButtonProps {
  apiBaseUrl?: string;
}

// Define response type locally to avoid importing server types in client code
interface WordPollResponse {
  shouldShow: boolean;
  projectId?: number;
  projectFileId?: number;
  notificationCount: number;
  isActive: boolean;
}

const AcademiaNotificationsButton: React.FC<AcademiaNotificationsButtonProps> = ({
  apiBaseUrl = serverUrl
}) => {
  const [badgeCount, setBadgeCount] = useState<number>(0);
  const [shouldShow, setShouldShow] = useState<boolean>(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const { sendRequest, loading } = useSendMessage();
  const isReady = useBridgeReady();

  // Extract Token from URL
  const tokenParam = urlParams.get('token');

  useEffect(() => {
    if (tokenParam) setAuthToken(tokenParam);
  }, [tokenParam]);

  // Polling logic - poll /word/:pid/poll every 3 seconds
  useEffect(() => {
    if (!pidParam) {
      console.warn('[AcademiaNotificationsButton] No PID in URL query params - hiding button');
      setShouldShow(false);
      return;
    }

    const poll = async () => {
      try {
        const url = `${apiBaseUrl}/word/${pidParam}/poll`;
        const headers: Record<string, string> = {
          'Accept': 'application/json',
          'X-Instance-Id': instanceId,
        };
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok) {
           // If 404 or other error, assume should hide
           setShouldShow(false);
           return;
        }

        const data: WordPollResponse = await response.json();
        
        // Update state
        setShouldShow(data.shouldShow);
        // Use actual count (or binary if preferred, but usually count is better if supported)
        // Previous logic forced 1, but we'll use actual count here as it's more informative
        setBadgeCount(data.notificationCount);

      } catch (error) {
        console.error('[AcademiaNotificationsButton] Poll failed:', error);
      }
    };

    // Poll immediately
    poll();

    // Set interval (3 seconds)
    const intervalId = setInterval(poll, 3000);

    return () => clearInterval(intervalId);
  }, [apiBaseUrl, pidParam, authToken]);

  const handleClick = async () => {
    try {
      await sendRequest('buttonClicked', {});
    } catch (err) {
      console.error('[AcademiaNotificationsButton] Click failed:', err);
    }
  };

  // If should not show, return null to render nothing
  if (!shouldShow) {
      return null;
  }

  // Format badge count (show "9+" for counts > 9)
  const displayCount = badgeCount > 9 ? '9+' : badgeCount.toString();

  return (
    <div className="button-container">
      <button
        className="button"
        onClick={handleClick}
        disabled={!isReady || loading}
        data-node-id="1630:6725"
      >
        <div className="logo-section" data-node-id="1630:6720">
          <img src={academiaLogos} alt="Academia" className="logo" data-node-id="1630:6721" />
        </div>
        <span className="feedback-text" data-node-id="1630:6722">Feedback</span>
        {badgeCount > 0 && (
          <div className="badge" data-node-id="1630:6723">
            <span className="badge-text" data-node-id="1630:6724">
              {displayCount}
            </span>
          </div>
        )}
      </button>
    </div>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<AcademiaNotificationsButton />);
} else {
  console.error('[AcademiaNotificationsButton] Root element not found');
}

export default AcademiaNotificationsButton;
