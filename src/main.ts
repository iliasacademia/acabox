import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { login, logout, uploadFile, searchFiles, checkLogin, getNotifications, updateNotification, getCurrentUser, downloadFileFromS3, getLatestFiles, addSyncAgentFolder, removeSyncAgentFolder, getStatus, addFolder, removeFolder, listFiles } from './uploader';
import { syncService } from './syncService';
import { wordAccessibility, AccessibilityEvent } from './native/wordAccessibility';


declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Helper function to resolve paths for AppleScript files
function resolveAppleScriptPath(scriptName: string): string {
  // In development, use the webpack output path
  const devPath = path.join(__dirname, 'applescripts', scriptName);

  // In production, use the extraResource path (Contents/Resources/applescripts/)
  const prodPath = app.isPackaged
    ? path.join(process.resourcesPath, 'applescripts', scriptName)
    : devPath;

  console.log('resolveAppleScriptPath - app.isPackaged:', app.isPackaged);
  console.log('resolveAppleScriptPath - devPath:', devPath);
  console.log('resolveAppleScriptPath - prodPath:', prodPath);
  console.log('resolveAppleScriptPath - exists:', fs.existsSync(app.isPackaged ? prodPath : devPath));

  return app.isPackaged ? prodPath : devPath;
}

let mainWindow: BrowserWindow | null = null;

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

// Helper function for cleanup before exit
function cleanupAndExit() {
  console.log('[APP] Cleaning up native resources...');

  if (isSelectionTrackingActive) {
    try {
      wordAccessibility.stopObserving();
      isSelectionTrackingActive = false;
      console.log('[APP] Selection tracking stopped successfully');
    } catch (error) {
      console.error('[APP] Error stopping observer:', error);
    }
  }

  process.exit(0);
}

// Handle terminal signals for proper cleanup
process.on('SIGINT', () => {
  console.log('[APP] Received SIGINT (Ctrl+C) - cleaning up...');
  cleanupAndExit();
});

process.on('SIGTERM', () => {
  console.log('[APP] Received SIGTERM - cleaning up...');
  cleanupAndExit();
});

