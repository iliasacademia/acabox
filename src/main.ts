import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { login, logout, uploadFile, searchFiles, checkLogin, getNotifications, updateNotification, getCurrentUser, downloadFileFromS3, getLatestFiles, addSyncAgentFolder, removeSyncAgentFolder, getStatus, addFolder, removeFolder, listFiles } from './uploader';
import Tesseract from 'tesseract.js';
import MacOCR from '@cherrystudio/mac-system-ocr';
import { syncService } from './syncService';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

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

// Test Accessibility API with Word
ipcMain.handle('test-accessibility', async () => {
  try {
    const scriptPath = path.join(__dirname, 'applescripts/test-accessibility.applescript');
    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    console.log('Accessibility API test result:');
    console.log(result);

    return { success: true, result };
  } catch (error: any) {
    console.error('Accessibility test failed:', error);
    return {
      success: false,
      error: error.message,
      result: ''
    };
  }
});

// Cleanup on app quit
app.on('before-quit', async () => {
  // Stop all sync watchers
  await syncService.stopAll();
});

// Test Microsoft Word's AppleScript object model
ipcMain.handle('test-word-api', async () => {
  try {
    const scriptPath = path.join(__dirname, 'applescripts/test-word-api.applescript');
    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();

    console.log('Word API test result:');
    console.log(result);

    return { success: true, result };
  } catch (error: any) {
    console.error('Word API test failed:', error);
    return {
      success: false,
      error: error.message,
      result: ''
    };
  }
});

// Check if Microsoft Word window is frontmost
ipcMain.handle('check-word-frontmost', async () => {
  try {
    const scriptPath = path.join(__dirname, 'applescripts/check-word-frontmost.applescript');
    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    console.log('Word frontmost check result:', result);
    const parts = result.split(',');
    const isFrontmost = parts[0] === 'true';

    if (isFrontmost && parts.length >= 5) {
      const x = parseInt(parts[1]);
      const y = parseInt(parts[2]);
      const width = parseInt(parts[3]);
      const height = parseInt(parts[4]);
      const title = parts.slice(5).join(','); // In case title contains commas

      return {
        success: true,
        isFrontmost: true,
        windowBounds: { x, y, width, height },
        title
      };
    } else {
      return {
        success: true,
        isFrontmost: false,
        reason: parts.slice(5).join(',')
      };
    }
  } catch (error: any) {
    console.error('Failed to check Word frontmost:', error);
    return {
      success: false,
      isFrontmost: false,
      error: error.message
    };
  }
});

