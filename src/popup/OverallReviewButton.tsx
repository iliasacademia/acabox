import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useNativeEvent, useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';
import academiaLogos from '../assets/academia-logos.svg';
import dropdownArrow from '../assets/dropdown-arrow.svg';

// Initialize bridge early
getBridgeInstance('overall-review-button');

console.log('[OverallReviewButton] Initializing...');
console.log('[OverallReviewButton] Platform:', window.__messageBridge?.getPlatform());

interface OverallReviewButtonProps {
  date?: string;
}

// Helper function to format date in user's timezone
const formatReviewDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
};

const OverallReviewButton: React.FC<OverallReviewButtonProps> = ({ date: initialDate }) => {
  const [date, setDate] = useState<string>(initialDate || 'Wed, 29 Oct');
  const { sendRequest, loading } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[OverallReviewButton] Render - date:', date, 'isReady:', isReady);

  // Fetch review data from API
  useEffect(() => {
    const fetchReviewDate = async () => {
      try {
        console.log('[OverallReviewButton] Fetching review date...');

        const response = await fetch(
          'http://127.0.0.1:23111/proxy-api/v0/writing_agent/get_document?subdomain_param=api&document_id=257',
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            },
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.document_created_at) {
          const formattedDate = formatReviewDate(data.document_created_at);
          setDate(formattedDate);
          console.log('[OverallReviewButton] Date updated:', formattedDate);
        }
      } catch (err) {
        console.error('[OverallReviewButton] Failed to fetch review date:', err);
        // Keep default date on error
      }
    };

    fetchReviewDate();
  }, []);

  // Listen for date updates from native
  useNativeEvent('updateDate', (msg) => {
    logJSON('[OverallReviewButton] Date update received:', msg.payload);
    if (msg.payload?.date) {
      setDate(msg.payload.date);
    }
  });

  const handleClick = async () => {
    console.log('[OverallReviewButton] Button clicked');

    try {
      const result = await sendRequest('buttonClicked', {});
      logJSON('[OverallReviewButton] Click response:', result);
    } catch (err) {
      console.error('[OverallReviewButton] Click failed:', err);
    }
  };

  const buttonStyle: React.CSSProperties = {
    backgroundColor: '#ffffff',
    border: '1px solid #141413',
    borderRadius: '104px',
    padding: '8px 12px',
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    cursor: 'pointer',
    boxSizing: 'border-box',
    outline: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  };

  const contentContainerStyle: React.CSSProperties = {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  };

  const textContainerStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    fontFamily: 'DM Sans, sans-serif',
    fontWeight: 600,
    fontSize: '14px',
    lineHeight: '20px',
    color: '#141413',
  };

  const logoStyle: React.CSSProperties = {
    width: '13.81px',
    height: '12.185px',
    flexShrink: 0,
  };

  const iconStyle: React.CSSProperties = {
    width: '10px',
    height: '10px',
    flexShrink: 0,
  };

  return (
    <button
      style={buttonStyle}
      onClick={handleClick}
      disabled={!isReady || loading}
      data-node-id="834:30602"
    >
      <img src={academiaLogos} alt="" style={logoStyle} data-node-id="834:30462" />
      <div style={contentContainerStyle} data-node-id="834:30707">
        <div style={textContainerStyle} data-node-id="834:30674">
          <span data-node-id="834:30464">Overall review</span>
          <span data-node-id="834:30527">|</span>
          <span data-node-id="834:30540">{date}</span>
        </div>
        <img src={dropdownArrow} alt="" style={iconStyle} data-node-id="1:102" />
      </div>
    </button>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<OverallReviewButton />);
  console.log('[OverallReviewButton] Component mounted');
} else {
  console.error('[OverallReviewButton] Root element not found');
}

export default OverallReviewButton;
