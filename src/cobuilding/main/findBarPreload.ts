import { contextBridge, ipcRenderer } from 'electron';
import { FIND_IPC } from '../shared/findInPage';
import type { FindResult } from '../shared/findInPage';

contextBridge.exposeInMainWorld('findBarAPI', {
  query: (text: string) => {
    ipcRenderer.send(FIND_IPC.barQuery, { text });
  },
  step: (forward: boolean) => {
    ipcRenderer.send(FIND_IPC.barStep, { forward });
  },
  close: (keepSelection: boolean) => {
    ipcRenderer.send(FIND_IPC.barClose, { keepSelection });
  },
  onResult: (callback: (result: FindResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: FindResult) => callback(result);
    ipcRenderer.on(FIND_IPC.barResult, handler);
    return () => ipcRenderer.removeListener(FIND_IPC.barResult, handler);
  },
  onFocus: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(FIND_IPC.barFocus, handler);
    return () => ipcRenderer.removeListener(FIND_IPC.barFocus, handler);
  },
});
