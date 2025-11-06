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
    backgroundColor: '#ffffff',
    border: '1px solid #141413',
    borderRadius: '12px',
    padding: '2px 9px',
    color: '#141413',
    fontSize: '16px',
    fontWeight: 600,
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    cursor: 'pointer',
    outline: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    lineHeight: '16px',
    boxSizing: 'border-box',
    transition: 'all 0.15s ease-in-out',
    whiteSpace: 'nowrap',
  };

  return (
    <button
      style={buttonStyle}
      onClick={handleClick}
      disabled={!isReady || loading}
      onMouseEnter={(e) => {
        if (!e.currentTarget.disabled) {
          e.currentTarget.style.backgroundColor = '#f5f5f5';
        }
      }}
      onMouseLeave={(e) => {
        if (!e.currentTarget.disabled) {
          e.currentTarget.style.backgroundColor = '#ffffff';
        }
      }}
    >
      1
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
