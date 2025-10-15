import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { login, logout, uploadFile, searchFiles, checkLogin, getNotifications, updateNotification, getCurrentUser, downloadFileFromS3, getLatestFiles, addSyncAgentFolder, removeSyncAgentFolder, getStatus, addFolder, removeFolder, listFiles } from './uploader';
import Tesseract from 'tesseract.js';
import { syncService } from './syncService';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tesseractWorker: Tesseract.Worker | null = null;

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Initialize sync service with main window
  syncService.setMainWindow(mainWindow);

  // Wait for window to be ready, then initialize
  mainWindow.webContents.once('did-finish-load', async () => {
    console.log('[MAIN] Window loaded, initializing sync service...');
    await syncService.initialize();
  });
};

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('check-login', async () => {
  const result = await checkLogin();
  return result;
});

ipcMain.handle('login', async (_event, email: string, password: string) => {
  try {
    const result = await login(email, password);
    return { success: result.status >= 200 && result.status < 300, data: result.data };
  } catch (error: any) {
    console.error('Login failed:', error);
    return {
      success: false,
      data: {
        message: error.response?.data?.message || error.message || 'Login failed. Please try again.',
      },
    };
  }
});

ipcMain.handle('logout', async () => {
  const result = await logout();
  return result;
});

ipcMain.handle('select-folder', async () => {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.filePaths[0];
});

ipcMain.handle('upload-files', async (_event, folderPath: string) => {
  if (!mainWindow) return;
  const files = fs.readdirSync(folderPath, { recursive: true }) as string[];

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf')) continue;
    const filePath = path.join(folderPath, file);
    console.log(`Uploading ${filePath}`);
    // Do this synchronously so as not to overwhelm the server and the user's network
    const result = await uploadFile(filePath, folderPath);
    mainWindow.webContents.send('file-uploaded', { status: result.status, paper: result.data.private_paper });
  }
});

ipcMain.handle('search-files', async (_event, searchTerm: string) => {
  const results = await searchFiles(searchTerm);
  return results;
});

ipcMain.handle('get-notifications', async () => {
  try {
    const result = await getNotifications();
    return result;
  } catch (error: any) {
    console.error('Failed to get notifications:', error);
    return { notifications: [] };
  }
});

ipcMain.handle('update-notification', async (_event, userId: number, createdAt: number) => {
  try {
    await updateNotification(userId, createdAt);
    return { success: true };
  } catch (error: any) {
    console.error('Failed to update notification:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-current-user', async () => {
  try {
    const user = await getCurrentUser();
    return user;
  } catch (error: any) {
    console.error('Failed to get current user:', error);
    return null;
  }
});

// Initialize Tesseract worker
async function initTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;

  const appPath = app.getAppPath();
  let nodeModulesPath: string;
  if (appPath.includes('.webpack')) {
    nodeModulesPath = path.join(appPath, '../../node_modules');
  } else if (appPath.includes('app.asar')) {
    nodeModulesPath = path.join(path.dirname(appPath), 'node_modules');
  } else {
    nodeModulesPath = path.join(appPath, 'node_modules');
  }

  const workerPath = path.join(nodeModulesPath, 'tesseract.js/src/worker-script/node/index.js');
  const langPath = 'https://tessdata.projectnaptha.com/4.0.0';

  console.log('Initializing Tesseract worker...');
  console.log('Worker path:', workerPath);
  console.log('Worker exists:', fs.existsSync(workerPath));

  tesseractWorker = await Tesseract.createWorker('eng', undefined, {
    workerPath: workerPath,
    langPath: langPath,
  });

  console.log('Tesseract worker initialized');
  return tesseractWorker;
}

// Cleanup on app quit
app.on('before-quit', async () => {
  if (tesseractWorker) {
    console.log('Terminating Tesseract worker...');
    await tesseractWorker.terminate();
    tesseractWorker = null;
  }

  // Stop all sync watchers
  await syncService.stopAll();
});

// Screen Reader IPC handlers
ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    return sources;
  } catch (error: any) {
    console.error('Failed to get screen sources:', error);
    return [];
  }
});

