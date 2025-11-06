import React from 'react';
import { createRoot } from 'react-dom/client';
import { useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';

// Initialize bridge early
getBridgeInstance('text-side-button');

console.log('[TextSideButton] Initializing...');
console.log('[TextSideButton] Platform:', window.__messageBridge?.getPlatform());

const TextSideButton: React.FC = () => {
  const { sendRequest, loading } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[TextSideButton] Render - isReady:', isReady);

  const handleClick = async () => {
    console.log('[TextSideButton] Button clicked');

    try {
      const result = await sendRequest('buttonClicked', {});
      logJSON('[TextSideButton] Click response:', result);
    } catch (err) {
      console.error('[TextSideButton] Click failed:', err);
    }
  };

  const buttonStyle: React.CSSProperties = {
    backgroundColor: '#0645B1',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    color: '#ffffff',
    fontSize: '14px',
    fontWeight: 600,
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    cursor: 'pointer',
    outline: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 0.15s ease-in-out',
    whiteSpace: 'nowrap',
  };

  return (
    <button
      style={buttonStyle}
      onClick={handleClick}
      disabled={!isReady || loading}
      onMouseEnter={(e) => {
        if (!e.currentTarget.disabled) {
          e.currentTarget.style.backgroundColor = '#053a8f';
        }
      }}
      onMouseLeave={(e) => {
        if (!e.currentTarget.disabled) {
          e.currentTarget.style.backgroundColor = '#0645B1';
        }
      }}
    >
      View Details
    </button>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<TextSideButton />);
  console.log('[TextSideButton] Component mounted');
} else {
  console.error('[TextSideButton] Root element not found');
}

export default TextSideButton;
