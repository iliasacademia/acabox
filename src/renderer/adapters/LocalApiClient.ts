import { ConversationsApiClient, ApiCallOptions } from '../../../packages/shared-conversations/src';
import { IPC_CHANNELS } from '../../shared/types';

/**
 * Local agent implementation of the ConversationsApiClient interface.
 * Routes conversation API calls to local IPC handlers (Anthropic API + SQLite)
 * instead of the backend API.
 */
export class LocalApiClient implements ConversationsApiClient {
  async invoke<T = unknown>(options: ApiCallOptions): Promise<T> {
    const { method, endpoint, data } = options;

    // --- Create conversation ---
    if (endpoint === 'create-conversation-with-file' && data) {
      return window.electronAPI.invoke(IPC_CHANNELS.LOCAL_AGENT_CREATE_CONVERSATION, data) as Promise<T>;
    }

    // --- Send message ---
    if (endpoint === 'send-message-with-file' && data) {
      return window.electronAPI.invoke(IPC_CHANNELS.LOCAL_AGENT_SEND_MESSAGE, data) as Promise<T>;
    }

    // --- Archive ---
    if (method === 'POST' && endpoint.includes('archive_conversation') && !endpoint.includes('unarchive') && data) {
      return window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_ARCHIVE_CONVERSATION,
        (data as Record<string, unknown>).conversation_id
      ) as Promise<T>;
    }

    // --- Unarchive ---
    if (method === 'POST' && endpoint.includes('unarchive_conversation') && data) {
      return window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_UNARCHIVE_CONVERSATION,
        (data as Record<string, unknown>).conversation_id
      ) as Promise<T>;
    }

    // --- List conversations (GET with query params) ---
    if (method === 'GET' && endpoint.includes('list_conversations')) {
      const params = new URLSearchParams(endpoint.split('?')[1] || '');
      return window.electronAPI.invoke(IPC_CHANNELS.LOCAL_AGENT_LIST_CONVERSATIONS, {
        offset: parseInt(params.get('offset') || '0'),
        limit: parseInt(params.get('limit') || '20'),
        archived: params.get('archived') === 'true',
      }) as Promise<T>;
    }

    // --- Get conversation (GET with query params) ---
    if (method === 'GET' && endpoint.includes('get_conversation')) {
      const params = new URLSearchParams(endpoint.split('?')[1] || '');
      return window.electronAPI.invoke(
        IPC_CHANNELS.LOCAL_AGENT_GET_CONVERSATION,
        parseInt(params.get('conversation_id') || '0')
      ) as Promise<T>;
    }

    // --- Fallback for unhandled endpoints ---
    console.warn(`[LocalApiClient] Unhandled endpoint: ${method} ${endpoint}`);
    return {} as T;
  }

  on(event: string, callback: (...args: unknown[]) => void): void {
    window.electronAPI.on(event, callback);
  }

  removeListener(event: string, callback: (...args: unknown[]) => void): void {
    window.electronAPI.removeListener(event, callback);
  }

  openExternalUrl(url: string): void {
    window.electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
  }
}

export const localApiClient = new LocalApiClient();
