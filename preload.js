const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // IPC handlers
  invoke: (channel, ...args) => {
    const validChannels = ['check-login', 'login', 'select-folder', 'upload-files', 'search-files'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error('Invalid channel'));
  },

  // Event listeners
  on: (channel, callback) => {
    const validChannels = ['file-uploaded'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, callback);
    }
  },

  // Remove event listeners
  removeAllListeners: (channel) => {
    const validChannels = ['file-uploaded'];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  }
});