/**
 * API response types for sync operations
 */

export interface SyncFolder {
  folder_name: string;
  path: string;
  user_id: number;
  created_at: string;
  updated_at: string;
}

export interface SyncedFile {
  key: string;
  file_name: string;
  relative_path: string;
  size: number;
  last_modified: string;
}

export interface SyncAgentFolder {
  folder_name: string;
  folder_path: string;
  created_at: string;
  updated_at: string;
  files: Array<{
    file_name: string;
    relative_path: string;
    size: number;
    last_modified: string;
    key: string;
  }>;
}

export interface GetLatestResponse {
  folders: SyncAgentFolder[];
  total_folders: number;
  total_files: number;
}
