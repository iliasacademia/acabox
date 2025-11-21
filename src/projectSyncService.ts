import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { APIclient, getCsrfToken } from './uploader';
import { IPC_CHANNELS } from './shared/types';
import FormData from 'form-data';

/**
 * Validates that a file path is within the allowed base directory
 * Prevents path traversal attacks
 */
function validatePath(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

interface WatchedProjectFolder {
  projectId: number;
  folderId: number;
  folderPath: string;
  watcher: chokidar.FSWatcher | null;
  status: 'idle' | 'syncing' | 'synced' | 'error';
  fileCount: number;
  lastSync: string | null;
  manuscriptPath?: string;
}

interface ProjectSyncStatus {
  projectId: number;
  folderId: number;
  folderPath: string;
  status: string;
  fileCount: number;
  syncedCount: number;
  errorCount: number;
}

class ProjectSyncService {
  private watchedFolders: Map<string, WatchedProjectFolder> = new Map();
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private sendToRenderer(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Start watching a project folder and sync files
   */
  async startWatching(projectId: number, folderId: number, folderPath: string, manuscriptPath?: string) {
    const key = `${projectId}-${folderId}`;

    console.log(`[ProjectSync] Starting to watch folder: ${folderPath} for project ${projectId}`);
    if (manuscriptPath) {
      console.log(`[ProjectSync] Manuscript file will be tagged: ${manuscriptPath}`);
    } else {
      console.log(`[ProjectSync] No manuscript path provided for this folder`);
    }

    // Check if folder exists
    if (!fs.existsSync(folderPath)) {
      throw new Error('Folder does not exist');
    }

    // Check if already watching
    if (this.watchedFolders.has(key)) {
      console.log(`[ProjectSync] Already watching folder ${folderPath} for project ${projectId}`);
      // Update manuscript path if provided
      const existing = this.watchedFolders.get(key);
      if (existing && manuscriptPath) {
        existing.manuscriptPath = manuscriptPath;
      }
      return;
    }

    // Perform initial sync of all files
    await this.performInitialSync(projectId, folderId, folderPath, manuscriptPath);

    // Create watcher
    const watcher = chokidar.watch(folderPath, {
      persistent: true,
      ignoreInitial: true, // We already synced existing files
      followSymlinks: true,
      ignored: (filePath: string) => {
        // Validate path to prevent traversal attacks
        if (!validatePath(folderPath, filePath)) {
          console.warn(`[ProjectSync] Path traversal attempt detected: ${filePath}`);
          return true;
        }

        const basename = path.basename(filePath);
        // Ignore hidden files (starting with .)
        if (basename.startsWith('.')) return true;
        // Ignore directories
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          return false;
        }
        return false;
      },
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
      depth: 99,
    });

    const watchedFolder: WatchedProjectFolder = {
      projectId,
      folderId,
      folderPath,
      watcher,
      status: 'idle',
      fileCount: 0,
      lastSync: null,
      manuscriptPath,
    };

    this.watchedFolders.set(key, watchedFolder);

    // Set up event handlers
    watcher.on('add', (filePath: string) => this.handleFileAdded(projectId, folderId, folderPath, filePath));
    watcher.on('change', (filePath: string) => this.handleFileChanged(projectId, folderId, folderPath, filePath));
    watcher.on('unlink', (filePath: string) => this.handleFileDeleted(projectId, folderId, folderPath, filePath));

    watcher.on('error', (error) => {
      console.error(`[ProjectSync] Watcher error for ${folderPath}:`, error);
      watchedFolder.status = 'error';
      this.sendSyncStatus(projectId, folderId, folderPath);
    });

    console.log(`[ProjectSync] Watcher started for ${folderPath}`);
  }

  /**
   * Stop watching a project folder
   */
  async stopWatching(projectId: number, folderId: number) {
    const key = `${projectId}-${folderId}`;
    const watchedFolder = this.watchedFolders.get(key);

    if (!watchedFolder) {
      return;
    }

    if (watchedFolder.watcher) {
      await watchedFolder.watcher.close();
    }

    this.watchedFolders.delete(key);
    console.log(`[ProjectSync] Stopped watching folder for project ${projectId}, folder ${folderId}`);
  }

  /**
   * Perform initial sync of all files in the folder
   */
  private async performInitialSync(projectId: number, folderId: number, folderPath: string, manuscriptPath?: string) {
    const key = `${projectId}-${folderId}`;
    const watchedFolder = this.watchedFolders.get(key);

    console.log(`[ProjectSync] Starting initial sync for ${folderPath}`);
    if (manuscriptPath) {
      console.log(`[ProjectSync] Will tag manuscript: ${manuscriptPath}`);
    }

    if (watchedFolder) {
      watchedFolder.status = 'syncing';
      this.sendSyncStatus(projectId, folderId, folderPath);
    }

    try {
      // Get all files in the folder
      const files = this.getAllFiles(folderPath);
      console.log(`[ProjectSync] Found ${files.length} files to sync`);

      if (files.length === 0) {
        if (watchedFolder) {
          watchedFolder.status = 'synced';
          watchedFolder.lastSync = new Date().toISOString();
          this.sendSyncStatus(projectId, folderId, folderPath);
        }
        return;
      }

      // Parallel upload files (in chunks of 5 concurrent uploads)
      const chunkSize = 5;
      let syncedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < files.length; i += chunkSize) {
        const chunk = files.slice(i, i + chunkSize);

        // Upload all files in this chunk in parallel
        const results = await Promise.allSettled(
          chunk.map(filePath => this.syncFileToProject(projectId, folderId, folderPath, filePath, manuscriptPath))
        );

        // Process results
        results.forEach((result, index) => {
          const filePath = chunk[index];
          if (result.status === 'fulfilled') {
            syncedCount++;
            console.log(`[ProjectSync] Synced ${syncedCount}/${files.length}: ${filePath}`);
          } else {
            console.error(`[ProjectSync] Failed to sync ${filePath}:`, result.reason);
            errorCount++;
          }
        });

        // Send progress update after each chunk
        this.sendToRenderer('project-sync-progress', {
          projectId,
          folderId,
          folderPath,
          total: files.length,
          synced: syncedCount,
          errors: errorCount,
        });
      }

      if (watchedFolder) {
        watchedFolder.status = 'synced';
        watchedFolder.fileCount = syncedCount;
        watchedFolder.lastSync = new Date().toISOString();
        this.sendSyncStatus(projectId, folderId, folderPath);
      }

      console.log(`[ProjectSync] Initial sync complete: ${syncedCount} synced, ${errorCount} errors`);

      // After initial sync, if we synced a manuscript file, notify the renderer
      // so it can start polling for the automatic review
      if (manuscriptPath) {
        const relativePath = path.relative(folderPath, manuscriptPath);
        console.log(`[ProjectSync] Initial sync complete - notifying renderer about manuscript: ${relativePath}`);
        const eventData = {
          projectId,
          folderId,
          filePath: relativePath,
          action: 'initial-sync',
        };
        console.log(`[ProjectSync] Sending initial-sync event:`, JSON.stringify(eventData, null, 2));
        this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, eventData);
        console.log(`[ProjectSync] ✓ Initial-sync event sent to renderer`);
      } else {
        console.log(`[ProjectSync] ⚠ No manuscriptPath provided - not sending initial-sync event`);
      }
    } catch (error) {
      console.error(`[ProjectSync] Initial sync failed:`, error);
      if (watchedFolder) {
        watchedFolder.status = 'error';
        this.sendSyncStatus(projectId, folderId, folderPath);
      }
      throw error;
    }
  }

  /**
   * Get all files in a folder recursively
   */
  private getAllFiles(folderPath: string): string[] {
    const files: string[] = [];

    const traverse = (currentPath: string) => {
      try {
        const items = fs.readdirSync(currentPath);

        for (const item of items) {
          // Skip hidden files/folders
          if (item.startsWith('.')) continue;

          const fullPath = path.join(currentPath, item);

          // Validate path to prevent traversal attacks
          if (!validatePath(folderPath, fullPath)) {
            console.warn(`[ProjectSync] Path traversal attempt detected during file enumeration: ${fullPath}`);
            continue;
          }

          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            traverse(fullPath);
          } else if (stat.isFile()) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        console.error(`[ProjectSync] Error traversing ${currentPath}:`, error);
      }
    };

    traverse(folderPath);
    return files;
  }

  /**
   * Sync a file to the project
   */
  private async syncFileToProject(
    projectId: number,
    folderId: number,
    folderPath: string,
    filePath: string,
    manuscriptPath?: string
  ): Promise<void> {
    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    // Get relative path
    const relativePath = path.relative(folderPath, filePath);

    // Get file stats
    const stats = fs.statSync(filePath);
    const size = stats.size;

    // Determine MIME type
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = this.getMimeType(ext);

    // Check if this file is the manuscript
    const isManuscript = manuscriptPath && filePath === manuscriptPath;

    console.log(`[ProjectSync] Syncing file: ${filePath}`);
    console.log(`[ProjectSync]   Manuscript path: ${manuscriptPath || 'none'}`);
    console.log(`[ProjectSync]   Is manuscript: ${isManuscript}`);
    console.log(`[ProjectSync]   File path matches: ${filePath === manuscriptPath}`);

    if (isManuscript) {
      console.log(`[ProjectSync] ✓ TAGGING FILE AS MANUSCRIPT: ${filePath}`);
    }

    // Create form data
    const formData = new FormData();
    formData.append('project_root_id', folderId.toString());
    formData.append('rel_path', relativePath);
    formData.append('mime_type', mimeType);
    formData.append('size', size.toString());
    if (isManuscript) {
      formData.append('is_manuscript', 'true');
    }
    formData.append('file', fs.createReadStream(filePath));

    // Upload file
    const response = await client.post(
      `v0/co_scientist/projects/${projectId}/files`,
      formData,
      {
        headers: {
          'x-csrf-token': csrfToken,
          ...formData.getHeaders(),
        },
        validateStatus: () => true,
      }
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to sync file: ${response.status} - ${JSON.stringify(response.data)}`);
    }

    console.log(`[ProjectSync] File synced: ${relativePath} (uploaded: ${response.data.uploaded})`);
  }

  /**
   * Handle file added
   */
  private async handleFileAdded(projectId: number, folderId: number, folderPath: string, filePath: string) {
    console.log(`[ProjectSync] File added: ${filePath}`);
    try {
      const key = `${projectId}-${folderId}`;
      const watchedFolder = this.watchedFolders.get(key);
      const manuscriptPath = watchedFolder?.manuscriptPath;

      await this.syncFileToProject(projectId, folderId, folderPath, filePath, manuscriptPath);

      this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, {
        projectId,
        folderId,
        filePath: path.relative(folderPath, filePath),
        action: 'added',
      });
    } catch (error) {
      console.error(`[ProjectSync] Failed to sync added file:`, error);
    }
  }

  /**
   * Handle file changed
   */
  private async handleFileChanged(projectId: number, folderId: number, folderPath: string, filePath: string) {
    console.log('========================================');
    console.log(`[ProjectSync] File changed event detected`);
    console.log(`[ProjectSync]   Full path: ${filePath}`);
    console.log(`[ProjectSync]   Project ID: ${projectId}`);
    console.log(`[ProjectSync]   Folder ID: ${folderId}`);
    console.log(`[ProjectSync]   Base folder: ${folderPath}`);

    try {
      const key = `${projectId}-${folderId}`;
      const watchedFolder = this.watchedFolders.get(key);
      const manuscriptPath = watchedFolder?.manuscriptPath;
      const relativePath = path.relative(folderPath, filePath);

      console.log(`[ProjectSync]   Relative path: ${relativePath}`);
      console.log(`[ProjectSync]   Manuscript path: ${manuscriptPath || 'none'}`);
      console.log(`[ProjectSync]   Is manuscript: ${filePath === manuscriptPath}`);

      console.log(`[ProjectSync] Syncing file to backend...`);
      await this.syncFileToProject(projectId, folderId, folderPath, filePath, manuscriptPath);
      console.log(`[ProjectSync] ✓ File synced successfully to backend`);

      const eventData = {
        projectId,
        folderId,
        filePath: relativePath,
        action: 'changed',
      };

      console.log(`[ProjectSync] Sending IPC_CHANNELS.PROJECT_FILE_SYNCED event to renderer:`, eventData);
      this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, eventData);
      console.log(`[ProjectSync] ✓ Event sent to renderer`);
    } catch (error) {
      console.error(`[ProjectSync] ✗ Failed to sync changed file:`, error);
    }
    console.log('========================================');
  }

  /**
   * Handle file deleted
   */
  private async handleFileDeleted(projectId: number, folderId: number, folderPath: string, filePath: string) {
    console.log(`[ProjectSync] File deleted: ${filePath}`);
    // Note: We'd need to track file IDs to delete them
    // For now, we'll just log it
    this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, {
      projectId,
      folderId,
      filePath: path.relative(folderPath, filePath),
      action: 'deleted',
    });
  }

  /**
   * Send sync status to renderer
   */
  private sendSyncStatus(projectId: number, folderId: number, folderPath: string) {
    const key = `${projectId}-${folderId}`;
    const watchedFolder = this.watchedFolders.get(key);

    if (!watchedFolder) return;

    const status: ProjectSyncStatus = {
      projectId,
      folderId,
      folderPath,
      status: watchedFolder.status,
      fileCount: watchedFolder.fileCount,
      syncedCount: watchedFolder.fileCount,
      errorCount: 0,
    };

    this.sendToRenderer('project-sync-status', status);
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(ext: string): string {
    const mimeTypes: { [key: string]: string } = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.zip': 'application/zip',
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Get all watched folders for a project
   */
  getProjectFolders(projectId: number): WatchedProjectFolder[] {
    const folders: WatchedProjectFolder[] = [];

    for (const [key, folder] of this.watchedFolders.entries()) {
      if (folder.projectId === projectId) {
        folders.push(folder);
      }
    }

    return folders;
  }

  /**
   * Stop watching all folders for a project
   */
  async stopWatchingProject(projectId: number) {
    const folders = this.getProjectFolders(projectId);

    for (const folder of folders) {
      await this.stopWatching(folder.projectId, folder.folderId);
    }
  }
}

export const projectSyncService = new ProjectSyncService();
