import { ConversationsApiClient, ApiCallOptions, BrowseFilesResponse } from '../../../packages/shared-conversations/src/types/api';
import { navigateToPage, tokenParam } from './shared';

/**
 * HTTP fetch-based implementation of ConversationsApiClient for the popup.
 * Routes API calls through the server's /proxy-api/* proxy route.
 */
export class PopupApiClient implements ConversationsApiClient {
  constructor(private serverUrl: string, private token: string | null) {}

  async invoke<T = unknown>(options: ApiCallOptions): Promise<T> {
    let { method, endpoint, data, file } = options;

    // Translate IPC-only endpoints to real flat API endpoints.
    if (endpoint === 'create-conversation-with-file' || endpoint === 'send-message-with-file') {
      endpoint = endpoint === 'create-conversation-with-file'
        ? 'v0/co_scientist/create_conversation'
        : 'v0/co_scientist/create_message';

      if (data) {
        const { project_id, filePath: _filePath, ...rest } = data as Record<string, unknown>;
        data = {
          ...rest,
          ...(project_id ? { parent_id: project_id, parent_type: 'Project' } : {}),
        };
      }
    }

    const url = `${this.serverUrl}/proxy-api/${endpoint}`;
    const authHeaders: Record<string, string> = this.token
      ? { 'Authorization': `Bearer ${this.token}` }
      : {};

    // When a browser File is attached, send as multipart/form-data so the proxy
    // can forward the binary to the backend unchanged.
    if (file) {
      const formData = new FormData();
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          if (Array.isArray(value)) {
            value.forEach(v => formData.append(`${key}[]`, String(v)));
          } else if (value !== undefined && value !== null) {
            formData.append(key, String(value));
          }
        }
      }
      formData.append('file', file, file.name);

      // No Content-Type header — browser sets it automatically with the correct boundary
      const response = await fetch(url, { method, headers: authHeaders, body: formData });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      return response.json();
    }

    const response = await fetch(url, {
      method,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
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

  private get authHeaders(): Record<string, string> {
    return this.token ? { 'Authorization': `Bearer ${this.token}` } : {};
  }

  async browseFiles(dir?: string): Promise<BrowseFilesResponse> {
    const url = new URL(`${this.serverUrl}/api/browse-files`);
    if (dir) url.searchParams.set('dir', dir);
    const response = await fetch(url.toString(), { headers: this.authHeaders });
    if (!response.ok) throw new Error(`Browse files error: ${response.status}`);
    return response.json();
  }

  async readFile(filePath: string): Promise<File | null> {
    const response = await fetch(`${this.serverUrl}/api/read-file`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!response.ok) return null;
    const { name, base64 } = await response.json();
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return new File([bytes], name);
  }
}