process.on('SIGHUP', () => {
  console.log('[APP] Received SIGHUP (terminal closed) - cleaning up...');
  cleanupAndExit();
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

// Cleanup on app quit
app.on('before-quit', async () => {
  console.log('[APP] Application quitting - cleaning up resources...');

  // Stop selection tracking first (synchronous cleanup of native resources)
  if (isSelectionTrackingActive) {
    console.log('[APP] Stopping selection tracking...');
    try {
      wordAccessibility.stopObserving();
      isSelectionTrackingActive = false;
      console.log('[APP] Selection tracking stopped successfully');
    } catch (error) {
      console.error('[APP] Error stopping selection tracking:', error);
    }
  }

  // Stop all sync watchers
  console.log('[APP] Stopping sync watchers...');
  await syncService.stopAll();
  console.log('[APP] Cleanup complete');
});

// Test Microsoft Word's AppleScript object model
ipcMain.handle('test-word-api', async () => {
  try {
    const scriptPath = resolveAppleScriptPath('test-word-api.applescript');
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
    const scriptPath = resolveAppleScriptPath('check-word-frontmost.applescript');
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
    const scriptPath = resolveAppleScriptPath('check-word-frontmost.applescript');
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

    // OCR functionality removed - mac-system-ocr package no longer used
    const matches: Array<{
      text: string;
      bbox: { x0: number; y0: number; x1: number; y1: number };
    }> = [];

    console.log('OCR disabled - no matches returned');

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

    // OCR functionality removed - mac-system-ocr package no longer used
    const matches: Array<{
      text: string;
      bbox: { x0: number; y0: number; x1: number; y1: number };
    }> = [];

    console.log('OCR disabled - no matches returned');

    return { matches };
  } catch (error: any) {
    console.error('OCR processing error:', error);
    return { matches: [], error: error.message };
  }
});

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

// Get Word document scroll position
ipcMain.handle('get-word-scroll-position', async () => {
  try {
    const scriptPath = resolveAppleScriptPath('get-word-scroll-position.applescript');
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
    const scriptPath = resolveAppleScriptPath('get-word-text.applescript');
    console.log('Executing AppleScript at:', scriptPath);
    console.log('File exists:', fs.existsSync(scriptPath));

    if (!fs.existsSync(scriptPath)) {
      return {
        success: false,
        error: `AppleScript file not found at: ${scriptPath}`,
        content: '',
        isFrontmost: false,
        isRunning: false
      };
    }

    const result = execSync(`osascript "${scriptPath}"`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    console.log('Raw AppleScript result:', result);
    console.log('Result length:', result.length);

    // Parse the result: format is "status,isFrontmost,documents"
    const firstComma = result.indexOf(',');
    const secondComma = result.indexOf(',', firstComma + 1);

    console.log('First comma at:', firstComma, 'Second comma at:', secondComma);

    if (firstComma === -1 || secondComma === -1) {
      console.error('Invalid format - missing commas');
      return {
        success: false,
        error: 'Invalid response format',
        content: '',
        documents: [],
        isFrontmost: false,
        isRunning: false,
        rawResult: result
      };
    }

    const status = result.substring(0, firstComma);
    const isFrontmost = result.substring(firstComma + 1, secondComma) === 'true';
    const documentsData = result.substring(secondComma + 1);

    console.log('Parsed - status:', status, 'isFrontmost:', isFrontmost, 'documents data length:', documentsData.length);

    if (status === 'error') {
      console.log('Status is error, content:', documentsData);
      return {
        success: false,
        error: documentsData,
        content: '',
        documents: [],
        isFrontmost: false,
        isRunning: documentsData.includes('not running') ? false : true,
        rawResult: result
      };
    }

    // Parse multiple documents from the format:
    // ==DOC_START==\ndocName\n==CONTENT==\ndocContent\n==DOC_END==
    const documents: Array<{ name: string; content: string }> = [];
    const docParts = documentsData.split('==DOC_START==');

    for (const part of docParts) {
      if (part.trim().length === 0) continue;

      const contentSplit = part.split('==CONTENT==');
      if (contentSplit.length < 2) continue;

      const docName = contentSplit[0].replace('==DOC_END==', '').trim();
      const docContent = contentSplit[1].split('==DOC_END==')[0].trim();

      documents.push({
        name: docName,
        content: docContent
      });
    }

    console.log('Parsed documents:', documents.length);

    // For backward compatibility, set content to first document's content
    const firstDocContent = documents.length > 0 ? documents[0].content : '';

    return {
      success: true,
      content: firstDocContent,
      documents: documents,
      isFrontmost: isFrontmost,
      isRunning: true
    };
  } catch (error: any) {
    console.error('Failed to get Word text - exception caught:', error);
    console.error('Error message:', error.message);
    console.error('Error stderr:', error.stderr);
    console.error('Error stdout:', error.stdout);

    // Check for automation permission errors
    let errorMessage = error.message || 'Unknown error';
    if (error.stderr) {
      errorMessage = error.stderr;
    }

    // Collect all available error information
    const rawResult = [
      error.stdout ? `stdout: ${error.stdout}` : '',
      error.stderr ? `stderr: ${error.stderr}` : '',
      error.message ? `message: ${error.message}` : ''
    ].filter(Boolean).join('\n');

    // Detect common permission-related errors
    const isPermissionError =
      errorMessage.includes('not authorized') ||
      errorMessage.includes('not allowed') ||
      errorMessage.includes('-1743') ||
      errorMessage.includes('Apple Event') ||
      errorMessage.includes('permission');

    return {
      success: false,
      error: errorMessage,
      content: '',
      documents: [],
      isFrontmost: false,
      isRunning: false,
      isPermissionError: isPermissionError,
      rawResult: rawResult
    };
  }
});

// Native selection tracking handlers
let isSelectionTrackingActive = false;

ipcMain.handle('start-selection-tracking', async () => {
  try {
    // Check if Word is running
    const wordPIDResult = execSync("pgrep 'Microsoft Word'", { encoding: 'utf8' }).trim();
    if (!wordPIDResult) {
      return { success: false, error: 'Microsoft Word is not running' };
    }

    const wordPID = parseInt(wordPIDResult);
    console.log('[SELECTION-TRACKER] Starting observer for Word PID:', wordPID);

    // Check permission first
    if (!wordAccessibility.checkPermission()) {
      return {
        success: false,
        error: 'Accessibility permission not granted. Please enable in System Settings > Privacy & Security > Accessibility.'
      };
    }

    // Start observing with event callback
    wordAccessibility.startObserving(wordPID, (event: AccessibilityEvent) => {
      console.log('[SELECTION-TRACKER] Received event:', event.type);

      if (event.type === 'selectionChanged') {
        console.log('[SELECTION-TRACKER] Selection changed:', event.text.substring(0, 50));

        // Send to main window to update UI
        if (mainWindow) {
          mainWindow.webContents.send('selection-updated', event.text);
        }
        // Note: Button is now rendered natively, no IPC needed!
      } else if (event.type === 'scrollStarted') {
        console.log('[SELECTION-TRACKER] Scroll started');
        // Note: Button is now hidden natively, no IPC needed!
      } else if (event.type === 'scrollEnded') {
        console.log('[SELECTION-TRACKER] Scroll ended');
        // Note: Button is now shown natively at new position, no IPC needed!
      } else if (event.type === 'buttonClicked') {
        // Parse action and text from the message format "action|text"
        const parts = event.text.split('|');
        const action = parts.length > 0 ? parts[0] : 'unknown';
        const text = parts.length > 1 ? parts.slice(1).join('|') : event.text;

        console.log('[SELECTION-TRACKER] Button clicked:', action, 'for text:', text.substring(0, 50));

        // Send to main window with action information
        if (mainWindow) {
          mainWindow.webContents.send('button-action', { action, text });

          // Also send selection-updated for backward compatibility
          if (action === 'lookup') {
            mainWindow.webContents.send('selection-updated', text);
          }
        }
      }
    });

    isSelectionTrackingActive = true;
    return { success: true };
  } catch (error: any) {
    console.error('[SELECTION-TRACKER] Error starting tracking:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-selection-tracking', async () => {
  try {
    console.log('[SELECTION-TRACKER] Stopping observer');
    wordAccessibility.stopObserving();
    // Note: Native button is automatically hidden when observer stops

    isSelectionTrackingActive = false;
    return { success: true };
  } catch (error: any) {
    console.error('[SELECTION-TRACKER] Error stopping tracking:', error);
    return { success: false, error: error.message };
  }
});

// Handle button click from overlay
ipcMain.handle('selection-button-clicked', async (_event, selectedText: string) => {
  console.log('[SELECTION-TRACKER] Button clicked for text:', selectedText.substring(0, 50));

  // Send to main window to show in UI
  if (mainWindow) {
    mainWindow.webContents.send('selection-updated', selectedText);
  }

  return { success: true };
});
