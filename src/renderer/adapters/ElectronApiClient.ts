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
    const { method, endpoint, data } = options;

    // Handle file operations via IPC
    if (endpoint === 'open-file' && data && 'filePath' in data) {
      return window.electronAPI.invoke(IPC_CHANNELS.OPEN_FILE, data.filePath, data.page ?? undefined) as Promise<T>;
    }

    if (endpoint === 'show-file-in-folder' && data && 'filePath' in data) {
      return window.electronAPI.invoke(IPC_CHANNELS.SHOW_FILE_IN_FOLDER, data.filePath) as Promise<T>;
    }

    // Handle supporting material upload via IPC
    if (endpoint === 'upload-supporting-material' && data && 'projectId' in data && 'filePath' in data) {
      return window.electronAPI.invoke(IPC_CHANNELS.UPLOAD_SUPPORTING_MATERIAL, data) as Promise<T>;
    }

    // Handle conversation create/message with optional file attachment via IPC (multipart)
    if (endpoint === 'create-conversation-with-file' && data) {
      return window.electronAPI.invoke(IPC_CHANNELS.CREATE_CONVERSATION_WITH_FILE, data) as Promise<T>;
    }

    if (endpoint === 'send-message-with-file' && data) {
      return window.electronAPI.invoke(IPC_CHANNELS.SEND_MESSAGE_WITH_FILE, data) as Promise<T>;
    }

    // Default: proxy through HTTP server
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