// Get content from Microsoft Word document and find "Academia" with positions
ipcMain.handle('get-word-content', async () => {
  try {
    // First, check if Word is frontmost
    const scriptPath = path.join(__dirname, 'applescripts/check-word-frontmost.applescript');
    const frontmostResult = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    console.log('Word frontmost check:', frontmostResult);
    const parts = frontmostResult.split(',');
    const isFrontmost = parts[0] === 'true';

    if (!isFrontmost) {
      return {
        success: false,
        error: 'Microsoft Word is not the frontmost window',
        content: '',
        windowBounds: null,
        isFrontmost: false
      };
    }

    // Get window bounds from the frontmost check result
    const x = parseInt(parts[1]);
    const y = parseInt(parts[2]);
    const width = parseInt(parts[3]);
    const height = parseInt(parts[4]);
    const windowBounds = { x, y, width, height };
    console.log('Word window bounds:', windowBounds);

    // Now get the content
    const contentScript = `
      tell application "Microsoft Word"
        if it is running then
          if (count of documents) > 0 then
            set docContent to content of text object of active document
            return docContent
          else
            error "No documents are open"
          end if
        else
          error "Microsoft Word is not running"
        end if
      end tell
    `;

    const content = execSync(`osascript -e '${contentScript.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    return { success: true, content, windowBounds, isFrontmost: true };
  } catch (error: any) {
    console.error('Failed to get Word content:', error);
    return {
      success: false,
      error: error.message,
      content: '',
      windowBounds: null,
      isFrontmost: false
    };
  }
});

// Capture Word window and process with OCR to find and highlight text
ipcMain.handle('process-word-window', async (_event, imageData: string, windowBounds: { x: number; y: number; width: number; height: number }, videoDimensions: { width: number; height: number }) => {
  try {
    // Validate image data
    if (!imageData || !imageData.includes('base64')) {
      throw new Error('Invalid image data provided');
    }

    // Remove data URL prefix
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    console.log('Processing Word window, buffer size:', buffer.length, 'bytes');
    console.log('Window bounds:', windowBounds);
    console.log('Video dimensions:', videoDimensions);

    // Use Apple Vision Framework for OCR
    const startTime = Date.now();
    const result = await MacOCR.recognizeFromBuffer(buffer, {
      recognitionLevel: MacOCR.RECOGNITION_LEVEL_ACCURATE,
      minConfidence: 0.3,
    });
    const ocrTime = Date.now() - startTime;
    console.log(`Vision Framework OCR completed in ${ocrTime}ms`);

    // Vision Framework returns normalized coordinates (0-1)
    // We need to convert them to screen coordinates
    const primaryDisplay = screen.getPrimaryDisplay();
    const workAreaTop = primaryDisplay.workArea.y; // Menu bar height

    console.log('Cropped image dimensions:', videoDimensions);
    console.log('Actual Word window:', windowBounds);
    console.log('Menu bar height:', workAreaTop);

    // Find all occurrences of "Academia" (case insensitive)
    const matches: Array<{
      text: string;
      bbox: { x0: number; y0: number; x1: number; y1: number };
    }> = [];

    // Process Vision Framework results
    // Result has observations array with normalized coords (0-1, bottom-left origin)
    if (result && result.observations) {
      for (const obs of result.observations) {
        if (obs.text && obs.text.toLowerCase().includes('academia')) {
          console.log('Found "Academia":', obs.text, 'at normalized coords', { x: obs.x, y: obs.y, width: obs.width, height: obs.height });

          // Vision Framework returns normalized coordinates (0-1) with origin at bottom-left
          // Convert to pixel coordinates within the cropped Word window
          const x0 = obs.x * videoDimensions.width;
          const y0 = (1 - obs.y - obs.height) * videoDimensions.height; // Flip Y axis to top-left
          const x1 = x0 + (obs.width * videoDimensions.width);
          const y1 = y0 + (obs.height * videoDimensions.height);

          // Add Word window offset to get screen coordinates, adjusting for menu bar
          const screenX0 = x0 + windowBounds.x;
          const screenY0 = y0 + windowBounds.y - workAreaTop;
          const screenX1 = x1 + windowBounds.x;
          const screenY1 = y1 + windowBounds.y - workAreaTop;

          console.log('Screen coords:', { x0: screenX0, y0: screenY0, x1: screenX1, y1: screenY1 });

          // Store screen coordinates
          matches.push({
            text: obs.text,
            bbox: {
              x0: screenX0,
              y0: screenY0,
              x1: screenX1,
              y1: screenY1,
            },
          });
        }
      }
    }

    console.log('Total matches found:', matches.length);
    if (matches.length > 0) {
      console.log('Match details:', JSON.stringify(matches, null, 2));
    }

    // Update overlay window with matches
    if (matches.length > 0) {
      if (!overlayWindow) {
        console.log('Creating overlay window...');
        createOverlayWindow();
        // Wait a bit for the window to be ready
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (overlayWindow) {
        console.log('Sending highlights to overlay...');
        overlayWindow.webContents.send('update-highlights', matches);
      }
    } else if (overlayWindow) {
      console.log('No matches, clearing highlights');
      overlayWindow.webContents.send('update-highlights', []);
    }

    return { matches };
  } catch (error: any) {
    console.error('Word window OCR error:', error);
    return { matches: [], error: error.message };
  }
});

// Vision Framework doesn't require initialization or cleanup

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

// Get all available screen and window sources
ipcMain.handle('get-all-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 300, height: 200 },
    });
    return sources;
  } catch (error: any) {
    console.error('Failed to get all sources:', error);
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

    // Use Apple Vision Framework for OCR
    const startTime = Date.now();
    const result = await MacOCR.recognizeFromBuffer(buffer, {
      recognitionLevel: MacOCR.RECOGNITION_LEVEL_ACCURATE,
      minConfidence: 0.3,
    });
    const ocrTime = Date.now() - startTime;
    console.log(`Vision Framework OCR completed in ${ocrTime}ms`);

    // Get display dimensions
    const primaryDisplay = screen.getPrimaryDisplay();
    const displayWidth = primaryDisplay.bounds.width;
    const displayHeight = primaryDisplay.bounds.height;
    const workAreaTop = primaryDisplay.workArea.y;

    console.log('Display:', displayWidth, 'x', displayHeight);
    console.log('Work area top (menu bar height):', workAreaTop);
    console.log('Video:', videoDimensions);

    // Find all occurrences of "Academia" (case insensitive)
    const matches: Array<{
      text: string;
      bbox: { x0: number; y0: number; x1: number; y1: number };
    }> = [];

    // Process Vision Framework results
    if (result && result.observations) {
      console.log('Number of recognized text items:', result.observations.length);
      for (const obs of result.observations) {
        if (obs.text && obs.text.toLowerCase().includes('academia')) {
          console.log('Found "Academia":', obs.text, 'at normalized coords', { x: obs.x, y: obs.y, width: obs.width, height: obs.height });

          // Vision Framework returns normalized coordinates (0-1) with origin at bottom-left
          // Convert to pixel coordinates
          const x0 = obs.x * displayWidth;
          const y0 = (1 - obs.y - obs.height) * displayHeight; // Flip Y axis to top-left
          const x1 = x0 + (obs.width * displayWidth);
          const y1 = y0 + (obs.height * displayHeight);

          // Subtract menu bar since overlay starts below it
          const screenY0 = y0 - workAreaTop;
          const screenY1 = y1 - workAreaTop;

          matches.push({
            text: obs.text,
            bbox: {
              x0: x0,
              y0: screenY0,
              x1: x1,
              y1: screenY1,
            },
          });
          console.log('Screen bbox:', {
            x0: x0,
            y0: screenY0,
            x1: x1,
            y1: screenY1,
          });
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

  // Use 'floating' level instead of 'screen-saver' - this makes it appear above normal
  // windows but below some system windows and full-screen apps
  overlayWindow.setAlwaysOnTop(true, 'floating');

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

// Show overlay only when Word is frontmost
ipcMain.handle('update-overlay-visibility', async () => {
  try {
    const scriptPath = path.join(__dirname, 'applescripts/check-word-frontmost.applescript');
    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    const parts = result.split(',');
    const isFrontmost = parts[0] === 'true';

    if (overlayWindow) {
      if (isFrontmost) {
        overlayWindow.showInactive(); // Show without taking focus
      } else {
        overlayWindow.hide();
      }
    }

    return { success: true, isFrontmost };
  } catch (error: any) {
    console.error('Failed to update overlay visibility:', error);
    return { success: false, error: error.message };
  }
});

// Get Word document scroll position
ipcMain.handle('get-word-scroll-position', async () => {
  try {
    const scriptPath = path.join(__dirname, 'applescripts/get-word-scroll-position.applescript');
    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();

    const scrollPosition = parseInt(result) || 0;
    return { success: true, scrollPosition };
  } catch (error: any) {
    console.error('Failed to get Word scroll position:', error);
    return { success: false, scrollPosition: 0 };
  }
});

// Get all text content from Microsoft Word document
ipcMain.handle('get-word-text', async () => {
  try {
    const scriptPath = path.join(__dirname, 'applescripts/get-word-text.applescript');
    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    // Parse the result: format is "status,isFrontmost,content"
    const firstComma = result.indexOf(',');
    const secondComma = result.indexOf(',', firstComma + 1);

    if (firstComma === -1 || secondComma === -1) {
      return {
        success: false,
        error: 'Invalid response format',
        content: '',
        isFrontmost: false,
        isRunning: false
      };
    }

    const status = result.substring(0, firstComma);
    const isFrontmost = result.substring(firstComma + 1, secondComma) === 'true';
    const content = result.substring(secondComma + 1);

    if (status === 'error') {
      return {
        success: false,
        error: content,
        content: '',
        isFrontmost: false,
        isRunning: content.includes('not running') ? false : true
      };
    }

    return {
      success: true,
      content: content,
      isFrontmost: isFrontmost,
      isRunning: true
    };
  } catch (error: any) {
    console.error('Failed to get Word text:', error);
    return {
      success: false,
      error: error.message,
      content: '',
      isFrontmost: false,
      isRunning: false
    };
  }
});
