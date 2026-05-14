import { app } from 'electron';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  createWorkspace,
  getActiveWorkspace,
  touchWorkspace,
  deactivateAllWorkspaces,
  findInactiveWorkspaceByDirectory,
  reactivateWorkspace,
  type Workspace,
} from '../db/workspaceRepository';
import { provisionWorkspace } from '../skills';

const MAX_WORKSPACE_NAME_LENGTH = 100;
const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.config', '.password-store'];

export class WorkspaceController {
  private _activeWorkspace: Workspace | null = null;

  get activeWorkspace(): Workspace | null {
    return this._activeWorkspace;
  }

  get workspacePath(): string | null {
    return this._activeWorkspace?.directory_path ?? null;
  }

  get workspaceId(): string | null {
    return this._activeWorkspace?.id ?? null;
  }

  loadActiveWorkspace(): Workspace | null {
    this._activeWorkspace = getActiveWorkspace() ?? null;
    return this._activeWorkspace;
  }

  getDefaultDirectory(name: string): string {
    const safeName = name.slice(0, MAX_WORKSPACE_NAME_LENGTH)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'my-workspace';
    return path.join(app.getPath('desktop'), safeName);
  }

  async create(name: string, directoryPath: string, apiKey: string): Promise<Workspace | null> {
    const validName = this.validateWorkspaceName(name);
    const validPath = this.validateDirectoryPath(directoryPath);

    await fsPromises.mkdir(validPath, { recursive: true });
    provisionWorkspace(validPath);

    const existing = findInactiveWorkspaceByDirectory(validPath);
    if (existing) {
      reactivateWorkspace(existing.id, apiKey);
      touchWorkspace(existing.id);
    } else {
      const id = randomUUID();
      createWorkspace(id, validName, validPath, apiKey);
      touchWorkspace(id);
    }

    this._activeWorkspace = getActiveWorkspace() ?? null;
    return this._activeWorkspace;
  }

  deactivateAll(): void {
    deactivateAllWorkspaces();
    this._activeWorkspace = null;
  }

  validateWorkspaceName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error('Workspace name cannot be empty.');
    if (trimmed.length > MAX_WORKSPACE_NAME_LENGTH) throw new Error(`Workspace name cannot exceed ${MAX_WORKSPACE_NAME_LENGTH} characters.`);
    return trimmed;
  }

  validateDirectoryPath(directoryPath: string): string {
    const resolved = path.resolve(directoryPath);
    const homeDir = app.getPath('home');
    if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
      throw new Error('Workspace directory must be within your home directory.');
    }
    const relative = path.relative(homeDir, resolved);
    const firstSegment = relative.split(path.sep)[0];
    if (SENSITIVE_HOME_DIRS.includes(firstSegment)) {
      throw new Error('Cannot create a workspace in a sensitive directory.');
    }
    return resolved;
  }
}
