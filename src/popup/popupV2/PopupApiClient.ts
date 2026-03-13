import { ConversationsApiClient, ApiCallOptions } from '../../../packages/shared-conversations/src/types/api';
import { navigateToPage, tokenParam } from './shared';

/**
 * HTTP fetch-based implementation of ConversationsApiClient for the popup.
 * Routes API calls through the server's /proxy-api/* proxy route.
 */
export class PopupApiClient implements ConversationsApiClient {
  constructor(private serverUrl: string, private token: string | null) {}

  async invoke<T = unknown>(options: ApiCallOptions): Promise<T> {
    const { method, endpoint, data } = options;
    const url = `${this.serverUrl}/proxy-api/${endpoint}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  }

  openExternalUrl(url: string): void {
    navigateToPage({ page: 'external', url }, this.token ?? tokenParam);
  }
}
