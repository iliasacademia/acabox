import { app } from 'electron';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  createWorkspace,
  getActiveWorkspace,
  touchWorkspace,
  deactivateAllWorkspaces,
  addWorkspaceDirectory,
  removeWorkspaceDirectory,
  listWorkspaceDirectories,
  listWorkspaceDirectoriesBySource,
  updateWorkspaceDirectoryPermission,
  type Workspace,
  type WorkspaceDirectory,
} from '../db/workspaceRepository';
import { provisionWorkspace } from '../skills';
import { WORKSPACE_DATA_DIR, MAX_WORKSPACE_DIRECTORIES } from '../../shared/paths';

const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.config', '.password-store'];

export class WorkspaceController {
  private _activeWorkspace: Workspace | null = null;
  private _userDirectories: WorkspaceDirectory[] = [];

  constructor() {
    fs.mkdirSync(this.getAgentControlledDir(), { recursive: true });
  }

  get activeWorkspace(): Workspace | null {
    return this._activeWorkspace;
  }

  get workspacePath(): string {
    return this.getAgentControlledDir();
  }

  get workspaceId(): string | null {
    return this._activeWorkspace?.id ?? null;
  }

  get userDirectories(): WorkspaceDirectory[] {
    return this._userDirectories;
  }

  get userDirectoryPaths(): string[] {
    return this._userDirectories.map(d => d.directory_path);
  }

  get allAllowedPaths(): string[] {
    return [this.workspacePath, ...this.userDirectoryPaths, this.driveCacheBaseDir];
  }

  get mountMap(): Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> {
    return buildMountMap(this.workspacePath, this.userDirectories, this.driveCacheBaseDir);
  }

  get driveCacheBaseDir(): string {
    return path.join(app.getPath('userData'), 'google-drive-cache');
  }

  isPathAllowed(filePath: string): string | null {
    // Try as an absolute host path first
    const resolved = path.resolve(filePath);
    for (const dir of this.allAllowedPaths) {
      if (resolved.startsWith(dir + path.sep) || resolved === dir) {
        return resolved;
      }
    }
    // Try as a relative path (e.g. container paths like /.applications/... need
    // the leading slash stripped so they resolve against the agent dir)
    const relative = filePath.replace(/^\/+/, '');
    for (const dir of this.allAllowedPaths) {
      const resolvedRelative = path.resolve(dir, relative);
      if (resolvedRelative.startsWith(dir + path.sep) || resolvedRelative === dir) {
        return resolvedRelative;
      }
    }
    return null;
  }

  getAgentControlledDir(): string {
    return path.join(app.getPath('userData'), WORKSPACE_DATA_DIR);
  }

  loadActiveWorkspace(): Workspace | null {
    this._activeWorkspace = getActiveWorkspace() ?? null;
    this._userDirectories = this._activeWorkspace
      ? listWorkspaceDirectories(this._activeWorkspace.id)
      : [];
    return this._activeWorkspace;
  }

  async create(directoryPaths: string[], apiKey: string): Promise<Workspace | null> {
    if (directoryPaths.length > MAX_WORKSPACE_DIRECTORIES) {
      throw new Error(`A workspace can have at most ${MAX_WORKSPACE_DIRECTORIES} directories.`);
    }

    // Dedupe by canonical path (realpath) — on case-insensitive filesystems
    // ~/Data and ~/data resolve to the same inode but different strings; a
    // plain Set dedupe by string would seat both rows in the DB.
    const canonical = new Map<string, string>();
    for (const dp of directoryPaths) {
      const validated = this.validateDirectoryPath(dp);
      let key = validated;
      try { key = fs.realpathSync(validated); } catch { /* path may not exist yet */ }
      if (!canonical.has(key)) canonical.set(key, validated);
    }
    const validPaths = [...canonical.values()];

    for (const vp of validPaths) {
      await fsPromises.mkdir(vp, { recursive: true });
    }

    const workspaceId = randomUUID();
    createWorkspace(workspaceId, apiKey);
    for (let i = 0; i < validPaths.length; i++) {
      addWorkspaceDirectory(randomUUID(), workspaceId, validPaths[i], path.basename(validPaths[i]), i);
    }
    touchWorkspace(workspaceId);

    provisionWorkspace(this.getAgentControlledDir());

    this._activeWorkspace = getActiveWorkspace() ?? null;
    this._userDirectories = this._activeWorkspace
      ? listWorkspaceDirectories(this._activeWorkspace.id)
      : [];
    return this._activeWorkspace;
  }

