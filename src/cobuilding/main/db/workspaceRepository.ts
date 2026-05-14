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

export interface WorkspaceDirectory {
  id: string;
  workspace_id: string;
  directory_path: string;
  display_name: string;
  sort_order: number;
  created_at: string;
}

export function createWorkspace(
  id: string,
  apiKey: string,
): void {
  getDatabase()
    .prepare(
      "INSERT INTO workspaces (id, name, directory_path, api_key) VALUES (?, '', '', ?)",
    )
    .run(id, apiKey);
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

// --- workspace_directories CRUD ---

export function addWorkspaceDirectory(
  id: string,
  workspaceId: string,
  directoryPath: string,
  displayName: string,
  sortOrder = 0,
): void {
  getDatabase()
    .prepare(
      'INSERT INTO workspace_directories (id, workspace_id, directory_path, display_name, sort_order) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, workspaceId, directoryPath, displayName, sortOrder);
}

export function removeWorkspaceDirectory(id: string): void {
  getDatabase()
    .prepare('DELETE FROM workspace_directories WHERE id = ?')
    .run(id);
}

export function listWorkspaceDirectories(workspaceId: string): WorkspaceDirectory[] {
  return getDatabase()
    .prepare('SELECT * FROM workspace_directories WHERE workspace_id = ? ORDER BY sort_order, created_at')
    .all(workspaceId) as WorkspaceDirectory[];
}

