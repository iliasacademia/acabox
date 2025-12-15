import type { IpcChannel } from './shared/types';

export interface ElectronAPI {
  invoke: (channel: IpcChannel, ...args: any[]) => Promise<any>;
  on: (channel: string, callback: (event: any, ...args: any[]) => void) => void;
  off: (channel: string, callback: (event: any, ...args: any[]) => void) => void;
  removeListener: (channel: string, callback: (event: any, ...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
  restartApp: () => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
