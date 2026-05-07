import { getDatabase } from './database';

export interface Workspace {
  id: string;
  name: string;
  directory_path: string;
  api_key: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
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
    .prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(id) as Workspace | undefined;
}

export function listWorkspaces(): Workspace[] {
  return getDatabase()
    .prepare('SELECT * FROM workspaces ORDER BY created_at')
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
    .prepare('SELECT * FROM workspaces ORDER BY last_accessed_at DESC, created_at ASC LIMIT 1')
    .get() as Workspace | undefined;
}

export function touchWorkspace(id: string): void {
  getDatabase()
    .prepare("UPDATE workspaces SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?")
    .run(id);
}

export function deleteAllWorkspaces(): void {
  getDatabase()
    .prepare('DELETE FROM workspaces')
    .run();
}
