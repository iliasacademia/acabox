/**
 * Electron API type definitions for shared-conversations package
 * This allows the package to work in both Electron and non-Electron contexts
 */

export interface ElectronAPI {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  on: (channel: string, callback: (event: any, ...args: any[]) => void) => void;
  off: (channel: string, callback: (event: any, ...args: any[]) => void) => void;
  removeListener: (channel: string, callback: (event: any, ...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI; // Optional to support non-Electron contexts
  }
}

export {};
