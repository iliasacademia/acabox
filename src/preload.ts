import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from './shared/types';

// Single source of truth for valid event channels - prevents security bypass from inconsistent lists
const VALID_EVENT_CHANNELS: string[] = [
  IPC_CHANNELS.FILE_UPLOADED,
  IPC_CHANNELS.FILE_SYNCED,
  IPC_CHANNELS.FOLDER_SYNC_STATUS,
  IPC_CHANNELS.INITIAL_SYNC_STATUS,
  IPC_CHANNELS.INITIAL_SYNC_PROGRESS,
  IPC_CHANNELS.PROJECT_FILE_SYNCED,
  IPC_CHANNELS.SELECTION_UPDATED,
  IPC_CHANNELS.BUTTON_ACTION,
  IPC_CHANNELS.NEW_NOTIFICATION,
  IPC_CHANNELS.NOTIFICATION_UPDATED,
];

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // IPC handlers
  invoke: (channel: string, ...args: any[]) => {
    const validChannels = Object.values(IPC_CHANNELS) as string[];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error('Invalid channel'));
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

  // Remove all event listeners
  removeAllListeners: (channel: string) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel as any);
    }
  },
});
