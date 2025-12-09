import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
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
function validatePath(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  const relativePath = path.relative(resolvedBase, resolvedTarget);

  // Reject if path starts with '..' (parent directory) or is absolute
  // This prevents both parent and sibling directory traversal
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
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

interface ProjectSyncState {
  folders: Array<{
    projectId: number;
    folderId: number;
    folderPath: string;
    manuscriptPath?: string;
  }>;
}

class ProjectSyncService {
  private watchedFolders: Map<string, WatchedProjectFolder> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private store = new Store<ProjectSyncState>({ name: 'project-sync-state' });

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
    }));
    this.store.set('folders', folders);
    logger.debug(`[ProjectSync] Persisted ${folders.length} folders to disk`);
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
    }> = [];

    for (const folder of state) {
      try {
        // Check if local folder still exists
        if (!fs.existsSync(folder.folderPath)) {
          logger.warn(`[ProjectSync] Local folder no longer exists: ${folder.folderPath}`);
          continue;
        }

        validatedFolders.push(folder);

        // Start watcher (without performing initial sync yet)
        await this.startWatchingOnly(
          folder.projectId,
          folder.folderId,
          folder.folderPath,
          folder.manuscriptPath
        );

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

    // Perform startup sync for each validated folder (async, non-blocking)
    if (validatedFolders.length > 0) {
      logger.debug(`[ProjectSync] Starting async startup sync for ${validatedFolders.length} folders`);

      // Don't await - let startup sync happen in background
      Promise.all(
        validatedFolders.map(folder =>
          this.performStartupSync(
            folder.projectId,
            folder.folderId,
            folder.folderPath,
            folder.manuscriptPath
          ).catch(error => {
            logger.error(
              `[ProjectSync] Startup sync failed for project ${folder.projectId}, folder ${folder.folderId}:`,
              error
            );
          })
        )
      ).then(() => {
        logger.debug('[ProjectSync] All startup syncs complete');
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
    });

    watcher.on('error', (error) => {
      logger.error(`[ProjectSync] ❌ Watcher error for ${folderPath}:`, error);
      watchedFolder.status = 'error';
      this.sendSyncStatus(projectId, folderId, folderPath);
    });

    logger.debug(`[ProjectSync] Watcher events registered for ${folderPath}`);
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
    });

    watcher.on('error', (error) => {
      logger.error(`[ProjectSync] ❌ Watcher error for ${folderPath}:`, error);
      watchedFolder.status = 'error';
      this.sendSyncStatus(projectId, folderId, folderPath);
    });

    logger.debug(`[ProjectSync] Watcher started: ${folderPath}`);
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
      const filesResponse = await client.get(`/v0/co_scientist/projects/${projectId}/files`);
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
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            syncedCount++;
          } else {
            logger.error(`[ProjectSync-Startup] Failed to sync ${chunk[index].path}:`, result.reason);
            errorCount++;
          }
        });
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
    folderId: number,
    folderPath: string,
    filePath: string,
    manuscriptPath?: string
  ): Promise<void> {
    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    // Validate path before processing
    if (!validatePath(folderPath, filePath)) {
      throw new Error('Invalid file path: traversal attempt detected');
    }

    // Get relative path
    const relativePath = path.relative(folderPath, filePath);

    // Validate relative path doesn't contain dangerous characters
    if (/[<>"|?*\x00-\x1f]/.test(relativePath)) {
      throw new Error('Invalid file path: contains illegal characters');
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
    const mimeType = this.getMimeType(ext);

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
      `/v0/co_scientist/projects/${projectId}/files`,
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

    logger.debug(`[ProjectSync] File synced: ${relativePath} (uploaded: ${response.data.uploaded})`);
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

      await this.syncFileToProject(projectId, folderId, folderPath, filePath, manuscriptPath);

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
      const relativePath = path.relative(folderPath, filePath);

      logger.debug(`[ProjectSync]   Relative path: ${relativePath}`);
      logger.debug(`[ProjectSync]   Manuscript path: ${manuscriptPath || 'none'}`);
      logger.debug(`[ProjectSync]   Is manuscript: ${filePath === manuscriptPath}`);

      logger.debug(`[ProjectSync] Syncing file to backend...`);
      await this.syncFileToProject(projectId, folderId, folderPath, filePath, manuscriptPath);
      logger.debug(`[ProjectSync] ✓ File synced successfully to backend`);

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
  }
}

export const projectSyncService = new ProjectSyncService();
