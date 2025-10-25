import React from 'react';
import { createRoot } from 'react-dom/client';
import Popup from './Popup';
import { getBridgeInstance } from './hooks/useBridge';

// Initialize bridge early
const bridge = getBridgeInstance('popup-default');

console.log('[Popup] Initializing...');
console.log('[Popup] Platform:', bridge.getPlatform());

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);

  root.render(<Popup />);

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
