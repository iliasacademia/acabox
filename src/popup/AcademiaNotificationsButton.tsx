import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import academiaLogos from '../assets/academia-logos.svg';
import './AcademiaNotificationsButton.css';

// Initialize bridge early
getBridgeInstance('academia-notifications-button');

// Parse serverUrl from query params (passed by native bridge)
const urlParams = new URLSearchParams(window.location.search);
const serverUrl = urlParams.get('serverUrl') || 'http://127.0.0.1:23111';

interface AcademiaNotificationsButtonProps {
  apiBaseUrl?: string;
}

const AcademiaNotificationsButton: React.FC<AcademiaNotificationsButtonProps> = ({
  apiBaseUrl = serverUrl
}) => {
  const [badgeCount, setBadgeCount] = useState<number>(0);
  const [projectFileId, setProjectFileId] = useState<number | null>(null);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const { sendRequest, loading } = useSendMessage();
  const isReady = useBridgeReady();

  // Extract PID from URL and fetch project_file_id on mount
  useEffect(() => {
    const fetchProjectFileId = async () => {
      try {
        // Extract PID and token from URL query params
        const urlParams = new URLSearchParams(window.location.search);
        const pid = urlParams.get('pid');
        const token = urlParams.get('token');

        if (token) {
          setAuthToken(token);
        }

        if (!pid) {
          console.warn('[AcademiaNotificationsButton] No PID in URL query params - badge will be hidden');
          setIsInitialized(true);
          return;
        }

        // Fetch project file info from /word/:pid/project_file
        const response = await fetch(`${apiBaseUrl}/word/${pid}/project_file`);

        if (!response.ok) {
          console.error('[AcademiaNotificationsButton] Failed to fetch project_file:', response.status);
          setIsInitialized(true);
          return;
        }

        const data = await response.json();
        setProjectFileId(data.project_file_id);
        setIsInitialized(true);
      } catch (error) {
        console.error('[AcademiaNotificationsButton] Error fetching project_file:', error);
        setIsInitialized(true);
      }
    };

    fetchProjectFileId();
  }, [apiBaseUrl]);

  // Polling logic - fetch filtered notification count every 10 seconds
  // Only starts after initialization (project_file_id fetch attempt completed)
  useEffect(() => {
    // Don't start polling until initialized
    if (!isInitialized) {
      return;
    }

    // If no project_file_id, don't poll - keep badge hidden
    if (projectFileId === null) {
      setBadgeCount(0);
      return;
    }

    const fetchNotificationCount = async () => {
      try {
        // Include project_file_id filter in the request
        const url = `${apiBaseUrl}/api/notifications/count?project_file_id=${projectFileId}`;

        const headers: Record<string, string> = {
          'Accept': 'application/json',
        };
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }

        const response = await fetch(url, {
          method: 'GET',
          headers,
        });

        if (!response.ok) {
          console.error('[AcademiaNotificationsButton] HTTP error:', response.status);
          return;
        }

        const data = await response.json();

        // Get notifications array from response and count client-side
        const notifications = data.notifications || [];
        const count = notifications.length;

        // Badge shows 1 if any matching notifications exist, 0 otherwise
        setBadgeCount(count > 0 ? 1 : 0);
      } catch (error) {
        console.error('[AcademiaNotificationsButton] Error fetching notification count:', error);
      }
    };

    // Fetch immediately
    fetchNotificationCount();

    // Set up polling interval (10 seconds)
    const intervalId = setInterval(fetchNotificationCount, 10000);

    // Cleanup on unmount
    return () => {
      clearInterval(intervalId);
    };
  }, [apiBaseUrl, projectFileId, isInitialized, authToken]);

  const handleClick = async () => {
    try {
      await sendRequest('buttonClicked', {});
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
} else {
  console.error('[AcademiaNotificationsButton] Root element not found');
}

export default AcademiaNotificationsButton;
