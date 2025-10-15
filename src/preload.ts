import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // IPC handlers
  invoke: (channel: string, ...args: any[]) => {
    const validChannels = ['check-login', 'login', 'logout', 'select-folder', 'upload-files', 'search-files', 'get-notifications', 'update-notification', 'get-current-user', 'get-screen-sources', 'get-all-sources', 'process-screen-ocr', 'close-overlay', 'get-sync-folders', 'add-sync-folder', 'remove-sync-folder', 'sync-folder-now', 'get-folder-files', 'get-word-content', 'process-word-window', 'test-accessibility', 'test-word-api', 'check-word-frontmost', 'update-overlay-visibility', 'get-word-scroll-position', 'get-word-text'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error('Invalid channel'));
  },

  // Event listeners
  on: (channel: string, callback: (event: IpcRendererEvent, ...args: any[]) => void) => {
    const validChannels = ['file-uploaded', 'file-synced', 'folder-sync-status', 'initial-sync-status', 'initial-sync-progress'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, callback);
    }
  },

  // Remove event listeners
  removeAllListeners: (channel: string) => {
    const validChannels = ['file-uploaded', 'file-synced', 'folder-sync-status', 'initial-sync-status', 'initial-sync-progress'];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});