ipcMain.handle('process-screen-ocr', async (_event, imageData: string, videoDimensions: { width: number; height: number; offsetX?: number; offsetY?: number }) => {
  try {
    // Validate image data
    if (!imageData || !imageData.includes('base64')) {
      throw new Error('Invalid image data provided');
    }

    // Remove data URL prefix
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

    // Validate base64 data exists
    if (!base64Data || base64Data.length === 0) {
      throw new Error('Empty base64 data after prefix removal');
    }

    const buffer = Buffer.from(base64Data, 'base64');

    // Validate buffer size
    if (buffer.length === 0) {
      throw new Error('Empty buffer created from base64 data');
    }

    console.log('Image buffer size:', buffer.length, 'bytes');

    // Initialize worker if not already initialized
    const worker = await initTesseractWorker();

    // Use worker.recognize instead of Tesseract.recognize
    const result = await worker.recognize(buffer, {}, {
      blocks: true,
    });
    console.log('Tesseract result:', result);

    const data = result.data;
    console.log('Tesseract recognized text:', data.text);

    // Get display dimensions
    const primaryDisplay = screen.getPrimaryDisplay();
    const displayWidth = primaryDisplay.bounds.width;
    const displayHeight = primaryDisplay.bounds.height;
    const workAreaTop = primaryDisplay.workArea.y;

    // The video might be scaled down - calculate scale factors
    const scaleX = displayWidth / videoDimensions.width;
    const scaleY = displayHeight / videoDimensions.height;

    console.log('Display:', displayWidth, 'x', displayHeight);
    console.log('Work area top (menu bar height):', workAreaTop);
    console.log('Video:', videoDimensions);
    console.log('Scale factors:', scaleX, scaleY);

    // Find all occurrences of "Academia" (case insensitive)
    const matches: Array<{
      text: string;
      bbox: { x0: number; y0: number; x1: number; y1: number };
    }> = [];

    // Navigate through the hierarchical structure: Page -> blocks -> paragraphs -> lines -> words
    if (data.blocks && Array.isArray(data.blocks)) {
      console.log('Number of blocks:', data.blocks.length);
      for (const block of data.blocks) {
        if (block.paragraphs && Array.isArray(block.paragraphs)) {
          for (const paragraph of block.paragraphs) {
            if (paragraph.lines && Array.isArray(paragraph.lines)) {
              for (const line of paragraph.lines) {
                if (line.words && Array.isArray(line.words)) {
                  for (const word of line.words) {
                    if (word.text && word.text.toLowerCase().includes('academia')) {
                      console.log('Found "Academia":', word.text, 'at', word.bbox);
                      // Scale coordinates and subtract menu bar since overlay starts below it
                      const scaledY0 = word.bbox.y0 * scaleY - workAreaTop;
                      const scaledY1 = word.bbox.y1 * scaleY - workAreaTop;

                      matches.push({
                        text: word.text,
                        bbox: {
                          x0: word.bbox.x0 * scaleX,
                          y0: scaledY0,
                          x1: word.bbox.x1 * scaleX,
                          y1: scaledY1,
                        },
                      });
                      console.log('Scaled bbox:', {
                        x0: word.bbox.x0 * scaleX,
                        y0: scaledY0,
                        x1: word.bbox.x1 * scaleX,
                        y1: scaledY1,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    console.log('Total matches found:', matches.length);

    // Update overlay window if it exists
    if (matches.length > 0) {
      if (!overlayWindow) {
        createOverlayWindow();
      }
      if (overlayWindow) {
        overlayWindow.webContents.send('update-highlights', matches);
      }
    } else if (overlayWindow) {
      // Clear highlights if no matches
      overlayWindow.webContents.send('update-highlights', []);
    }

    return { matches };
  } catch (error: any) {
    console.error('OCR processing error:', error);
    return { matches: [], error: error.message };
  }
});

ipcMain.handle('close-overlay', async () => {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
  return { success: true };
});

// Create overlay window
function createOverlayWindow() {
  if (overlayWindow) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;

  overlayWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// Sync Folder IPC handlers
ipcMain.handle('get-sync-folders', async () => {
  try {
    console.log('[GET-SYNC-FOLDERS] Fetching status from backend...');
    const statusData = await getStatus();
    console.log('[GET-SYNC-FOLDERS] Response from backend:', JSON.stringify(statusData, null, 2));

    // Combine backend data with local sync service status
    const foldersWithStatus = statusData.folders.map((folder: any) => {
      const localStatus = syncService.getFolderStatus(folder.folder_name);
      return {
        id: folder.folder_name,
        path: folder.folder_path,
        status: localStatus?.status || folder.status,
        fileCount: folder.file_count,
        lastSync: folder.last_sync,
      };
    });

    return { success: true, folders: foldersWithStatus };
  } catch (error: any) {
    console.error('[GET-SYNC-FOLDERS] Backend offline or error:', error);

    // Return local folders with offline status
    const localFolders = syncService.getAllFolders().map((folder) => ({
      id: folder.folder_name,
      path: folder.path,
      status: 'error' as const,
      fileCount: folder.fileCount,
      lastSync: folder.lastSync,
      errorMessage: 'Backend offline',
    }));

    return {
      success: true,
      folders: localFolders,
      offline: true
    };
  }
});

ipcMain.handle('add-sync-folder', async (_event, folderPath: string) => {
  try {
    const folderName = path.basename(folderPath);
    const response = await addFolder(folderName, folderPath);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to add folder: ${response.status}`);
    }

    const folder = response.data.folder;

    // Start watching (will handle recursive subfolders automatically)
    await syncService.startWatching(folder.folder_name, folderPath);

    return {
      success: true,
      folder: {
        id: folder.folder_name,
        path: folderPath,
        status: 'idle',
        fileCount: 0,
        lastSync: null,
      },
    };
  } catch (error: any) {
    console.error('Failed to add sync folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-sync-folder', async (_event, folderId: string) => {
  try {
    await syncService.stopWatching(folderId);
    await removeFolder(folderId);
    return { success: true };
  } catch (error: any) {
    console.error('Failed to remove sync folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sync-folder-now', async (_event, folderId: string) => {
  try {
    await syncService.syncNow(folderId);
    return { success: true };
  } catch (error: any) {
    console.error('Failed to sync folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-folder-files', async (_event, folderId: string) => {
  try {
    console.log('[GET-FOLDER-FILES] Fetching files for folder:', folderId);
    const filesData = await listFiles(folderId);
    console.log('[GET-FOLDER-FILES] Received data from backend:', JSON.stringify(filesData, null, 2));

    if (!filesData || !filesData.files) {
      console.error('[GET-FOLDER-FILES] Invalid response structure:', filesData);
      return { success: false, error: 'Invalid response from backend', files: [] };
    }

    console.log('[GET-FOLDER-FILES] Found', filesData.files.length, 'files');

    const formattedFiles = filesData.files.map((file: any) => ({
      path: file.relative_path,
      fileName: file.file_name || file.relative_path.split('/').pop(),
      status: 'success', // Files from S3 are successfully synced
      timestamp: file.last_modified || file.mtime,
      size: file.size,
    }));
    console.log('[GET-FOLDER-FILES] Returning', formattedFiles.length, 'formatted files');
    return { success: true, files: formattedFiles };
  } catch (error: any) {
    console.error('[GET-FOLDER-FILES] Failed to get folder files:', error);
    return { success: false, error: error.message, files: [] };
  }
});
