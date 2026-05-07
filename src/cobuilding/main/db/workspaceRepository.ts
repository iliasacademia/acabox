import { getDatabase } from './database';

export interface Workspace {
  id: string;
  name: string;
  directory_path: string;
  api_key: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  deleted_at: string | null;
}

export function createWorkspace(
  id: string,
  name: string,
  directoryPath: string,
  apiKey: string,
): void {
  getDatabase()
    .prepare(
      'INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, ?, ?, ?)',
    )
    .run(id, name, directoryPath, apiKey);
}

export function getWorkspace(id: string): Workspace | undefined {
  return getDatabase()
    .prepare('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL')
    .get(id) as Workspace | undefined;
}

export function listWorkspaces(): Workspace[] {
  return getDatabase()
    .prepare('SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at')
    .all() as Workspace[];
}

export function updateWorkspace(
  id: string,
  name: string,
  directoryPath: string,
  apiKey: string,
): void {
  getDatabase()
    .prepare(
      "UPDATE workspaces SET name = ?, directory_path = ?, api_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?",
    )
    .run(name, directoryPath, apiKey, id);
}

export function updateApiKey(id: string, apiKey: string): void {
  getDatabase()
    .prepare(
      "UPDATE workspaces SET api_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?",
    )
    .run(apiKey, id);
}

export function getActiveWorkspace(): Workspace | undefined {
  return getDatabase()
    .prepare('SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY last_accessed_at DESC, created_at ASC LIMIT 1')
    .get() as Workspace | undefined;
}

export function touchWorkspace(id: string): void {
  getDatabase()
    .prepare("UPDATE workspaces SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?")
    .run(id);
}

export function deactivateAllWorkspaces(): void {
  getDatabase()
    .prepare("UPDATE workspaces SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE deleted_at IS NULL")
    .run();
}

export function findInactiveWorkspaceByDirectory(directoryPath: string): Workspace | undefined {
  return getDatabase()
    .prepare('SELECT * FROM workspaces WHERE directory_path = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1')
    .get(directoryPath) as Workspace | undefined;
}

export function reactivateWorkspace(id: string, apiKey: string): void {
  getDatabase()
    .prepare("UPDATE workspaces SET deleted_at = NULL, api_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?")
    .run(apiKey, id);
}
