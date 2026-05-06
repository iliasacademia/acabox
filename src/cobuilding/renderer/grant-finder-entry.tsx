import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../prebuilt-apps/grantFinder/App';

let requestId = 0;
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

window.addEventListener('message', (event) => {
  if (event.data?.type === 'response' && event.data.id) {
    const handler = pendingRequests.get(event.data.id);
    if (handler) {
      pendingRequests.delete(event.data.id);
      if (event.data.error) {
        handler.reject(new Error(event.data.error));
      } else {
        handler.resolve(event.data.result);
      }
    }
  }
});

function request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const id = `req-${++requestId}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    window.parent.postMessage({ type, id, ...args }, '*');
  });
}

(window as any).academiaAPI = {
  fetch: (method: string, endpoint: string, data?: unknown) =>
    request('academia:fetch', { method, endpoint, data }),
  setComposerText: (text: string) =>
    request('setComposerText', { text }),
  openExternal: (url: string) =>
    request('openExternal', { url }),
};

createRoot(document.getElementById('root')!).render(<App />);
