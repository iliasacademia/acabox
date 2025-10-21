import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { createCanvas } from 'canvas';
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
let tray: Tray | null = null;

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false, // Remove title bar and window decorations
    show: false, // Hidden on startup
    transparent: false, // Opaque background
    hasShadow: true, // Add shadow for visual separation
    resizable: true, // Allow user to resize
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

// Helper function to create text-based icon
const createTextIcon = (letter: string): Electron.NativeImage | null => {
  console.log('[TRAY] Creating text icon with letter:', letter);

  try {
    // Render at 3x resolution for crisp, anti-aliased text
    // Then resize down to 18x18 for the final icon
    const finalSize = 18;
    const renderScale = 3;
    const renderSize = finalSize * renderScale; // 54x54

    const canvas = createCanvas(renderSize, renderSize);
    const ctx = canvas.getContext('2d');

    // Enable high-quality rendering
    ctx.antialias = 'subpixel';
    ctx.patternQuality = 'best';
    ctx.textDrawingMode = 'path';

    // Clear canvas with transparent background
    ctx.clearRect(0, 0, renderSize, renderSize);

    // Set text properties - scale font size with render size
    ctx.fillStyle = '#000000'; // Black text (will be inverted by template mode)
    // Use 85% of canvas size for better fill
    const fontSize = Math.floor(renderSize * 0.85);
    // Note: node-canvas has limited font support, use simple font family
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    console.log('[TRAY] ===== TEXT ICON DETAILS =====');
    console.log('[TRAY] Render size:', renderSize, 'x', renderSize);
    console.log('[TRAY] Final target size:', finalSize, 'x', finalSize);
    console.log('[TRAY] Font size:', fontSize, 'px');
    console.log('[TRAY] Font string:', ctx.font);

    // Measure the actual text dimensions
    const letterToRender = letter.toUpperCase();
    const metrics = ctx.measureText(letterToRender);
    console.log('[TRAY] Text to render:', letterToRender);
    console.log('[TRAY] Text metrics.width:', metrics.width);
    console.log('[TRAY] Text metrics.actualBoundingBoxAscent:', metrics.actualBoundingBoxAscent);
    console.log('[TRAY] Text metrics.actualBoundingBoxDescent:', metrics.actualBoundingBoxDescent);
    const textHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    console.log('[TRAY] Calculated text height:', textHeight);
    console.log('[TRAY] Text width as % of canvas:', ((metrics.width / renderSize) * 100).toFixed(1) + '%');
    console.log('[TRAY] Text height as % of canvas:', ((textHeight / renderSize) * 100).toFixed(1) + '%');

    // Draw the letter centered
    ctx.fillText(letterToRender, renderSize / 2, renderSize / 2);

    // Get image data from high-res canvas
    const imageData = ctx.getImageData(0, 0, renderSize, renderSize);
    const buffer = Buffer.from(imageData.data);

    console.log('[TRAY] Text icon rendered at:', renderSize, 'x', renderSize);
    console.log('[TRAY] Text icon buffer size:', buffer.length, 'bytes');

    // Save debug image of the high-res canvas
    try {
      const debugPath = path.join(app.getPath('userData'), 'debug-text-icon-highres.png');
      const pngBuffer = canvas.toBuffer('image/png');
      fs.writeFileSync(debugPath, pngBuffer);
      console.log('[TRAY] Debug high-res image saved to:', debugPath);
    } catch (err) {
      console.error('[TRAY] Failed to save debug image:', err);
    }

    // Create NativeImage from high-resolution bitmap
    let icon = nativeImage.createFromBitmap(buffer, {
      width: renderSize,
      height: renderSize
    });

    console.log('[TRAY] High-res icon created - isEmpty():', icon.isEmpty());
    console.log('[TRAY] High-res icon size:', icon.getSize());

    if (icon.isEmpty()) {
      console.error('[TRAY] Text icon is empty after creation');
      return null;
    }

    // Resize down to final size for sharp, anti-aliased result
    console.log('[TRAY] Resizing from', icon.getSize(), 'to', finalSize, 'x', finalSize);
    icon = icon.resize({
      width: finalSize,
      height: finalSize,
      quality: 'best'
    });

    console.log('[TRAY] Final resized icon size:', icon.getSize());
    console.log('[TRAY] Final icon isEmpty():', icon.isEmpty());

    // Save debug image of the resized icon
    try {
      const debugPath = path.join(app.getPath('userData'), 'debug-text-icon-final.png');
      const pngBuffer = icon.toPNG();
      fs.writeFileSync(debugPath, pngBuffer);
      console.log('[TRAY] Debug final image saved to:', debugPath);
    } catch (err) {
      console.error('[TRAY] Failed to save debug final image:', err);
    }

    // Set as template image for proper dark mode support
    icon.setTemplateImage(true);

    return icon;
  } catch (error) {
    console.error('[TRAY] ERROR creating text icon:', error);
    console.error('[TRAY] Error message:', (error as Error).message);
    console.error('[TRAY] Error stack:', (error as Error).stack);
    return null;
  }
};

// Helper function to create icon based on type
// Available icon types with different shapes:
// - 'dot' (status dot)
// - 'gear' (action/settings)
// - 'bookmark' (bookmark/saved)
// - 'lock' (locked)
// - 'unlock' (unlocked)
// - 'add' (plus sign)
// - 'remove' (minus sign)
// - 'refresh' (circular arrow)
// - 'text' (letter "A")
type TrayIconType = 'dot' | 'gear' | 'bookmark' | 'lock' | 'unlock' | 'add' | 'remove' | 'refresh' | 'text';

