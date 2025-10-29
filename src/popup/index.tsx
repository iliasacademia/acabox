import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import Popup from './Popup';
import SuggestionsContainer from './SuggestionsContainer';
import { getBridgeInstance } from './hooks/useBridge';

// Initialize bridge early
const bridge = getBridgeInstance('popup-default');

console.log('[Popup] Initializing...');
console.log('[Popup] Platform:', bridge.getPlatform());

// App wrapper component that decides which component to render
const App: React.FC = () => {
  const [viewType, setViewType] = useState<'text' | 'suggestions'>('suggestions'); // Default to suggestions for ClickPopupWindow

  useEffect(() => {
    console.log('[App] Setting up view type listener');

    // Listen for updateContent messages to determine which view to show
    const handler = (msg: any) => {
      console.log('[App] updateContent received:', msg);
      console.log('[App] Full message object:', JSON.stringify(msg, null, 2));
      console.log('[App] Payload:', msg.payload);
      console.log('[App] Payload type:', msg.payload?.type);

      if (msg.payload?.type === 'suggestions') {
        console.log('[App] Switching to SuggestionsContainer');
        setViewType('suggestions');
      } else if (msg.payload?.type === 'text' || typeof msg.payload === 'string') {
        console.log('[App] Switching to Popup (text view)');
        setViewType('text');
      } else {
        console.log('[App] Unknown type, staying with current view:', viewType);
      }
    };

    // Register handler with bridge
    bridge.on('updateContent', handler);

    console.log('[App] View type listener registered');

    return () => {
      bridge.off('updateContent');
    };
  }, [viewType]);

  console.log('[App] Rendering view type:', viewType);

  if (viewType === 'suggestions') {
    return <SuggestionsContainer />;
  }

  return <Popup />;
};

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);

  root.render(<App />);

  console.log('[Popup] React app initialized');
} else {
  console.error('[Popup] Root container not found!');
}

// Wait for bridge to be ready, then signal
const checkReady = setInterval(() => {
  if (bridge.isConnected()) {
    console.log('[Popup] Bridge connected and ready');
    clearInterval(checkReady);
  }
}, 100);

// Timeout after 5 seconds
setTimeout(() => {
  if (!bridge.isConnected()) {
    console.error('[Popup] Bridge connection timeout - native bridge may not be initialized');
    clearInterval(checkReady);
  }
}, 5000);
