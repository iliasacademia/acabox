import React from 'react';
import { createRoot } from 'react-dom/client';
import Popup from './Popup';

// Global state for the popup
let rootInstance: any = null;
let updateContentCallback: ((text: string) => void) | null = null;

// Expose global function for native code to call
declare global {
  interface Window {
    updateContent: (text: string) => void;
    webkit?: {
      messageHandlers?: {
        buttonClick?: {
          postMessage: (message: any) => void;
        };
      };
    };
  }
}

window.updateContent = (text: string) => {
  console.log('updateContent called with text:', text.substring(0, 50));
  if (updateContentCallback) {
    updateContentCallback(text);
  }
};

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);

  root.render(
    <Popup
      onUpdateCallback={(callback) => {
        updateContentCallback = callback;
      }}
    />
  );

  rootInstance = root;
  console.log('Popup React app initialized');
}

// Signal to native code that we're ready
console.log('Popup loaded and ready');
