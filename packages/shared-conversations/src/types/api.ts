/**
 * API Client Types
 *
 * These types define the abstract interface for API communication,
 * allowing different implementations for Electron (IPC) and Web (fetch).
 */

export interface ApiCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  data?: Record<string, unknown>;
  /** Browser File object for overlay environments where filesystem paths are unavailable */
  file?: File;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  path: string;
}

export interface BrowseFilesResponse {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

/**
 * Abstract API client interface that can be implemented
 * differently for Electron (IPC) and Web (fetch) environments.
 */
export interface ConversationsApiClient {
  /**
   * Core API call method - abstracts the transport layer (IPC vs fetch)
   */
  invoke<T = unknown>(options: ApiCallOptions): Promise<T>;

  /**
   * Subscribe to real-time events (optional)
   * Used for file sync notifications in Electron
   */
  on?(event: string, callback: (...args: unknown[]) => void): void;

  /**
   * Unsubscribe from events (optional)
   */
  removeListener?(event: string, callback: (...args: unknown[]) => void): void;

  /**
   * Open external URL in browser (optional)
   * Used for feedback forms and external links
   */
  openExternalUrl?(url: string): void;

  /**
   * Browse a filesystem directory (optional).
   * Used by the in-overlay file picker.
   */
  browseFiles?(dir?: string): Promise<BrowseFilesResponse>;

  /**
   * Read a file by filesystem path and return a File object (optional).
   * Used by the in-overlay file picker after the user selects a file.
   */
  readFile?(filePath: string): Promise<File | null>;
}
