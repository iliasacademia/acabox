import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { downloadFileFromS3, getLatestFiles, createFile, deleteFile, getStatus, listFiles } from './uploader';
import { calculateChecksum } from './utils/checksum';
import Store from 'electron-store';
import { defaultLogger as logger } from './utils/logger';
import { checkLogin } from './apiClient';

interface WatchedFolder {
  folder_name: string;
  path: string;
  watcher: chokidar.FSWatcher | null;
  status: 'idle' | 'syncing' | 'synced' | 'error';
  fileCount: number;
  lastSync: string | null;
}

interface SyncState {
  folders: Array<{
    name: string;
    path: string;
  }>;
}

class SyncService {
  private watchedFolders: Map<string, WatchedFolder> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private store = new Store<SyncState>({ name: 'sync-state' });
  private syncInProgress = new Set<string>(); // Track files currently being synced to prevent double-syncing

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private sendToRenderer(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Start watching a folder and optionally perform initial S3 sync
   * Used when user adds a new folder via UI
   * @param folderName - Name of the folder
   * @param folderPath - Absolute path to folder
   * @param performInitialSync - Whether to download files from S3 (default: true)
   */
  async startWatching(folderName: string, folderPath: string, performInitialSync: boolean = true) {
    // Validate folder exists
    if (!fs.existsSync(folderPath)) {
      throw new Error('Folder does not exist');
    }

    // Check if already watching
    if (this.watchedFolders.has(folderName)) {
      logger.debug(`[WATCH] Already watching folder ${folderName}`);
      return;
    }

    logger.debug(`[WATCH] Starting to watch folder: ${folderPath}`);

    // Start watcher first (captures changes during sync)
    await this.startWatchingOnly(folderName, folderPath);

    // Then perform initial sync from S3 if requested (when user adds new folder)
    if (performInitialSync) {
      await this.performInitialSync(folderName, folderPath);
    }
  }

  private async handleFileChange(folderName: string, filePath: string, eventType: string) {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) {
      logger.debug(`[SYNC] Folder not found: ${folderName}`);
      return;
    }

    // Deduplication: check if already syncing this file
    const syncKey = `${folderName}:${filePath}`;
    if (this.syncInProgress.has(syncKey)) {
      logger.debug(`[SYNC] File already being synced, skipping: ${filePath}`);
      return;
    }

    this.syncInProgress.add(syncKey);

    logger.debug(`[SYNC] Starting file sync for: ${filePath}`);
    logger.debug(`[SYNC] Event type: ${eventType}`);

    // Update folder status
    folder.status = 'syncing';
    this.sendToRenderer('folder-sync-status', {
      folderId: folderName,
      status: 'syncing',
    });

    try {
      // Calculate checksum
      logger.debug(`[SYNC] Calculating checksum for ${filePath}...`);
      const checksum = await calculateChecksum(filePath);

      // Get file stats
      const stats = fs.statSync(filePath);
      const mtime = stats.mtime.toISOString();

      // Calculate relative path (handles nested subfolders)
      const localRelativePath = path.relative(folder.path, filePath);
      logger.debug(`[SYNC] Relative path: ${localRelativePath}`);
      logger.debug(`[SYNC] Checksum: ${checksum}`);

      // Upload with checksum using new API
      const result = await createFile(folderName, localRelativePath, filePath, checksum, mtime);

      // If skipped (checksum matched), don't increment counter or show notification
      if (result.data?.skipped) {
        logger.debug(`[SYNC] Skipped ${filePath} - checksum matched`);
        folder.status = 'synced';
        this.sendToRenderer('folder-sync-status', {
          folderId: folderName,
          status: 'synced',
        });
        return;
      }

      const fileName = path.basename(filePath);
      const status = result.status >= 200 && result.status < 300 ? 'success' : 'error';

      logger.debug(`[SYNC] Sync completed with status: ${result.status} (${status})`);

      // Send sync event to renderer
      this.sendToRenderer('file-synced', {
        folderId: folderName,
        filePath,
        fileName,
        status: result.status,
        eventType,
      });

      // Update folder
      folder.fileCount++;
      folder.lastSync = new Date().toISOString();
      folder.status = 'synced';

      this.sendToRenderer('folder-sync-status', {
        folderId: folderName,
        status: 'synced',
      });

      logger.debug(`[SYNC] File sync completed successfully`);
    } catch (error: any) {
      logger.error(`[SYNC ERROR] Error syncing file ${filePath}:`, error);
      logger.error(`[SYNC ERROR] Error stack:`, error.stack);

      // Send error event
      this.sendToRenderer('file-synced', {
        folderId: folderName,
        filePath,
        fileName: path.basename(filePath),
        status: 500,
        error: error.message,
        eventType,
      });

      folder.status = 'error';
      this.sendToRenderer('folder-sync-status', {
        folderId: folderName,
        status: 'error',
        error: error.message,
      });
    } finally {
      // Always remove from sync in progress set
      this.syncInProgress.delete(syncKey);
    }
  }

