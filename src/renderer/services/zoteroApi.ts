import { IPC_CHANNELS } from '../../shared/types';

export interface ZoteroStatus {
  connected: boolean;
  zotero_username: string | null;
  zotero_user_id: string | null;
  write_access: boolean;
  last_sync_version: number | null;
}

export async function getZoteroStatus(): Promise<ZoteroStatus> {
  try {
    const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'GET',
      endpoint: 'v0/co_scientist/zotero/status',
    });
    return response;
  } catch (error) {
    console.error('[ZoteroAPI] Failed to get status:', error);
    return { connected: false, zotero_username: null, zotero_user_id: null, write_access: false, last_sync_version: null };
  }
}

export async function disconnectZotero(): Promise<{ success: boolean }> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: 'v0/co_scientist/zotero/disconnect',
  });
  return response;
}

export function getZoteroAuthorizeUrl(): string {
  const isDev = process.env.NODE_ENV === 'development';
  const host = isDev ? 'https://devdemia.com' : 'https://academia.edu';
  return `${host}/co_scientist/zotero/authorize`;
}