  addDirectory(directoryPath: string): WorkspaceDirectory {
    if (!this._activeWorkspace) throw new Error('No active workspace.');
    const validPath = this.validateDirectoryPath(directoryPath);
    // Reject adds that resolve to the same inode as an existing entry.
    // Case-insensitive filesystems and symlink chains let two different
    // strings name the same directory; without this we'd insert a duplicate
    // row and clobber the existing workspace symlink with one pointing at
    // the same place.
    let canonical = validPath;
    try { canonical = fs.realpathSync(validPath); } catch { /* may not exist yet */ }
    for (const existing of this._userDirectories) {
      let existingCanonical = existing.directory_path;
      try { existingCanonical = fs.realpathSync(existing.directory_path); } catch { /* ignore */ }
      if (existingCanonical === canonical) {
        throw new Error('This directory is already in your workspace.');
      }
    }
    const id = randomUUID();
    const displayName = path.basename(validPath);
    const sortOrder = this._userDirectories.length;
    addWorkspaceDirectory(id, this._activeWorkspace.id, validPath, displayName, sortOrder);
    this._userDirectories = listWorkspaceDirectories(this._activeWorkspace.id);
    return this._userDirectories.find(d => d.id === id)!;
  }

  removeDirectory(directoryId: string): void {
    if (!this._activeWorkspace) throw new Error('No active workspace.');
    removeWorkspaceDirectory(directoryId);
    this._userDirectories = listWorkspaceDirectories(this._activeWorkspace.id);
  }

  updateDirectoryPermission(directoryId: string, readOnly: boolean): WorkspaceDirectory {
    if (!this._activeWorkspace) throw new Error('No active workspace.');
    updateWorkspaceDirectoryPermission(directoryId, readOnly);
    this._userDirectories = listWorkspaceDirectories(this._activeWorkspace.id);
    return this._userDirectories.find(d => d.id === directoryId)!;
  }

  deactivateAll(): void {
    deactivateAllWorkspaces();
    this._activeWorkspace = null;
    this._userDirectories = [];
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

function sanitizeMountName(dirPath: string): string {
  return path.basename(dirPath).replace(/[^a-zA-Z0-9._-]/g, '') || 'dir';
}

// Builds the ordered list of volume mounts for the podman container.
// The agent-controlled directory is always first, mounted at /data (the container's
// working directory). User directories follow, each mounted at /data/<sanitized-name>.
// The google-drive-cache base directory is always mounted at /data/google-drive/ so
// that new Drive folders appear inside the container without a restart.
// If two directories produce the same name, duplicates get a _2, _3 suffix.
export function buildMountMap(
  agentDir: string,
  directories: WorkspaceDirectory[],
  driveCacheBase?: string,
): Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> {
  const result: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> = [
    { hostPath: agentDir, containerPath: '/data' },
  ];
  const counts = new Map<string, number>();
  for (const dir of directories) {
    const base = sanitizeMountName(dir.directory_path);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const name = count > 0 ? `${base}_${count + 1}` : base;
    result.push({ hostPath: dir.directory_path, containerPath: `/data/${name}`, readOnly: dir.read_only });
  }

  if (driveCacheBase) {
    fs.mkdirSync(driveCacheBase, { recursive: true });
    result.push({ hostPath: driveCacheBase, containerPath: '/data/google-drive' });
  }

  return result;
}