  private async handleFileDeletion(folderName: string, filePath: string) {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) {
      logger.debug(`[SYNC] Folder not found: ${folderName}`);
      return;
    }

    logger.debug(`[SYNC] Starting file deletion for: ${filePath}`);

    // Update folder status
    folder.status = 'syncing';
    this.sendToRenderer('folder-sync-status', {
      folderId: folderName,
      status: 'syncing',
    });

    try {
      // Calculate relative path (handles nested subfolders)
      const localRelativePath = path.relative(folder.path, filePath);
      logger.debug(`[SYNC] Deleting relative path: ${localRelativePath}`);

      // Call delete API
      const result = await deleteFile(folderName, localRelativePath);
      if (result.data?.status !== 'success') {
        throw new Error(`Failed to delete file ${filePath}: ${result.message}`);
      }

      const fileName = path.basename(filePath);

      logger.debug(`[SYNC] File deleted successfully`);

      // Send sync event to renderer
      this.sendToRenderer('file-synced', {
        folderId: folderName,
        filePath,
        fileName,
        status: 200,
        eventType: 'delete',
      });

      // Update folder
      folder.fileCount = Math.max(0, folder.fileCount - 1);
      folder.lastSync = new Date().toISOString();
      folder.status = 'synced';

      this.sendToRenderer('folder-sync-status', {
        folderId: folderName,
        status: 'synced',
      });
    } catch (error: any) {
      logger.error(`[SYNC ERROR] Error deleting file ${filePath}:`, error);
      logger.error(`[SYNC ERROR] Error stack:`, error.stack);

      // Send error event
      this.sendToRenderer('file-synced', {
        folderId: folderName,
        filePath,
        fileName: path.basename(filePath),
        status: 500,
        error: error.message,
        eventType: 'delete',
      });

      folder.status = 'error';
      this.sendToRenderer('folder-sync-status', {
        folderId: folderName,
        status: 'error',
        error: error.message,
      });
    }
  }

  async stopWatching(folderName: string) {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) {
      logger.debug(`Folder ${folderName} is not being watched`);
      return;
    }

    logger.debug(`Stopping watch for folder ${folderName}`);

    if (folder.watcher) {
      await folder.watcher.close();
    }

    this.watchedFolders.delete(folderName);

    // Update persisted state
    this.persistState();
  }

  async syncNow(folderName: string) {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) {
      throw new Error('Folder is not being watched');
    }

    logger.debug(`Manual sync triggered for folder ${folderName}`);

    // Get all files in the folder
    const files = this.getAllFiles(folder.path);

    folder.status = 'syncing';
    this.sendToRenderer('folder-sync-status', {
      folderId: folderName,
      status: 'syncing',
    });

    for (const file of files) {
      await this.handleFileChange(folderName, file, 'manual');
    }
  }

  private getAllFiles(folderPath: string): string[] {
    const files: string[] = [];

    const scanDirectory = (dirPath: string) => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        // Skip hidden files and folders
        if (entry.name.startsWith('.')) continue;
        // Skip Word temporary lock files (~$filename.docx)
        if (entry.name.startsWith('~$')) continue;

        if (entry.isDirectory()) {
          scanDirectory(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    };

    scanDirectory(folderPath);
    return files;
  }

  getFolderStatus(folderName: string): WatchedFolder | undefined {
    return this.watchedFolders.get(folderName);
  }

  getAllFolders(): WatchedFolder[] {
    return Array.from(this.watchedFolders.values());
  }

  async stopAll() {
    logger.debug('Stopping all watchers');
    for (const [_folderName, folder] of this.watchedFolders) {
      if (folder.watcher) {
        await folder.watcher.close();
      }
    }
    this.watchedFolders.clear();
  }

  async initialize() {
    logger.debug('[SYNC] Initializing sync service...');

    // Load persisted folders
    const state = this.store.get('folders', []);
    logger.debug(`[SYNC] Found ${state.length} persisted folders`);

    // Track folders that need startup sync
    const foldersToSync: Array<{ name: string; path: string }> = [];

    // Start watchers for all valid folders
    for (const { name, path: folderPath } of state) {
      if (!fs.existsSync(folderPath)) {
        logger.warn(`[SYNC] Folder no longer exists: ${folderPath}`);
        // Send notification to renderer
        this.sendToRenderer('folder-sync-status', {
          folderId: name,
          status: 'error',
          error: 'Folder no longer exists',
        });
        continue;
      }

      logger.debug(`[SYNC] Starting watcher for ${name} at ${folderPath}`);
      // Start watching IMMEDIATELY (don't wait for sync)
      await this.startWatchingOnly(name, folderPath);
      foldersToSync.push({ name, path: folderPath });
    }

    // Check if user is logged in before attempting to sync
    let isLoggedIn = false;
    try {
      isLoggedIn = await checkLogin();
    } catch (error) {
      logger.warn('[SYNC] Failed to check login status, skipping remote sync:', error);
    }
    if (!isLoggedIn) {
      logger.debug('[SYNC] User not logged in, skipping remote sync');
      // Mark all folders as idle (not an error, just waiting for login)
      for (const folder of this.watchedFolders.values()) {
        folder.status = 'idle';
      }
      return;
    }

    // Fetch remote state and perform startup sync
    try {
      const remoteState = await getStatus();
      logger.debug(`[SYNC] Fetched remote state for ${remoteState.folders?.length || 0} folders`);

      // Update local folder metadata
      for (const remoteFolder of remoteState.folders || []) {
        const localFolder = this.watchedFolders.get(remoteFolder.folder_name);
        if (localFolder) {
          localFolder.fileCount = remoteFolder.file_count;
          localFolder.lastSync = remoteFolder.last_sync;
        }
      }

      // Perform startup sync for each valid folder (sequentially)
      for (const { name, path: folderPath } of foldersToSync) {
        logger.debug(`[SYNC] Performing startup sync for ${name}`);
        await this.performStartupSync(name, folderPath);
      }

      logger.debug('[SYNC] Initialization and startup sync complete');
    } catch (error: any) {
      logger.error('[SYNC] Backend offline during initialization:', error);
      // Mark all folders as error
      for (const folder of this.watchedFolders.values()) {
        folder.status = 'error';
        this.sendToRenderer('folder-sync-status', {
          folderId: folder.folder_name,
          status: 'error',
          error: 'Backend offline',
        });
      }
    }
  }

  private persistState() {
    const folders = Array.from(this.watchedFolders.values()).map(f => ({
      name: f.folder_name,
      path: f.path,
    }));
    this.store.set('folders', folders);
    logger.debug(`[SYNC] Persisted ${folders.length} folders to disk`);
  }

  async performInitialSync(folderName: string, folderPath: string) {
    logger.debug(`[INITIAL SYNC] Starting initial sync for folder: ${folderName}`);

    this.sendToRenderer('initial-sync-status', {
      folderId: folderName,
      status: 'fetching',
      message: 'Fetching files from S3...',
    });

    try {
      // Fetch ALL folders and files using new API
      const latestData = await getLatestFiles();
      logger.debug(`[INITIAL SYNC] Got ${latestData.total_folders} folders with ${latestData.total_files} total files`);

      // Find this specific folder
      const folderData = latestData.folders.find(f => f.folder_name === folderName);

      if (!folderData || folderData.files.length === 0) {
        logger.debug(`[INITIAL SYNC] No files found for folder ${folderName}`);
        this.sendToRenderer('initial-sync-status', {
          folderId: folderName,
          status: 'completed',
          message: 'No files to sync from S3',
        });
        return;
      }

      const folderFiles = folderData.files;
      logger.debug(`[INITIAL SYNC] Found ${folderFiles.length} files for folder ${folderName}`);

      this.sendToRenderer('initial-sync-status', {
        folderId: folderName,
        status: 'syncing',
        message: `Syncing ${folderFiles.length} files from S3...`,
        totalFiles: folderFiles.length,
      });

      let syncedCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      for (const s3File of folderFiles) {
        try {
          // Remove the folder name prefix from relative path
          // S3 path: "Research/subfolder/file.pdf" -> Local: "subfolder/file.pdf"
          const localRelativePath = s3File.relative_path.startsWith(`${folderName}/`)
            ? s3File.relative_path.substring(folderName.length + 1)
            : s3File.relative_path;

          const localFilePath = path.join(folderPath, localRelativePath);

          // Check if file exists locally
          if (fs.existsSync(localFilePath)) {
            // Compare file sizes or modification times
            const localStats = fs.statSync(localFilePath);
            const s3ModifiedTime = new Date(s3File.last_modified).getTime();
            const localModifiedTime = localStats.mtimeMs;

            // Skip if local file is newer or same size
            if (localStats.size === s3File.size && localModifiedTime >= s3ModifiedTime) {
              logger.debug(`[INITIAL SYNC] Skipping ${localFilePath} - already up to date`);
              syncedCount++;
              continue;
            }

            logger.debug(`[INITIAL SYNC] Local file exists but outdated: ${localFilePath}`);
          }

          // Download file from S3
          logger.debug(`[INITIAL SYNC] Downloading ${s3File.key} to ${localFilePath}`);
          const fileBuffer = await downloadFileFromS3(folderName, s3File.key);

          // Create directory if it doesn't exist
          const dirPath = path.dirname(localFilePath);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }

          // Write file to disk
          fs.writeFileSync(localFilePath, fileBuffer);

          // Set modification time to match S3
          const s3ModTime = new Date(s3File.last_modified);
          fs.utimesSync(localFilePath, s3ModTime, s3ModTime);

          syncedCount++;
          logger.debug(`[INITIAL SYNC] Downloaded: ${localFilePath}`);

          // Send progress update
          this.sendToRenderer('initial-sync-progress', {
            folderId: folderName,
            fileName: s3File.file_name,
            synced: syncedCount,
            total: folderFiles.length,
          });
        } catch (error: any) {
          errorCount++;
          const errorMsg = `Failed to sync ${s3File.file_name}: ${error.message}`;
          errors.push(errorMsg);
          logger.error(`[INITIAL SYNC ERROR]`, errorMsg);
        }
      }

      // Update folder file count
      const folder = this.watchedFolders.get(folderName);
      if (folder) {
        folder.fileCount = syncedCount;
      }

      // Send completion status
      if (errorCount === 0) {
        this.sendToRenderer('initial-sync-status', {
          folderId: folderName,
          status: 'completed',
          message: `Successfully synced ${syncedCount} files from S3`,
          syncedCount,
        });
      } else {
        this.sendToRenderer('initial-sync-status', {
          folderId: folderName,
          status: 'partial',
          message: `Synced ${syncedCount} files, ${errorCount} errors`,
          syncedCount,
          errorCount,
          errors,
        });
      }

      logger.debug(`[INITIAL SYNC] Completed: ${syncedCount} synced, ${errorCount} errors`);
    } catch (error: any) {
      logger.error(`[INITIAL SYNC ERROR] Failed to sync folder ${folderName}:`, error);
      this.sendToRenderer('initial-sync-status', {
        folderId: folderName,
        status: 'error',
        message: `Failed to sync: ${error.message}`,
      });
    }
  }

  /**
   * Start watching a folder WITHOUT performing any initial sync
   * Used during app initialization - sync is handled separately by performStartupSync
   * @param folderName - Name of the folder
   * @param folderPath - Absolute path to folder
   */
  private async startWatchingOnly(folderName: string, folderPath: string): Promise<void> {
    if (this.watchedFolders.has(folderName)) {
      logger.debug(`[WATCH] Already watching folder ${folderName}`);
      return;
    }

    logger.debug(`[WATCH] Starting watcher for folder: ${folderPath}`);

    // Create watcher with ignoreInitial: true (startup sync handles existing files)
    const watcher = chokidar.watch(folderPath, {
      persistent: true,
      ignoreInitial: true, // Don't fire events for existing files
      followSymlinks: true,
      ignored: (filePath: string) => {
        const basename = path.basename(filePath);
        // Ignore hidden files (starting with .)
        if (basename.startsWith('.')) return true;
        // Ignore Word temporary lock files (starting with ~$)
        if (basename.startsWith('~$')) return true;
        // Don't ignore directories (we need to traverse them)
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
      alwaysStat: false,
      usePolling: false,
    });

    const watchedFolder: WatchedFolder = {
      folder_name: folderName,
      path: folderPath,
      watcher,
      status: 'idle',
      fileCount: 0,
      lastSync: null,
    };

    this.watchedFolders.set(folderName, watchedFolder);

    // Set up event handlers
    watcher.on('add', async (filePath: string) => {
      logger.debug(`[CHOKIDAR] File added: ${filePath}`);
      await this.handleFileChange(folderName, filePath, 'add');
    });

    watcher.on('change', async (filePath: string) => {
      logger.debug(`[CHOKIDAR] File changed: ${filePath}`);
      await this.handleFileChange(folderName, filePath, 'change');
    });

    watcher.on('unlink', async (filePath: string) => {
      logger.debug(`[CHOKIDAR] File deleted: ${filePath}`);
      await this.handleFileDeletion(folderName, filePath);
    });

    watcher.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`[WATCH] Watcher error for folder ${folderName}:`, error);
      watchedFolder.status = 'error';
      this.sendToRenderer('folder-sync-status', {
        folderId: folderName,
        status: 'error',
        error: error.message,
      });
    });

    watcher.on('ready', () => {
      logger.debug(`[WATCH] Watcher ready for ${folderPath}`);
    });

    // Persist state
    this.persistState();
  }

  /**
   * Sync files sequentially with progress reporting
   * @param folderName - Name of the folder
   * @param files - Array of files to sync with reason
   */
  private async syncFilesSequentially(
    folderName: string,
    files: Array<{ path: string; reason: 'new' | 'changed' | 'manual' }>
  ): Promise<{ syncedCount: number; skippedCount: number; errorCount: number }> {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) {
      return { syncedCount: 0, skippedCount: 0, errorCount: 0 };
    }

    logger.debug(`[SEQUENTIAL-SYNC] Syncing ${files.length} files for ${folderName}`);

    let syncedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < files.length; i++) {
      const { path: filePath, reason } = files[i];

      try {
        logger.debug(`[SEQUENTIAL-SYNC] [${i + 1}/${files.length}] Syncing: ${filePath} (${reason})`);

        // Send progress update
        this.sendToRenderer('sync-progress', {
          folderId: folderName,
          current: i + 1,
          total: files.length,
          fileName: path.basename(filePath),
          reason,
        });

        // Call existing handleFileChange (respects checksum logic)
        await this.handleFileChange(folderName, filePath, reason);

        syncedCount++;
      } catch (error: any) {
        logger.error(`[SEQUENTIAL-SYNC] Failed to sync ${filePath}:`, error);
        errorCount++;

        // Send error event but continue with next file
        this.sendToRenderer('file-sync-error', {
          folderId: folderName,
          filePath,
          fileName: path.basename(filePath),
          error: error.message,
        });

        // Don't abort - try next file
      }
    }

    logger.debug(
      `[SEQUENTIAL-SYNC] Complete: ${syncedCount} synced, ${skippedCount} skipped, ${errorCount} errors`
    );

    // Send final summary
    this.sendToRenderer('sync-complete', {
      folderId: folderName,
      syncedCount,
      skippedCount,
      errorCount,
    });

    return { syncedCount, skippedCount, errorCount };
  }

  /**
   * Perform smart startup sync - only uploads files that changed while app was closed
   * @param folderName - Name of the folder
   * @param folderPath - Absolute path to folder
   */
  private async performStartupSync(folderName: string, folderPath: string): Promise<void> {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) return;

    logger.debug(`[STARTUP-SYNC] Starting for ${folderName}`);
    folder.status = 'syncing';
    this.sendToRenderer('startup-sync-begin', {
      folderId: folderName,
      message: 'Checking for changes...',
    });

    try {
      // Get all local files
      const localFiles = this.getAllFiles(folderPath);
      logger.debug(`[STARTUP-SYNC] Found ${localFiles.length} local files`);

      if (localFiles.length === 0) {
        logger.debug(`[STARTUP-SYNC] No local files found`);
        folder.status = 'idle';
        this.sendToRenderer('startup-sync-complete', {
          folderId: folderName,
          status: 'completed',
          message: 'No files to sync',
        });
        return;
      }

      // Get backend file list with checksums
      const backendResponse = await listFiles(folderName);
      const backendFiles = backendResponse.files || [];

      // Build remote file map: relativePath -> checksum
      const remoteFileMap = new Map<string, string>();
      for (const file of backendFiles) {
        remoteFileMap.set(file.relative_path, file.checksum);
      }

      logger.debug(`[STARTUP-SYNC] Found ${backendFiles.length} files on backend`);

      // Filter files that need syncing (new or changed)
      const filesToSync: Array<{ path: string; reason: 'new' | 'changed' }> = [];

      for (const filePath of localFiles) {
        const relativePath = path.relative(folderPath, filePath);
        const remoteChecksum = remoteFileMap.get(relativePath);

        if (!remoteChecksum) {
          // File doesn't exist on backend
          logger.debug(`[STARTUP-SYNC] New file: ${relativePath}`);
          filesToSync.push({ path: filePath, reason: 'new' });
          continue;
        }

        // Calculate local checksum
        const localChecksum = await calculateChecksum(filePath);

        if (localChecksum !== remoteChecksum) {
          // File changed since last sync
          logger.debug(
            `[STARTUP-SYNC] Changed file: ${relativePath} (local: ${localChecksum}, remote: ${remoteChecksum})`
          );
          filesToSync.push({ path: filePath, reason: 'changed' });
        }
        // else: checksums match, skip
      }

      logger.debug(`[STARTUP-SYNC] ${filesToSync.length} files need syncing`);

      if (filesToSync.length === 0) {
        folder.status = 'synced';
        this.sendToRenderer('startup-sync-complete', {
          folderId: folderName,
          status: 'completed',
          message: 'All files up to date',
        });
        return;
      }

      // Sync files sequentially
      const results = await this.syncFilesSequentially(folderName, filesToSync);

      folder.status = 'synced';
      folder.lastSync = new Date().toISOString();
      this.sendToRenderer('startup-sync-complete', {
        folderId: folderName,
        status: 'completed',
        message: `Synced ${results.syncedCount} files`,
        syncedCount: results.syncedCount,
        errorCount: results.errorCount,
      });
    } catch (error: any) {
      logger.error(`[STARTUP-SYNC] Error for ${folderName}:`, error);
      folder.status = 'error';
      this.sendToRenderer('startup-sync-complete', {
        folderId: folderName,
        status: 'error',
        error: error.message,
      });
    }
  }
}

// Export singleton instance
export const syncService = new SyncService();
