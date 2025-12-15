import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, IpcChannel } from './shared/types';

// Single source of truth for valid event channels - prevents security bypass from inconsistent lists
const VALID_EVENT_CHANNELS: string[] = [
  IPC_CHANNELS.FILE_UPLOADED,
  IPC_CHANNELS.FILE_SYNCED,
  IPC_CHANNELS.FOLDER_SYNC_STATUS,
  IPC_CHANNELS.INITIAL_SYNC_STATUS,
  IPC_CHANNELS.INITIAL_SYNC_PROGRESS,
  IPC_CHANNELS.PROJECT_FILE_SYNCED,
  IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED,
  IPC_CHANNELS.SELECTION_UPDATED,
  IPC_CHANNELS.BUTTON_ACTION,
  IPC_CHANNELS.NEW_NOTIFICATION,
  IPC_CHANNELS.NOTIFICATION_UPDATED,
  IPC_CHANNELS.DEVTOOLS_LOG,
  IPC_CHANNELS.NAVIGATE_TO_PAGE,
  // Auto-update events
  IPC_CHANNELS.UPDATE_AVAILABLE,
  IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS,
  IPC_CHANNELS.UPDATE_DOWNLOADED,
  IPC_CHANNELS.UPDATE_ERROR,
  // Permissions events
  IPC_CHANNELS.ACCESSIBILITY_PERMISSION_STATUS,
];

/**
 * Deep sanitization to prevent prototype pollution
 * Recursively creates clean objects without dangerous properties
 */
function deepSanitize(obj: any, depth: number = 0): any {
  // Prevent infinite recursion
  if (depth > 10) {
    return null;
  }

  // Handle primitives
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => deepSanitize(item, depth + 1));
  }

  // Create clean object without prototype
  const clean = Object.create(null);

  for (const key of Object.keys(obj)) {
    // Skip dangerous keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    // Recursively sanitize nested objects
    clean[key] = deepSanitize(obj[key], depth + 1);
  }

  return clean;
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // IPC handlers
  invoke: (channel: string, ...args: any[]) => {
    const validChannels = Object.values(IPC_CHANNELS) as string[];
    if (!validChannels.includes(channel)) {
      return Promise.reject(new Error('Invalid channel'));
    }

    // Deep sanitize arguments to prevent prototype pollution
    const sanitizedArgs = args.map(arg => deepSanitize(arg));

    return ipcRenderer.invoke(channel, ...sanitizedArgs);
  },

  // Event listeners
  on: (channel: string, callback: (event: IpcRendererEvent, ...args: any[]) => void) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel as any, callback);
    }
  },

  // Remove specific event listener
  removeListener: (channel: string, callback: (event: IpcRendererEvent, ...args: any[]) => void) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeListener(channel as any, callback);
    }
  },

  // Alias for removeListener (common API convention)
  off: (channel: string, callback: (event: IpcRendererEvent, ...args: any[]) => void) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeListener(channel as any, callback);
    }
  },

  // Remove all event listeners
  removeAllListeners: (channel: string) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel as any);
    }
  },

  // App lifecycle
  restartApp: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.RESTART_APP);
  },
});
