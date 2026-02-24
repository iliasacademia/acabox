import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { APIclient, getCsrfToken, checkLogin } from './apiClient';
import { IPC_CHANNELS } from './shared/types';
import FormData from 'form-data';
import { defaultLogger as logger } from './utils/logger';
import Store from 'electron-store';
import { calculateChecksum } from './utils/checksum';

/**
 * Validates that a file path is within the allowed base directory
 * Prevents path traversal attacks including sibling directory access
 */
export function validatePath(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  const relativePath = path.relative(resolvedBase, resolvedTarget);

  // Reject if path starts with '..' (parent directory) or is absolute
  // This prevents both parent and sibling directory traversal
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * Get MIME type from file extension
 */
export function getMimeType(ext: string): string {
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

interface WatchedProjectFolder {
  projectId: number;
  folderId: number;
  folderPath: string;
  watcher: chokidar.FSWatcher | null;
  status: 'idle' | 'syncing' | 'synced' | 'error';
  fileCount: number;
  lastSync: string | null;
  manuscriptPath?: string;
  filePath?: string; // V2: single file watching mode (when set, only this file is watched)
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

interface WatchedProjectFile {
  projectId: number;
  filePath: string;
  watcher: chokidar.FSWatcher | null;
  status: 'idle' | 'syncing' | 'synced' | 'error';
  lastSync: string | null;
}

interface ProjectSyncState {
  folders: Array<{
    projectId: number;
    folderId: number;
    folderPath: string;
    manuscriptPath?: string;
    filePath?: string;
  }>;
  files?: Array<{
    projectId: number;
    filePath: string;
  }>;
}

export class ProjectSyncService {
  private watchedFolders: Map<string, WatchedProjectFolder> = new Map();
  private watchedFiles: Map<string, WatchedProjectFile> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private _store: Store<ProjectSyncState> | null = null;

  private get store(): Store<ProjectSyncState> {
    if (!this._store) {
      this._store = new Store<ProjectSyncState>({
        name: app.isPackaged ? 'project-sync-state' : 'project-sync-state-dev',
      });
    }
    return this._store;
  }

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private sendToRenderer(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Persist watched folders to disk
   */
  private persistState() {
    const folders = Array.from(this.watchedFolders.values()).map(f => ({
      projectId: f.projectId,
      folderId: f.folderId,
      folderPath: f.folderPath,
      manuscriptPath: f.manuscriptPath,
      filePath: f.filePath,
    }));
    const files = Array.from(this.watchedFiles.values()).map(f => ({
      projectId: f.projectId,
      filePath: f.filePath,
    }));
    this.store.set('folders', folders);
    this.store.set('files', files);
    logger.debug(`[ProjectSync] Persisted ${folders.length} folders and ${files.length} files to disk`);
  }

  /**
   * Initialize project sync service on app startup
   * Restores watchers for all persisted folders and performs startup sync
   */
  async initialize() {
    logger.debug('[ProjectSync] Initializing project sync service...');

    // Load persisted folders
    const state = this.store.get('folders', []);
    logger.debug(`[ProjectSync] Found ${state.length} persisted folders`);

    // Check if user is logged in
    let isLoggedIn = false;
    try {
      isLoggedIn = await checkLogin();
    } catch (error) {
      logger.warn('[ProjectSync] Failed to check login status, skipping initialization:', error);
    }
    if (!isLoggedIn) {
      logger.debug('[ProjectSync] User not logged in, skipping initialization');
      return;
    }

    // Validate and restore watchers for each folder
    const validatedFolders: Array<{
      projectId: number;
      folderId: number;
      folderPath: string;
      manuscriptPath?: string;
      filePath?: string;
    }> = [];

    for (const folder of state) {
      try {
        // For file-mode, check the file exists; for folder-mode, check the folder
        const pathToCheck = folder.filePath || folder.folderPath;
        if (!fs.existsSync(pathToCheck)) {
          logger.warn(`[ProjectSync] Local path no longer exists: ${pathToCheck}`);
          continue;
        }

        validatedFolders.push(folder);

        // Start watcher (without performing initial sync yet)
        if (folder.filePath) {
          await this.startWatchingFolderFileOnly(
            folder.projectId,
            folder.folderId,
            folder.folderPath,
            folder.filePath
          );
        } else {
          await this.startWatchingOnly(
            folder.projectId,
            folder.folderId,
            folder.folderPath,
            folder.manuscriptPath
          );
        }

        logger.debug(
          `[ProjectSync] Restored watcher for project ${folder.projectId}, folder ${folder.folderId}`
        );
      } catch (error) {
        logger.error(`[ProjectSync] Error restoring watcher for folder ${folder.folderPath}:`, error);
      }
    }

    // Update persisted state to only include valid folders
    if (validatedFolders.length !== state.length) {
      this.store.set('folders', validatedFolders);
      logger.debug(`[ProjectSync] Updated persisted state: ${validatedFolders.length} valid folders`);
    }

    // Restore file watchers from persisted state
    const fileState = this.store.get('files', []);
    logger.debug(`[ProjectSync] Found ${fileState.length} persisted files`);

    const validatedFiles: Array<{ projectId: number; filePath: string }> = [];

    for (const file of fileState) {
      try {
        if (!fs.existsSync(file.filePath)) {
          logger.warn(`[ProjectSync] Standalone file no longer exists: ${file.filePath}`);
          continue;
        }

        validatedFiles.push(file);

        // Start watcher without initial upload
        await this.startWatchingFileOnly(file.projectId, file.filePath);
        logger.debug(`[ProjectSync] Restored file watcher for project ${file.projectId}, file ${file.filePath}`);
      } catch (error) {
        logger.error(`[ProjectSync] Error restoring file watcher for ${file.filePath}:`, error);
      }
    }

    if (validatedFiles.length !== fileState.length) {
      this.store.set('files', validatedFiles);
      logger.debug(`[ProjectSync] Updated persisted file state: ${validatedFiles.length} valid files`);
    }

    // Try to restore any folders from backend that aren't in local state
    // This handles new machine login or cleared app data scenarios
    await this.restoreFoldersFromBackend();

    // Get all currently watched folders for startup sync (includes newly restored ones)
    const allWatchedFolders = Array.from(this.watchedFolders.values());

    // Perform startup sync for each watched folder (async, non-blocking)
    if (allWatchedFolders.length > 0) {
      logger.debug(`[ProjectSync] Starting async startup sync for ${allWatchedFolders.length} folders`);

      // Don't await - let startup sync happen in background
      Promise.all(
        allWatchedFolders.map(folder =>
          (folder.filePath
            ? this.performStartupFileSync(folder.projectId, folder.folderId, folder.filePath)
            : this.performStartupSync(folder.projectId, folder.folderId, folder.folderPath, folder.manuscriptPath)
          ).catch(error => {
            logger.error(
              `[ProjectSync] Startup sync failed for project ${folder.projectId}, folder ${folder.folderId}:`,
              error
            );
          })
        )
      ).then(() => {
        logger.debug('[ProjectSync] All folder startup syncs complete');
      });
    }

    // Perform startup sync for standalone files (async, non-blocking)
    const allWatchedFiles = Array.from(this.watchedFiles.values());
    if (allWatchedFiles.length > 0) {
      logger.debug(`[ProjectSync] Starting async startup sync for ${allWatchedFiles.length} standalone files`);

      Promise.all(
        allWatchedFiles.map(file =>
          this.performStartupSyncForFile(file.projectId, file.filePath).catch(error => {
            logger.error(
              `[ProjectSync] Startup sync failed for project ${file.projectId}, file ${file.filePath}:`,
              error
            );
          })
        )
      ).then(() => {
        logger.debug('[ProjectSync] All file startup syncs complete');
      });
    }

    logger.debug('[ProjectSync] Initialization complete (startup sync running in background)');
  }

  /**
   * Start watching a project folder and sync files
   */
  async startWatching(projectId: number, folderId: number, folderPath: string, manuscriptPath?: string) {
    const key = `${projectId}-${folderId}`;

    logger.debug(`[ProjectSync] Starting to watch folder: ${folderPath} for project ${projectId}`);
    if (manuscriptPath) {
      logger.debug(`[ProjectSync] Manuscript file will be tagged: ${manuscriptPath}`);
    } else {
      logger.debug(`[ProjectSync] No manuscript path provided for this folder`);
    }

    // Check if folder exists
    if (!fs.existsSync(folderPath)) {
      throw new Error('Folder does not exist');
    }

    // Check if already watching
    if (this.watchedFolders.has(key)) {
      logger.debug(`[ProjectSync] Already watching folder ${folderPath} for project ${projectId}`);
      // Update manuscript path if provided
      const existing = this.watchedFolders.get(key);
      if (existing && manuscriptPath) {
        existing.manuscriptPath = manuscriptPath;
        this.persistState(); // Persist updated manuscript path
      }
      return;
    }

    // Perform initial sync of all files
    await this.performInitialSync(projectId, folderId, folderPath, manuscriptPath);

    // Create watcher
    logger.debug(`[ProjectSync] Creating chokidar watcher with config:`);
    logger.debug(`[ProjectSync]   - Folder: ${folderPath}`);
    logger.debug(`[ProjectSync]   - Manuscript: ${manuscriptPath || 'none'}`);
    logger.debug(`[ProjectSync]   - awaitWriteFinish: 2000ms stability`);

    const watcher = chokidar.watch(folderPath, {
      persistent: true,
      ignoreInitial: true, // We already synced existing files
      followSymlinks: true,
      ignored: (filePath: string) => {
        // Validate path to prevent traversal attacks
        if (!validatePath(folderPath, filePath)) {
          logger.warn(`[ProjectSync] Path traversal attempt detected: ${filePath}`);
          return true;
        }

        const basename = path.basename(filePath);
        // Ignore hidden files (starting with .)
        if (basename.startsWith('.')) {
          logger.debug(`[ProjectSync] Ignoring hidden file: ${filePath}`);
          return true;
        }
        // Ignore Word temporary lock files (starting with ~$)
        if (basename.startsWith('~$')) {
          logger.debug(`[ProjectSync] Ignoring temporary Word file: ${filePath}`);
          return true;
        }
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

    // Persist state
    this.persistState();

    // Set up event handlers
    watcher.on('add', (filePath: string) => {
      logger.debug(`[ProjectSync] 🔵 Watcher detected 'add' event: ${filePath}`);
      this.handleFileAdded(projectId, folderId, folderPath, filePath);
    });
    watcher.on('change', (filePath: string) => {
      logger.debug(`[ProjectSync] 🟡 Watcher detected 'change' event: ${filePath}`);
      this.handleFileChanged(projectId, folderId, folderPath, filePath);
    });
    watcher.on('unlink', (filePath: string) => {
      logger.debug(`[ProjectSync] 🔴 Watcher detected 'unlink' event: ${filePath}`);
      this.handleFileDeleted(projectId, folderId, folderPath, filePath);
    });
    watcher.on('ready', () => {
      logger.debug(`[ProjectSync] ✅ Watcher is ready and actively watching: ${folderPath}`);
      logger.debug(`[ProjectSync] Watched paths:`, watcher.getWatched());

      // Broadcast watcher status change
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: true,
        status: watchedFolder.status,
      });
    });

    watcher.on('error', (error) => {
      logger.error(`[ProjectSync] ❌ Watcher error for ${folderPath}:`, error);
      watchedFolder.status = 'error';
      this.sendSyncStatus(projectId, folderId, folderPath);

      // Broadcast watcher status change
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: false,
        status: 'error',
      });
    });

    logger.debug(`[ProjectSync] Watcher events registered for ${folderPath}`);
  }

  /**
   * Update the manuscript path for all watched folders of a project
   */
  updateManuscriptPath(projectId: number, manuscriptPath: string): void {
    let updated = false;

    for (const [_key, folder] of this.watchedFolders.entries()) {
      if (folder.projectId === projectId) {
        folder.manuscriptPath = manuscriptPath;
        updated = true;
        logger.debug(`[ProjectSync] Updated manuscriptPath for project ${projectId}: ${manuscriptPath}`);
      }
    }

    if (updated) {
      this.persistState();
    }
  }

  /**
   * Start watching a folder WITHOUT performing initial sync
   * Used during app initialization - sync is handled separately by performStartupSync
   */
  private async startWatchingOnly(projectId: number, folderId: number, folderPath: string, manuscriptPath?: string): Promise<void> {
    const key = `${projectId}-${folderId}`;

    // Check if already watching
    if (this.watchedFolders.has(key)) {
      logger.debug(`[ProjectSync] Already watching folder ${folderPath} for project ${projectId}`);
      return;
    }

    logger.debug(`[ProjectSync] Starting watcher (no initial sync): ${folderPath}`);

    // Create watcher (same config as existing startWatching)
    const watcher = chokidar.watch(folderPath, {
      persistent: true,
      ignoreInitial: true, // Don't fire events for existing files
      followSymlinks: true,
      ignored: (filePath: string) => {
        // Validate path to prevent traversal attacks
        if (!validatePath(folderPath, filePath)) {
          logger.warn(`[ProjectSync] Path traversal attempt detected: ${filePath}`);
          return true;
        }

        const basename = path.basename(filePath);
        // Ignore hidden files (starting with .)
        if (basename.startsWith('.')) {
          logger.debug(`[ProjectSync] Ignoring hidden file: ${filePath}`);
          return true;
        }
        // Ignore Word temporary lock files (starting with ~$)
        if (basename.startsWith('~$')) {
          logger.debug(`[ProjectSync] Ignoring temporary Word file: ${filePath}`);
          return true;
        }
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

    // Set up event handlers (same as existing startWatching)
    watcher.on('add', (filePath: string) => {
      logger.debug(`[ProjectSync] 🔵 Watcher detected 'add' event: ${filePath}`);
      this.handleFileAdded(projectId, folderId, folderPath, filePath);
    });

    watcher.on('change', (filePath: string) => {
      logger.debug(`[ProjectSync] 🟡 Watcher detected 'change' event: ${filePath}`);
      this.handleFileChanged(projectId, folderId, folderPath, filePath);
    });

    watcher.on('unlink', (filePath: string) => {
      logger.debug(`[ProjectSync] 🔴 Watcher detected 'unlink' event: ${filePath}`);
      this.handleFileDeleted(projectId, folderId, folderPath, filePath);
    });

    watcher.on('ready', () => {
      logger.debug(`[ProjectSync] ✅ Watcher is ready and actively watching: ${folderPath}`);
      logger.debug(`[ProjectSync] Watched paths:`, watcher.getWatched());

      // Broadcast watcher status change
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: true,
        status: watchedFolder.status,
      });
    });

    watcher.on('error', (error) => {
      logger.error(`[ProjectSync] ❌ Watcher error for ${folderPath}:`, error);
      watchedFolder.status = 'error';
      this.sendSyncStatus(projectId, folderId, folderPath);

      // Broadcast watcher status change
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: false,
        status: 'error',
      });
    });

    logger.debug(`[ProjectSync] Watcher started: ${folderPath}`);
  }

  /**
   * Fetch all project folders from backend and restore sync for those that exist locally
   * This handles the case where user logs in on a new machine or after clearing app data
   */
  private async restoreFoldersFromBackend(): Promise<void> {
    try {
      const client = await APIclient();

      // 1. Fetch all user's projects
      const projectsResponse = await client.get('v0/co_scientist/projects');
      const projects = projectsResponse.data?.projects || [];

      if (projects.length === 0) {
        logger.debug('[ProjectSync] No projects found on backend');
        return;
      }

      logger.debug(`[ProjectSync] Found ${projects.length} projects on backend, checking for folders...`);

      // 2. Fetch folders for each project
      let restoredCount = 0;
      for (const project of projects) {
        try {
          const foldersResponse = await client.get(`v0/co_scientist/projects/${project.id}/folders`);
          const folders = foldersResponse.data?.folders || [];

          for (const folder of folders) {
            // 3. Check if the local folder still exists
            if (!fs.existsSync(folder.folder_path)) {
              logger.debug(`[ProjectSync] Skipping folder (not on local machine): ${folder.folder_path}`);
              continue;
            }

            // 4. Check if already watching
            const key = `${project.id}-${folder.id}`;
            if (this.watchedFolders.has(key)) {
              continue;
            }

            // 5. Start watching this folder
            await this.startWatchingOnly(project.id, folder.id, folder.folder_path);
            restoredCount++;
            logger.debug(`[ProjectSync] Restored folder from backend: ${folder.folder_path}`);
          }
        } catch (error) {
          logger.error(`[ProjectSync] Failed to fetch folders for project ${project.id}:`, error);
        }
      }

      if (restoredCount > 0) {
        this.persistState();
        logger.info(`[ProjectSync] Restored ${restoredCount} folders from backend`);
      } else {
        logger.debug('[ProjectSync] No new folders to restore from backend');
      }
    } catch (error) {
      logger.error('[ProjectSync] Failed to restore folders from backend:', error);
    }
  }

  /**
   * Start watching a single file and sync it to the project (V2 onboarding)
   */
  async startWatchingFolderFile(projectId: number, folderId: number, folderPath: string, filePath: string) {
    const key = `${projectId}-${folderId}`;

    logger.debug(`[ProjectSync] Starting to watch file: ${filePath} for project ${projectId}`);

    if (!fs.existsSync(filePath)) {
      throw new Error('File does not exist');
    }

    if (this.watchedFolders.has(key)) {
      logger.debug(`[ProjectSync] Already watching for project ${projectId}`);
      return;
    }

    // Initial sync: upload just this one file
    await this.syncFileToProject(projectId, null, null, filePath, filePath);

    // Notify renderer about initial sync completion
    this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, {
      projectId,
      folderId,
      filePath: path.relative(folderPath, filePath),
      action: 'initial-sync',
    });

    // Watch the single file with chokidar
    const watcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    });

    const watchedFolder: WatchedProjectFolder = {
      projectId,
      folderId,
      folderPath,
      watcher,
      status: 'synced',
      fileCount: 1,
      lastSync: new Date().toISOString(),
      manuscriptPath: filePath,
      filePath, // marks this as file-mode
    };

    this.watchedFolders.set(key, watchedFolder);
    this.persistState();

    watcher.on('change', () => this.handleFileChanged(projectId, folderId, folderPath, filePath));
    watcher.on('unlink', () => this.handleFileDeleted(projectId, folderId, folderPath, filePath));
    watcher.on('ready', () => {
      logger.debug(`[ProjectSync] File watcher ready: ${filePath}`);
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: true,
        status: watchedFolder.status,
      });
    });
    watcher.on('error', (error) => {
      logger.error(`[ProjectSync] File watcher error for ${filePath}:`, error);
      watchedFolder.status = 'error';
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: false,
        status: 'error',
      });
    });

    logger.debug(`[ProjectSync] File watcher started: ${filePath}`);
  }

  /**
   * Start watching a single file WITHOUT performing initial sync
   * Used during app initialization - sync is handled separately by performStartupFileSync
   */
  private async startWatchingFolderFileOnly(projectId: number, folderId: number, folderPath: string, filePath: string): Promise<void> {
    const key = `${projectId}-${folderId}`;

    if (this.watchedFolders.has(key)) {
      logger.debug(`[ProjectSync] Already watching file for project ${projectId}`);
      return;
    }

    logger.debug(`[ProjectSync] Starting file watcher (no initial sync): ${filePath}`);

    const watcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    });

    const watchedFolder: WatchedProjectFolder = {
      projectId,
      folderId,
      folderPath,
      watcher,
      status: 'idle',
      fileCount: 1,
      lastSync: null,
      manuscriptPath: filePath,
      filePath,
    };

    this.watchedFolders.set(key, watchedFolder);

    watcher.on('change', () => this.handleFileChanged(projectId, folderId, folderPath, filePath));
    watcher.on('unlink', () => this.handleFileDeleted(projectId, folderId, folderPath, filePath));
    watcher.on('ready', () => {
      logger.debug(`[ProjectSync] File watcher ready: ${filePath}`);
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: true,
        status: watchedFolder.status,
      });
    });
    watcher.on('error', (error) => {
      logger.error(`[ProjectSync] File watcher error for ${filePath}:`, error);
      watchedFolder.status = 'error';
      this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
        projectId,
        folderId,
        watcherActive: false,
        status: 'error',
      });
    });

    logger.debug(`[ProjectSync] File watcher started (no sync): ${filePath}`);
  }

  /**
   * Perform startup sync for a single-file watched project
   * Checks if the file changed while the app was closed using checksums
   */
  private async performStartupFileSync(
    projectId: number,
    folderId: number,
    filePath: string,
  ): Promise<void> {
    const key = `${projectId}-${folderId}`;
    const folder = this.watchedFolders.get(key);
    if (!folder) return;

    logger.debug(`[ProjectSync-Startup] Starting file sync for project ${projectId}, file ${filePath}`);
    folder.status = 'syncing';
    this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_BEGIN, {
      projectId,
      folderId,
      message: 'Checking for changes...',
    });

    try {
      if (!fs.existsSync(filePath)) {
        logger.warn(`[ProjectSync-Startup] File no longer exists: ${filePath}`);
        folder.status = 'error';
        this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_COMPLETE, {
          projectId,
          folderId,
          status: 'error',
          error: 'File no longer exists',
        });
        return;
      }

      // Get backend file list with checksums
      const client = await APIclient();
      const filesResponse = await client.get(`v0/co_scientist/projects/${projectId}/files`);
      const backendFiles = filesResponse.data?.files || [];

      const remoteFile = backendFiles.find((f: any) => f.file_path === filePath);

      if (!remoteFile) {
        // File not on backend yet, upload it
        logger.debug(`[ProjectSync-Startup] File not on backend, uploading: ${filePath}`);
        await this.syncFileToProject(projectId, null, null, filePath, filePath);
      } else {
        // Compare checksums
        const localChecksum = await calculateChecksum(filePath);
        if (localChecksum !== remoteFile.checksum) {
          logger.debug(`[ProjectSync-Startup] File changed, re-uploading: ${filePath}`);
          await this.syncFileToProject(projectId, null, null, filePath, filePath);
        } else {
          logger.debug(`[ProjectSync-Startup] File unchanged: ${filePath}`);
        }
      }

      folder.status = 'synced';
      folder.lastSync = new Date().toISOString();
      this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_COMPLETE, {
        projectId,
        folderId,
        status: 'completed',
        message: 'File up to date',
      });
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.status === 404) {
        logger.warn(`[ProjectSync-Startup] Project ${projectId} no longer exists (404), stopping watcher`);
        await this.stopWatching(projectId, folderId);
        return;
      }

      logger.error(`[ProjectSync-Startup] File sync error for project ${projectId}:`, error);
      folder.status = 'error';
      this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_COMPLETE, {
        projectId,
        folderId,
        status: 'error',
        error: error.message,
      });
    }
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

    // Persist state
    this.persistState();

    // Broadcast watcher status change
    this.sendToRenderer(IPC_CHANNELS.PROJECT_WATCHER_STATUS_CHANGED, {
      projectId,
      folderId,
      watcherActive: false,
      status: 'idle',
    });

    logger.debug(`[ProjectSync] Stopped watching folder for project ${projectId}, folder ${folderId}`);
  }

  /**
   * Perform smart startup sync - only uploads files that changed while app was closed
   * Based on SyncService's performStartupSync pattern
   */
  private async performStartupSync(
    projectId: number,
    folderId: number,
    folderPath: string,
    manuscriptPath?: string
  ): Promise<void> {
    const key = `${projectId}-${folderId}`;
    const folder = this.watchedFolders.get(key);
    if (!folder) return;

    logger.debug(`[ProjectSync-Startup] Starting for project ${projectId}, folder ${folderId}`);
    folder.status = 'syncing';
    this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_BEGIN, {
      projectId,
      folderId,
      message: 'Checking for changes...',
    });

    try {
      // Get all local files
      const localFiles = this.getAllFiles(folderPath);
      logger.debug(`[ProjectSync-Startup] Found ${localFiles.length} local files`);

      if (localFiles.length === 0) {
        logger.debug(`[ProjectSync-Startup] No local files found`);
        folder.status = 'idle';
        this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_COMPLETE, {
          projectId,
          folderId,
          status: 'completed',
          message: 'No files to sync',
        });
        return;
      }

      // Get backend file list with checksums
      const client = await APIclient();
      const filesResponse = await client.get(`v0/co_scientist/projects/${projectId}/files`);
      const backendFiles = filesResponse.data?.files || [];

      // Build remote file map: relativePath -> { checksum, id }
      const remoteFileMap = new Map<string, { checksum: string; id: number }>();
      for (const file of backendFiles) {
        // file.file_path is the relative path from project root
        remoteFileMap.set(file.file_path, {
          checksum: file.checksum,
          id: file.id,
        });
      }

      logger.debug(`[ProjectSync-Startup] Found ${backendFiles.length} files on backend`);

      // Filter files that need syncing (new or changed)
      const filesToSync: Array<{ path: string; reason: 'new' | 'changed' }> = [];

      for (const filePath of localFiles) {
        const relativePath = path.relative(folderPath, filePath);
        const remoteFile = remoteFileMap.get(relativePath);

        if (!remoteFile) {
          // File doesn't exist on backend
          logger.debug(`[ProjectSync-Startup] New file: ${relativePath}`);
          filesToSync.push({ path: filePath, reason: 'new' });
          continue;
        }

        // Calculate local checksum
        const localChecksum = await calculateChecksum(filePath);

        if (localChecksum !== remoteFile.checksum) {
          // File changed since last sync
          logger.debug(
            `[ProjectSync-Startup] Changed file: ${relativePath} (local: ${localChecksum}, remote: ${remoteFile.checksum})`
          );
          filesToSync.push({ path: filePath, reason: 'changed' });
        }
        // else: checksums match, skip
      }

      logger.debug(`[ProjectSync-Startup] ${filesToSync.length} files need syncing`);

      if (filesToSync.length === 0) {
        folder.status = 'synced';
        this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_COMPLETE, {
          projectId,
          folderId,
          status: 'completed',
          message: 'All files up to date',
        });
        return;
      }

      // Sync files in parallel chunks (5 at a time)
      let syncedCount = 0;
      let errorCount = 0;
      const chunkSize = 5;

      for (let i = 0; i < filesToSync.length; i += chunkSize) {
        const chunk = filesToSync.slice(i, i + chunkSize);

        // Send progress update
        this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_PROGRESS, {
          projectId,
          folderId,
          current: i + 1,
          total: filesToSync.length,
        });

        // Upload all files in this chunk in parallel
        const results = await Promise.allSettled(
          chunk.map(({ path: filePath }) =>
            this.syncFileToProject(projectId, folderId, folderPath, filePath, manuscriptPath)
          )
        );

        // Process results
        let projectNotFound = false;
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            syncedCount++;
          } else {
            if (result.reason?.status === 404) {
              projectNotFound = true;
            }
            logger.error(`[ProjectSync-Startup] Failed to sync ${chunk[index].path}:`, result.reason);
            errorCount++;
          }
        });

        if (projectNotFound) {
          logger.warn(`[ProjectSync-Startup] Project ${projectId} no longer exists (404), stopping watcher`);
          folder.status = 'idle';
          await this.stopWatching(projectId, folderId);
          return;
        }
      }

      folder.status = 'synced';
      folder.lastSync = new Date().toISOString();
      this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_COMPLETE, {
        projectId,
        folderId,
        status: 'completed',
        message: `Synced ${syncedCount} files`,
        syncedCount,
        errorCount,
      });

      logger.debug(`[ProjectSync-Startup] Complete: ${syncedCount} synced, ${errorCount} errors`);
    } catch (error: any) {
      // If project no longer exists (404), stop watching and clean up
      if (error?.response?.status === 404 || error?.status === 404) {
        logger.warn(`[ProjectSync-Startup] Project ${projectId} no longer exists (404), stopping watcher`);
        await this.stopWatching(projectId, folderId);
        return;
      }

      logger.error(`[ProjectSync-Startup] Error for project ${projectId}, folder ${folderId}:`, error);
      folder.status = 'error';
      this.sendToRenderer(IPC_CHANNELS.PROJECT_STARTUP_SYNC_COMPLETE, {
        projectId,
        folderId,
        status: 'error',
        error: error.message,
      });
    }
  }

  /**
   * Perform initial sync of all files in the folder
   */
  private async performInitialSync(projectId: number, folderId: number, folderPath: string, manuscriptPath?: string) {
    const key = `${projectId}-${folderId}`;
    const watchedFolder = this.watchedFolders.get(key);

    logger.debug(`[ProjectSync] Starting initial sync for ${folderPath}`);
    if (manuscriptPath) {
      logger.debug(`[ProjectSync] Will tag manuscript: ${manuscriptPath}`);
    }

    if (watchedFolder) {
      watchedFolder.status = 'syncing';
      this.sendSyncStatus(projectId, folderId, folderPath);
    }

    try {
      // Get all files in the folder
      const files = this.getAllFiles(folderPath);
      logger.debug(`[ProjectSync] Found ${files.length} files to sync`);

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
            logger.debug(`[ProjectSync] Synced ${syncedCount}/${files.length}: ${filePath}`);
          } else {
            logger.error(`[ProjectSync] Failed to sync ${filePath}:`, result.reason);
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

      logger.debug(`[ProjectSync] Initial sync complete: ${syncedCount} synced, ${errorCount} errors`);

      // After initial sync, if we synced a manuscript file, notify the renderer
      // so it can start polling for the automatic review
      if (manuscriptPath) {
        const relativePath = path.relative(folderPath, manuscriptPath);
        logger.debug(`[ProjectSync] Initial sync complete - notifying renderer about manuscript: ${relativePath}`);
        const eventData = {
          projectId,
          folderId,
          filePath: relativePath,
          action: 'initial-sync',
        };
        logger.debug(`[ProjectSync] Sending initial-sync event:`, JSON.stringify(eventData, null, 2));
        this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, eventData);
        logger.debug(`[ProjectSync] ✓ Initial-sync event sent to renderer`);
      } else {
        logger.debug(`[ProjectSync] ⚠ No manuscriptPath provided - not sending initial-sync event`);
      }
    } catch (error) {
      logger.error(`[ProjectSync] Initial sync failed:`, error);
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
          // Skip Word temporary lock files (~$filename.docx)
          if (item.startsWith('~$')) continue;

          const fullPath = path.join(currentPath, item);

          // Validate path to prevent traversal attacks
          if (!validatePath(folderPath, fullPath)) {
            logger.warn(`[ProjectSync] Path traversal attempt detected during file enumeration: ${fullPath}`);
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
        logger.error(`[ProjectSync] Error traversing ${currentPath}:`, error);
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
    folderId: number | null,
    folderPath: string | null,
    filePath: string,
    manuscriptPath?: string
  ): Promise<void> {
    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    let relPath: string;
    if (folderPath) {
      // Validate path before processing
      if (!validatePath(folderPath, filePath)) {
        throw new Error('Invalid file path: traversal attempt detected');
      }

      // Get relative path
      relPath = path.relative(folderPath, filePath);

      // Validate relative path doesn't contain dangerous characters
      if (/[<>"|?*\x00-\x1f]/.test(relPath)) {
        throw new Error('Invalid file path: contains illegal characters');
      }
    } else {
      relPath = filePath;
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    const size = stats.size;

    // Validate file size (e.g., max 500MB)
    const MAX_FILE_SIZE = 500 * 1024 * 1024;
    if (size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${size} bytes exceeds ${MAX_FILE_SIZE} bytes`);
    }

    // Determine MIME type
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeType(ext);

    // Validate MIME type is from allowed list
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
      'image/jpeg',
      'image/png',
      'image/gif',
      'application/zip',
      'application/octet-stream',
    ];
    if (!allowedMimeTypes.includes(mimeType)) {
      throw new Error(`Invalid MIME type: ${mimeType}`);
    }

    // Check if this file is the manuscript
    const isManuscript = manuscriptPath && filePath === manuscriptPath;

    // Create form data
    const formData = new FormData();
    if (folderId != null) {
      formData.append('project_root_id', folderId.toString());
    }
    formData.append('rel_path', relPath);
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
      const error: any = new Error(`Failed to sync file: ${response.status} - ${JSON.stringify(response.data)}`);
      error.status = response.status;
      throw error;
    }

    logger.debug(`[ProjectSync] File synced: ${relPath} (uploaded: ${response.data.uploaded})`);
  }

  /**
   * Handle file added
   */
  private async handleFileAdded(projectId: number, folderId: number, folderPath: string, filePath: string) {
    logger.debug(`[ProjectSync] File added: ${filePath}`);
    try {
      const key = `${projectId}-${folderId}`;
      const watchedFolder = this.watchedFolders.get(key);
      const manuscriptPath = watchedFolder?.manuscriptPath;

      // Set status to syncing and broadcast
      if (watchedFolder) {
        watchedFolder.status = 'syncing';
        this.sendSyncStatus(projectId, folderId, folderPath);
      }

      await this.syncFileToProject(projectId, folderId, folderPath, filePath, manuscriptPath);

      // Set status to synced and broadcast
      if (watchedFolder) {
        watchedFolder.status = 'synced';
        watchedFolder.lastSync = new Date().toISOString();
        this.sendSyncStatus(projectId, folderId, folderPath);
      }

      this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, {
        projectId,
        folderId,
        filePath: path.relative(folderPath, filePath),
        action: 'added',
      });
    } catch (error) {
      logger.error(`[ProjectSync] Failed to sync added file:`, error);
    }
  }

  /**
   * Handle file changed
   */
  private async handleFileChanged(projectId: number, folderId: number, folderPath: string, filePath: string) {
    logger.debug('========================================');
    logger.debug(`[ProjectSync] File changed event detected`);
    logger.debug(`[ProjectSync]   Full path: ${filePath}`);
    logger.debug(`[ProjectSync]   Project ID: ${projectId}`);
    logger.debug(`[ProjectSync]   Folder ID: ${folderId}`);
    logger.debug(`[ProjectSync]   Base folder: ${folderPath}`);

    try {
      const key = `${projectId}-${folderId}`;
      const watchedFolder = this.watchedFolders.get(key);
      const manuscriptPath = watchedFolder?.manuscriptPath;
      const isStandaloneFile = !!watchedFolder?.filePath;
      const relativePath = path.relative(folderPath, filePath);

      logger.debug(`[ProjectSync]   Relative path: ${relativePath}`);
      logger.debug(`[ProjectSync]   Manuscript path: ${manuscriptPath || 'none'}`);
      logger.debug(`[ProjectSync]   Is manuscript: ${filePath === manuscriptPath}`);

      // Set status to syncing and broadcast
      if (watchedFolder) {
        watchedFolder.status = 'syncing';
        this.sendSyncStatus(projectId, folderId, folderPath);
      }

      logger.debug(`[ProjectSync] Syncing file to backend...`);
      await this.syncFileToProject(
        projectId,
        isStandaloneFile ? null : folderId,
        isStandaloneFile ? null : folderPath,
        filePath,
        manuscriptPath
      );
      logger.debug(`[ProjectSync] ✓ File synced successfully to backend`);

      // Set status to synced and broadcast
      if (watchedFolder) {
        watchedFolder.status = 'synced';
        watchedFolder.lastSync = new Date().toISOString();
        this.sendSyncStatus(projectId, folderId, folderPath);
      }

      const eventData = {
        projectId,
        folderId,
        filePath: relativePath,
        action: 'changed',
      };

      logger.debug(`[ProjectSync] Sending IPC_CHANNELS.PROJECT_FILE_SYNCED event to renderer:`, eventData);
      this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, eventData);
      logger.debug(`[ProjectSync] ✓ Event sent to renderer`);
    } catch (error) {
      logger.error(`[ProjectSync] ✗ Failed to sync changed file:`, error);
    }
    logger.debug('========================================');
  }

  /**
   * Handle file deleted
   */
  private async handleFileDeleted(projectId: number, folderId: number, folderPath: string, filePath: string) {
    logger.debug(`[ProjectSync] File deleted: ${filePath}`);
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

  // ===========================================================================
  // Standalone file watching (no folder required)
  // ===========================================================================

  /**
   * Start watching a standalone file and sync it to the project
   * Validates file exists, performs initial upload, starts chokidar watcher
   */
  async startWatchingFile(projectId: number, filePath: string): Promise<void> {
    const key = `${projectId}-${filePath}`;

    logger.debug(`[ProjectSync] Starting to watch file: ${filePath} for project ${projectId}`);

    if (!fs.existsSync(filePath)) {
      throw new Error('File does not exist');
    }

    if (this.watchedFiles.has(key)) {
      logger.debug(`[ProjectSync] Already watching file ${filePath} for project ${projectId}`);
      return;
    }

    // Perform initial upload
    await this.syncStandaloneFile(projectId, filePath);

    // Start watching the file
    await this.startWatchingFileOnly(projectId, filePath);

    // Persist state
    this.persistState();

    // Notify renderer about the initial sync
    this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, {
      projectId,
      filePath: path.basename(filePath),
      action: 'initial-sync',
    });

    logger.debug(`[ProjectSync] File watcher started and initial upload complete: ${filePath}`);
  }

  /**
   * One-time sync of a file to a project without starting a watcher.
   * Used to pre-upload a file before switching manuscript.
   */
  async syncFileOnce(projectId: number, filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error('File does not exist');
    }
    await this.syncFileToProject(projectId, null, null, filePath, undefined);
  }

  /**
   * Start watching a file WITHOUT performing initial upload
   * Used during app initialization - sync is handled separately by performStartupSyncForFile
   */
  private async startWatchingFileOnly(projectId: number, filePath: string): Promise<void> {
    const key = `${projectId}-${filePath}`;

    if (this.watchedFiles.has(key)) {
      logger.debug(`[ProjectSync] Already watching file ${filePath} for project ${projectId}`);
      return;
    }

    logger.debug(`[ProjectSync] Starting file watcher (no initial upload): ${filePath}`);

    const watcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    const watchedFile: WatchedProjectFile = {
      projectId,
      filePath,
      watcher,
      status: 'idle',
      lastSync: null,
    };

    this.watchedFiles.set(key, watchedFile);

    watcher.on('change', async () => {
      logger.debug(`[ProjectSync] Standalone file changed: ${filePath}`);
      try {
        watchedFile.status = 'syncing';
        await this.syncStandaloneFile(projectId, filePath);
        watchedFile.status = 'synced';
        watchedFile.lastSync = new Date().toISOString();

        this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, {
          projectId,
          filePath: path.basename(filePath),
          action: 'changed',
        });
      } catch (error) {
        logger.error(`[ProjectSync] Failed to sync standalone file on change:`, error);
        watchedFile.status = 'error';
      }
    });

    watcher.on('unlink', () => {
      logger.debug(`[ProjectSync] Standalone file deleted: ${filePath}`);
      this.sendToRenderer(IPC_CHANNELS.PROJECT_FILE_SYNCED, {
        projectId,
        filePath: path.basename(filePath),
        action: 'deleted',
      });
    });

    watcher.on('error', (error) => {
      logger.error(`[ProjectSync] File watcher error for ${filePath}:`, error);
      watchedFile.status = 'error';
    });

    logger.debug(`[ProjectSync] File watcher started: ${filePath}`);
  }

  /**
   * Stop watching a standalone file
   */
  async stopWatchingFile(projectId: number, filePath: string): Promise<void> {
    const key = `${projectId}-${filePath}`;
    const watchedFile = this.watchedFiles.get(key);

    if (!watchedFile) return;

    if (watchedFile.watcher) {
      await watchedFile.watcher.close();
    }

    this.watchedFiles.delete(key);
    this.persistState();

    logger.debug(`[ProjectSync] Stopped watching file for project ${projectId}: ${filePath}`);
  }

  /**
   * Upload a standalone file to the project
   * Uses POST /v0/co_scientist/projects/{projectId}/files with:
   * - No project_root_id
   * - rel_path = filename only
   * - is_manuscript = 'true'
   */
  private async syncStandaloneFile(projectId: number, filePath: string): Promise<void> {
    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    const stats = fs.statSync(filePath);
    const size = stats.size;

    const MAX_FILE_SIZE = 500 * 1024 * 1024;
    if (size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${size} bytes exceeds ${MAX_FILE_SIZE} bytes`);
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeType(ext);

    const formData = new FormData();
    formData.append('rel_path', filePath);
    formData.append('mime_type', mimeType);
    formData.append('size', size.toString());
    formData.append('is_manuscript', 'true');
    formData.append('file', fs.createReadStream(filePath));

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
      const error: any = new Error(`Failed to sync standalone file: ${response.status} - ${JSON.stringify(response.data)}`);
      error.status = response.status;
      throw error;
    }

    logger.debug(`[ProjectSync] Standalone file synced: ${path.basename(filePath)} (uploaded: ${response.data.uploaded})`);
  }

  /**
   * Upload a supporting material file to the project
   * Uses POST /v0/co_scientist/projects/{projectId}/files with:
   * - No project_root_id (standalone file)
   * - rel_path = absolute file path
   * - is_manuscript = false (or omitted)
   * - tag = reference | note | proposal | other (API uses 'tag' field)
   */
  async uploadSupportingMaterial(
    projectId: number,
    filePath: string,
    category: string = 'reference'
  ): Promise<{ success: boolean; file?: any; error?: string }> {
    try {
      const client = await APIclient();
      const csrfToken = await getCsrfToken();

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const stats = fs.statSync(filePath);
      const size = stats.size;

      const MAX_FILE_SIZE = 500 * 1024 * 1024;
      if (size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${size} bytes exceeds ${MAX_FILE_SIZE} bytes`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = getMimeType(ext);

      const formData = new FormData();
      formData.append('rel_path', filePath);
      formData.append('mime_type', mimeType);
      formData.append('size', size.toString());
      formData.append('is_manuscript', 'false'); // Supporting materials are not manuscripts
      formData.append('tag', category); // API uses 'tag' field instead of 'category'
      formData.append('file', fs.createReadStream(filePath));

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
        const error = `Failed to upload supporting material: ${response.status} - ${JSON.stringify(response.data)}`;
        logger.error(`[ProjectSync] ${error}`);
        return { success: false, error };
      }

      logger.debug(`[ProjectSync] Supporting material uploaded: ${path.basename(filePath)}`);
      return { success: true, file: response.data };
    } catch (error: any) {
      logger.error(`[ProjectSync] Error uploading supporting material:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * On app restart, check if a standalone file changed (checksum vs backend) and re-upload if needed
   */
  private async performStartupSyncForFile(projectId: number, filePath: string): Promise<void> {
    const key = `${projectId}-${filePath}`;
    const watchedFile = this.watchedFiles.get(key);
    if (!watchedFile) return;

    logger.debug(`[ProjectSync-Startup] Checking standalone file: ${filePath} for project ${projectId}`);

    try {
      // Get backend file list
      const client = await APIclient();
      const filesResponse = await client.get(`v0/co_scientist/projects/${projectId}/files`);
      const backendFiles = filesResponse.data?.files || [];

      const fileName = path.basename(filePath);
      const remoteFile = backendFiles.find((f: any) => f.file_path === filePath);

      if (!remoteFile) {
        // File not on backend, upload it
        logger.debug(`[ProjectSync-Startup] Standalone file not on backend, uploading: ${fileName}`);
        await this.syncStandaloneFile(projectId, filePath);
        watchedFile.status = 'synced';
        watchedFile.lastSync = new Date().toISOString();
        return;
      }

      // Compare checksums
      const localChecksum = await calculateChecksum(filePath);
      if (localChecksum !== remoteFile.checksum) {
        logger.debug(`[ProjectSync-Startup] Standalone file changed, re-uploading: ${fileName}`);
        await this.syncStandaloneFile(projectId, filePath);
        watchedFile.status = 'synced';
        watchedFile.lastSync = new Date().toISOString();
      } else {
        logger.debug(`[ProjectSync-Startup] Standalone file unchanged: ${fileName}`);
        watchedFile.status = 'synced';
      }
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.status === 404) {
        logger.warn(`[ProjectSync-Startup] Project ${projectId} no longer exists (404), stopping file watcher`);
        await this.stopWatchingFile(projectId, filePath);
        return;
      }

      logger.error(`[ProjectSync-Startup] Error syncing standalone file ${filePath}:`, error);
      watchedFile.status = 'error';
    }
  }

  /**
   * Get all watched folders for a project
   */
  getProjectFolders(projectId: number): WatchedProjectFolder[] {
    const folders: WatchedProjectFolder[] = [];

    for (const [_key, folder] of this.watchedFolders.entries()) {
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

    // Also stop any standalone file watchers for this project
    const fileKeys = Array.from(this.watchedFiles.entries())
      .filter(([_, f]) => f.projectId === projectId)
      .map(([key, _]) => key);

    for (const key of fileKeys) {
      const file = this.watchedFiles.get(key);
      if (file) {
        await this.stopWatchingFile(file.projectId, file.filePath);
      }
    }
  }

  /**
   * Get watcher status for a specific folder
   */
  getWatcherStatus(projectId: number, folderId: number): {
    watcherActive: boolean;
    status: 'idle' | 'syncing' | 'synced' | 'error';
    fileCount: number;
    lastSync: string | null;
  } | null {
    const key = `${projectId}-${folderId}`;
    const folder = this.watchedFolders.get(key);

    if (!folder) {
      return null;
    }

    return {
      watcherActive: folder.watcher !== null,
      status: folder.status,
      fileCount: folder.fileCount,
      lastSync: folder.lastSync,
    };
  }

  /**
   * Get all watched folders (for debugging)
   */
  getAllWatchedFolders(): WatchedProjectFolder[] {
    return Array.from(this.watchedFolders.values());
  }
}

export const projectSyncService = new ProjectSyncService();