const createTrayIcon = (iconType: TrayIconType): Electron.NativeImage | null => {
  console.log('[TRAY] Creating icon of type:', iconType);

  let icon: Electron.NativeImage;

  // Handle text icon separately
  if (iconType === 'text') {
    const textIcon = createTextIcon('A');
    if (!textIcon) {
      console.error('[TRAY] Failed to create text icon');
      return null;
    }
    return textIcon;
  }

  // Map icon type to macOS system template name
  const iconNameMap: Record<Exclude<TrayIconType, 'text'>, string> = {
    'dot': 'NSImageNameStatusAvailable',
    'gear': 'NSImageNameActionTemplate',
    'bookmark': 'NSImageNameBookmarksTemplate',
    'lock': 'NSImageNameLockLockedTemplate',
    'unlock': 'NSImageNameLockUnlockedTemplate',
    'add': 'NSImageNameAddTemplate',
    'remove': 'NSImageNameRemoveTemplate',
    'refresh': 'NSImageNameRefreshTemplate'
  };

  const systemIconName = iconNameMap[iconType as Exclude<TrayIconType, 'text'>];
  console.log('[TRAY] Using system template:', systemIconName);

  try {
    icon = nativeImage.createFromNamedImage(systemIconName);
    console.log('[TRAY] Icon created from named image');
    console.log('[TRAY] Original icon size:', icon.getSize());
  } catch (error) {
    console.error('[TRAY] ERROR creating icon from named image:', error);
    console.error('[TRAY] Error stack:', (error as Error).stack);
    return null;
  }

  // Resize icon to match standard menu bar icon size (18pt for normal, 36pt for retina)
  // macOS menu bar icons are typically 18x18 points
  try {
    icon = icon.resize({ width: 18, height: 18 });
    console.log('[TRAY] Resized icon to:', icon.getSize());
  } catch (error) {
    console.error('[TRAY] ERROR resizing icon:', error);
  }

  // Set as template image for proper dark mode support
  try {
    icon.setTemplateImage(true);
    console.log('[TRAY] Set as template image successfully');
  } catch (error) {
    console.error('[TRAY] ERROR setting template image:', error);
  }

  // Log final icon properties
  console.log('[TRAY] Final icon isEmpty():', icon.isEmpty());
  console.log('[TRAY] Final icon size:', icon.getSize());
  console.log('[TRAY] Final icon aspect ratio:', icon.getAspectRatio());

  return icon;
};

const createTray = (): void => {
  const icon = createTrayIcon('text'); // Default to letter "A"
  if (!icon) {
    console.error('[TRAY] Failed to create icon, aborting tray creation');
    return;
  }

  // Create tray
  try {
    tray = new Tray(icon);
    console.log('[TRAY] Tray created successfully');
  } catch (error) {
    console.error('[TRAY] ERROR creating tray:', error);
    console.error('[TRAY] Error message:', (error as Error).message);
    console.error('[TRAY] Error stack:', (error as Error).stack);
    return;
  }

  // Set tooltip
  tray.setToolTip('Academia Electron');

  // Create context menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          positionWindowMiddleRight(); // Position before showing
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: 'Hide App',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  // Set context menu
  tray.setContextMenu(contextMenu);

  // Clicking the tray icon will show the context menu only
  // Window can be shown/hidden via "Show App" and "Hide App" menu items
};

// Helper function to position window at middle-right of screen
const positionWindowMiddleRight = (): void => {
  if (!mainWindow) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const windowBounds = mainWindow.getBounds();

  // Position at middle-right: 20px margin from right edge, vertically centered
  const x = screenWidth - windowBounds.width - 20;
  const y = Math.floor((screenHeight - windowBounds.height) / 2);

  mainWindow.setPosition(x, y);
  console.log(`[WINDOW] Positioned at middle-right: x=${x}, y=${y}`);
};

app.whenReady().then(() => {
  createWindow();
  createTray();
});

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

// Handle tray icon change
ipcMain.handle('change-tray-icon', async (_event, iconType: TrayIconType) => {
  console.log('[TRAY] Changing icon to type:', iconType);

  if (!tray) {
    console.error('[TRAY] Tray not initialized, cannot change icon');
    return { success: false, error: 'Tray not initialized' };
  }

  try {
    const newIcon = createTrayIcon(iconType);
    if (!newIcon) {
      console.error('[TRAY] Failed to create new icon');
      return { success: false, error: 'Failed to create icon' };
    }

    tray.setImage(newIcon);
    console.log('[TRAY] Icon changed successfully');
    return { success: true };
  } catch (error) {
    console.error('[TRAY] ERROR changing icon:', error);
    return { success: false, error: (error as Error).message };
  }
});

// Handle window minimize
ipcMain.handle('minimize-window', async () => {
  if (mainWindow) {
    mainWindow.minimize();
    console.log('[WINDOW] Window minimized');
    return { success: true };
  }
  return { success: false, error: 'Window not found' };
});

// Handle window close (hide instead of quit)
ipcMain.handle('close-window', async () => {
  if (mainWindow) {
    mainWindow.hide();
    console.log('[WINDOW] Window hidden');
    return { success: true };
  }
  return { success: false, error: 'Window not found' };
});
