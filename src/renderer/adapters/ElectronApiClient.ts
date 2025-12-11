import { ConversationsApiClient, ApiCallOptions } from '../../../packages/shared-conversations/src';
import { IPC_CHANNELS } from '../../shared/types';

/**
 * Electron-specific implementation of the ConversationsApiClient interface.
 * Uses Electron IPC to communicate with the main process for API calls.
 */
export class ElectronApiClient implements ConversationsApiClient {
  /**
   * Invoke an API call through Electron IPC
   */
  async invoke<T = unknown>(options: ApiCallOptions): Promise<T> {
    return window.electronAPI.invoke(IPC_CHANNELS.API_CALL, options);
  }

  /**
   * Subscribe to an IPC event
   */
  on(event: string, callback: (...args: unknown[]) => void): void {
    window.electronAPI.on(event, callback);
  }

  /**
   * Unsubscribe from an IPC event
   */
  removeListener(event: string, callback: (...args: unknown[]) => void): void {
    window.electronAPI.removeListener(event, callback);
  }

  /**
   * Open a URL in the system's default browser
   */
  openExternalUrl(url: string): void {
    window.electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
  }
}

// Singleton instance for convenience
export const electronApiClient = new ElectronApiClient();
