import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { downloadFileFromS3, syncFile, getLatestFiles, createFile, deleteFile, getStatus } from './uploader';
import { calculateChecksum } from './utils/checksum';
import Store from 'electron-store';

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

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private sendToRenderer(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  async startWatching(folderName: string, folderPath: string, performInitialSync: boolean = true) {
    // Check if folder exists
    if (!fs.existsSync(folderPath)) {
      throw new Error('Folder does not exist');
    }

    // Check if already watching
    if (this.watchedFolders.has(folderName)) {
      console.log(`Already watching folder ${folderName}`);
      return;
    }

    console.log(`Starting to watch folder: ${folderPath}`);

    // Perform initial sync from S3 if requested
    if (performInitialSync) {
      await this.performInitialSync(folderName, folderPath);
    }

    // First, scan and count all files in the folder
    const existingFiles = this.getAllFiles(folderPath);
    console.log(`Found ${existingFiles.length} files in folder ${folderPath}`);
    if (existingFiles.length > 0) {
      console.log('Files found:', existingFiles);
    }

    // Create watcher with options optimized for different OS
    const watcher = chokidar.watch(folderPath, {
      persistent: true,
      ignoreInitial: false, // Process existing files
      followSymlinks: true,
      // Ignore hidden files and directories
      ignored: (filePath: string) => {
        const basename = path.basename(filePath);
        // Ignore hidden files (starting with .)
        if (basename.startsWith('.')) return true;
        // Ignore directories (we only want files)
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          return false; // Don't ignore directories, we need to traverse them
        }
        return false; // Accept all files
      },
      // Polling is more reliable across different OS, especially for network drives
      usePolling: false, // Set to true if network drives are common
      // Stability threshold - wait for file writes to complete
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
      // Performance options
      depth: 99, // Watch subdirectories
      alwaysStat: false,
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

    console.log(`Watcher created for folder ${folderName}, waiting for events...`);

    // Persist to disk after successful setup
    this.persistState();

    // Handle new files
    watcher.on('add', async (filePath: string) => {
      console.log(`[CHOKIDAR] File added: ${filePath}`);
      console.log(`[CHOKIDAR] File type:`, path.extname(filePath));
      await this.handleFileChange(folderName, filePath, 'add');
    });

    // Handle changed files
    watcher.on('change', async (filePath: string) => {
      console.log(`[CHOKIDAR] File changed: ${filePath}`);
      console.log(`[CHOKIDAR] File type:`, path.extname(filePath));
      await this.handleFileChange(folderName, filePath, 'change');
    });

    // Handle deleted files
    watcher.on('unlink', async (filePath: string) => {
      console.log(`[CHOKIDAR] File deleted: ${filePath}`);
      await this.handleFileDeletion(folderName, filePath);
    });

    // Handle errors
    watcher.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`Watcher error for folder ${folderName}:`, error);
      watchedFolder.status = 'error';
      this.sendToRenderer('folder-sync-status', {
        folderId: folderName,
        status: 'error',
        error: error.message,
      });
    });

    // Handle ready event (initial scan complete)
    watcher.on('ready', async () => {
      console.log(`[CHOKIDAR READY] Initial scan complete for folder ${folderName}`);
      console.log(`[CHOKIDAR READY] Files processed during scan: ${watchedFolder.fileCount}`);

      // If chokidar didn't process files during initial scan, manually sync existing files
      if (watchedFolder.fileCount === 0 && existingFiles.length > 0) {
        console.log(`[CHOKIDAR READY] Chokidar didn't process existing files, triggering manual initial sync...`);

        watchedFolder.status = 'syncing';
        this.sendToRenderer('folder-sync-status', {
          folderId: folderName,
          status: 'syncing',
        });

        // Manually sync all existing files
        for (const filePath of existingFiles) {
          await this.handleFileChange(folderName, filePath, 'initial');
        }

        console.log(`[CHOKIDAR READY] Initial sync complete, synced ${existingFiles.length} files`);
      }

      // Mark as synced if we have files, otherwise idle
      if (watchedFolder.fileCount > 0) {
        watchedFolder.status = 'synced';
        this.sendToRenderer('folder-sync-status', {
          folderId: folderName,
          status: 'synced',
        });
      } else {
        console.log(`[CHOKIDAR READY] No files in folder`);
        watchedFolder.status = 'idle';
      }
    });
  }

  private async handleFileChange(folderName: string, filePath: string, eventType: string) {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) {
      console.log(`[SYNC] Folder not found: ${folderName}`);
      return;
    }

    console.log(`[SYNC] Starting file sync for: ${filePath}`);
    console.log(`[SYNC] Event type: ${eventType}`);

    // Update folder status
    folder.status = 'syncing';
    this.sendToRenderer('folder-sync-status', {
      folderId: folderName,
      status: 'syncing',
    });

    try {
      // Calculate checksum
      console.log(`[SYNC] Calculating checksum for ${filePath}...`);
      const checksum = await calculateChecksum(filePath);

      // Get file stats
      const stats = fs.statSync(filePath);
      const mtime = stats.mtime.toISOString();

      // Calculate relative path (handles nested subfolders)
      const localRelativePath = path.relative(folder.path, filePath);
      console.log(`[SYNC] Relative path: ${localRelativePath}`);
      console.log(`[SYNC] Checksum: ${checksum}`);

      // Upload with checksum using new API
      const result = await createFile(folderName, localRelativePath, filePath, checksum, mtime);

      // If skipped (checksum matched), don't increment counter or show notification
      if (result.data?.skipped) {
        console.log(`[SYNC] Skipped ${filePath} - checksum matched`);
        folder.status = 'synced';
        this.sendToRenderer('folder-sync-status', {
          folderId: folderName,
          status: 'synced',
        });
        return;
      }

      const fileName = path.basename(filePath);
      const status = result.status >= 200 && result.status < 300 ? 'success' : 'error';

      console.log(`[SYNC] Sync completed with status: ${result.status} (${status})`);

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

      console.log(`[SYNC] File sync completed successfully`);
    } catch (error: any) {
      console.error(`[SYNC ERROR] Error syncing file ${filePath}:`, error);
      console.error(`[SYNC ERROR] Error stack:`, error.stack);

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
    }
  }

  private async handleFileDeletion(folderName: string, filePath: string) {
    const folder = this.watchedFolders.get(folderName);
    if (!folder) {
      console.log(`[SYNC] Folder not found: ${folderName}`);
      return;
    }

    console.log(`[SYNC] Starting file deletion for: ${filePath}`);

    // Update folder status
    folder.status = 'syncing';
    this.sendToRenderer('folder-sync-status', {
      folderId: folderName,
      status: 'syncing',
    });

    try {
      // Calculate relative path (handles nested subfolders)
      const localRelativePath = path.relative(folder.path, filePath);
      console.log(`[SYNC] Deleting relative path: ${localRelativePath}`);

      // Call delete API
      const result = await deleteFile(folderName, localRelativePath);

      const fileName = path.basename(filePath);

      console.log(`[SYNC] File deleted successfully`);

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
      console.error(`[SYNC ERROR] Error deleting file ${filePath}:`, error);
      console.error(`[SYNC ERROR] Error stack:`, error.stack);

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
      console.log(`Folder ${folderName} is not being watched`);
      return;
    }

    console.log(`Stopping watch for folder ${folderName}`);

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

    console.log(`Manual sync triggered for folder ${folderName}`);

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
    console.log('Stopping all watchers');
    for (const [folderName, folder] of this.watchedFolders) {
      if (folder.watcher) {
        await folder.watcher.close();
      }
    }
    this.watchedFolders.clear();
  }

  async initialize() {
    console.log('[SYNC] Initializing sync service...');

    // Load persisted folders
    const state = this.store.get('folders', []);
    console.log(`[SYNC] Found ${state.length} persisted folders`);

    for (const { name, path: folderPath } of state) {
      if (fs.existsSync(folderPath)) {
        console.log(`[SYNC] Starting watcher for ${name} at ${folderPath}`);
        await this.startWatching(name, folderPath, false); // Skip initial sync
      } else {
        console.log(`[SYNC] Folder path no longer exists: ${folderPath}`);
      }
    }

    // Fetch remote state and update file counts
    try {
      const remoteState = await getStatus();

      for (const remoteFolder of remoteState.folders) {
        const localFolder = this.watchedFolders.get(remoteFolder.folder_name);
        if (localFolder) {
          localFolder.fileCount = remoteFolder.file_count;
          localFolder.lastSync = remoteFolder.last_sync;
          localFolder.status = remoteFolder.status;

          this.sendToRenderer('folder-sync-status', {
            folderId: remoteFolder.folder_name,
            status: remoteFolder.status,
          });
        }
      }
    } catch (error) {
      console.error('[SYNC] Failed to fetch remote state (backend offline?):', error);
      // Mark all folders as offline if backend is unreachable
      for (const folder of this.watchedFolders.values()) {
        folder.status = 'error';
        this.sendToRenderer('folder-sync-status', {
          folderId: folder.folder_name,
          status: 'error',
          error: 'Backend offline',
        });
      }
    }

    console.log('[SYNC] Initialization complete');
  }

  private persistState() {
    const folders = Array.from(this.watchedFolders.values()).map(f => ({
      name: f.folder_name,
      path: f.path,
    }));
    this.store.set('folders', folders);
    console.log(`[SYNC] Persisted ${folders.length} folders to disk`);
  }

  async performInitialSync(folderName: string, folderPath: string) {
    console.log(`[INITIAL SYNC] Starting initial sync for folder: ${folderName}`);

    this.sendToRenderer('initial-sync-status', {
      folderId: folderName,
      status: 'fetching',
      message: 'Fetching files from S3...',
    });

    try {
      // Fetch ALL folders and files using new API
      const latestData = await getLatestFiles();
      console.log(`[INITIAL SYNC] Got ${latestData.total_folders} folders with ${latestData.total_files} total files`);

      // Find this specific folder
      const folderData = latestData.folders.find(f => f.folder_name === folderName);

      if (!folderData || folderData.files.length === 0) {
        console.log(`[INITIAL SYNC] No files found for folder ${folderName}`);
        this.sendToRenderer('initial-sync-status', {
          folderId: folderName,
          status: 'completed',
          message: 'No files to sync from S3',
        });
        return;
      }

      const folderFiles = folderData.files;
      console.log(`[INITIAL SYNC] Found ${folderFiles.length} files for folder ${folderName}`);

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
              console.log(`[INITIAL SYNC] Skipping ${localFilePath} - already up to date`);
              syncedCount++;
              continue;
            }

            console.log(`[INITIAL SYNC] Local file exists but outdated: ${localFilePath}`);
          }

          // Download file from S3
          console.log(`[INITIAL SYNC] Downloading ${s3File.key} to ${localFilePath}`);
          const fileBuffer = await downloadFileFromS3(folderName, s3File.key, s3File.relative_path);

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
          console.log(`[INITIAL SYNC] Downloaded: ${localFilePath}`);

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
          console.error(`[INITIAL SYNC ERROR]`, errorMsg);
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

      console.log(`[INITIAL SYNC] Completed: ${syncedCount} synced, ${errorCount} errors`);
    } catch (error: any) {
      console.error(`[INITIAL SYNC ERROR] Failed to sync folder ${folderName}:`, error);
      this.sendToRenderer('initial-sync-status', {
        folderId: folderName,
        status: 'error',
        message: `Failed to sync: ${error.message}`,
      });
    }
  }
}

// Export singleton instance
export const syncService = new SyncService();
