import { contextBridge, ipcRenderer } from 'electron';
import type { QuickChatContext } from './quickChat';

contextBridge.exposeInMainWorld('quickChatAPI', {
  onContext: (callback: (context: QuickChatContext) => void) => {
    ipcRenderer.on('quick-chat:context', (_event, context: QuickChatContext) => callback(context));
  },
  submit: (text: string) => {
    ipcRenderer.send('quick-chat:submit', text);
  },
  dismiss: () => {
    ipcRenderer.send('quick-chat:dismiss');
  },
  resize: (height: number) => {
    ipcRenderer.send('quick-chat:resize', height);
  },
});
