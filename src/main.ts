import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen, Tray, Menu, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { createCanvas } from 'canvas';
import { autoUpdater } from 'electron-updater';
import Store from 'electron-store';
import { Logger } from './utils/logger';
import { login, logout, uploadFile, searchFiles, checkLogin, getCurrentUser, downloadFileFromS3, getLatestFiles, addSyncAgentFolder, removeSyncAgentFolder, getStatus, addFolder, removeFolder, listFiles, APIclient, getCsrfToken } from './uploader';
import { syncService } from './syncService';
import { projectSyncService } from './projectSyncService';
import { notificationManager } from './notificationManager';
import { wordAccessibility, AccessibilityEvent } from './native/wordAccessibility';
import { AcademiaHttpServer } from './server/httpServer';
import { createQRAuthSession, verifyAuthCode } from './auth/qrAuthService';
import { validateExternalUrl } from './utils/urlValidation';
import { validateCloudFrontDomain } from './utils/validateCloudFrontDomain';


declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Initialize electron-store for app settings (empty for now, reserved for future settings)
const store = new Store();

// Helper function to detect channel from version string (defined early for Logger initialization)
function getChannelFromVersion(): 'stable' | 'beta' {
  const version = app.getVersion();
  return version.includes('-beta') ? 'beta' : 'stable';
}

// Initialize Logger
const logger = new Logger(
  app.isPackaged,
  app.getVersion(),
  getChannelFromVersion()
);

if (app.isPackaged) {
  const logFilePath = logger.getLogFilePath();
  logger.info('[App] Logging initialized. Log file location:', logFilePath);
} else {
  logger.info('[App] Logging initialized in development mode (using console.log)');
}

// Clean up deprecated updateChannel preference from electron-store
if (store.has('updateChannel')) {
  logger.info('[App] Removing deprecated updateChannel preference from store');
  store.delete('updateChannel');
}

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

let devWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let httpServer: AcademiaHttpServer | null = null;
let wordCheckInterval: NodeJS.Timeout | null = null;

const createWindow = async (): Promise<void> => {
  devWindow = new BrowserWindow({
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

  // Set Content Security Policy
  devWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const scriptSrc = process.env.NODE_ENV === 'development'
      ? "script-src 'self' 'unsafe-eval'; " // unsafe-eval needed for webpack-dev-server
      : "script-src 'self'; ";

    const styleSrc = process.env.NODE_ENV === 'development'
      ? "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " // unsafe-inline needed for style-loader (webpack injects inline styles in dev)
      : "style-src 'self' https://fonts.googleapis.com; "; // Production uses MiniCssExtractPlugin (external CSS files)

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          styleSrc +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data:; " + // Removed localhost wildcard for production
          scriptSrc +
          "connect-src 'self' https://api.academia.edu https://www.academia.edu; " + // Specific domains only
          "object-src 'none'; " + // Disable plugins
          "base-uri 'self'; " + // Prevent base tag injection
          "form-action 'self'; " + // Restrict form submissions
          "frame-ancestors 'none'" // Prevent clickjacking
        ]
      }
    });
  });

  devWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  if (process.env.NODE_ENV === 'development') {
    devWindow.webContents.openDevTools();
  }

  // Dev window is now just for development/debugging
  // Sync functionality is handled by the main window (Projects UI)
};

// Create main window (Projects UI)
const createMainWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
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

  // Set Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const scriptSrc = process.env.NODE_ENV === 'development'
      ? "script-src 'self' 'unsafe-eval'; " // unsafe-eval needed for webpack-dev-server
      : "script-src 'self'; ";

    const styleSrc = process.env.NODE_ENV === 'development'
      ? "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " // unsafe-inline needed for style-loader (webpack injects inline styles in dev)
      : "style-src 'self' https://fonts.googleapis.com; "; // Production uses MiniCssExtractPlugin (external CSS files)

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          styleSrc +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data:; " + // Removed localhost wildcard for production
          scriptSrc +
          "connect-src 'self' https://api.academia.edu https://www.academia.edu; " + // Specific domains only
          "object-src 'none'; " + // Disable plugins
          "base-uri 'self'; " + // Prevent base tag injection
          "form-action 'self'; " + // Restrict form submissions
          "frame-ancestors 'none'" // Prevent clickjacking
        ]
      }
    });
  });

  // Load with query parameter to indicate this is the main window
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY + '?window=main');

  // Open DevTools in development mode
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Initialize sync service with main window
  syncService.setMainWindow(mainWindow);

  // Initialize project sync service with main window
  projectSyncService.setMainWindow(mainWindow);

  // Initialize notification manager with main window
  notificationManager.setMainWindow(mainWindow);

  // WAGENT-94: Badge updates now handled by new architecture (AcademiaManager)
  // No need for manual badge update callbacks

  // Wait for window to be ready, then initialize
  mainWindow.webContents.once('did-finish-load', async () => {
    console.log('[MAIN] Main window loaded, initializing sync service...');
    await syncService.initialize();
  });

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
      console.log('[MAIN] Main window shown');
    }
  });

  console.log('[MAIN] Main window created');
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

  // Create context menu with development-only options
  const isDevelopment = process.env.NODE_ENV === 'development';

  const menuItems: Electron.MenuItemConstructorOptions[] = [];

  // Add main window controls (always present)
  menuItems.push(
    {
      label: 'Show Main Window',
      click: async () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          await createMainWindow();
        }
      },
    },
    {
      label: 'Hide Main Window',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      },
    }
  );

  // Add development window controls only in dev mode
  if (isDevelopment) {
    menuItems.push(
      { type: 'separator' },
      {
        label: 'Show Development Window',
        click: async () => {
          if (devWindow) {
            if (devWindow.isMinimized()) devWindow.restore();
            positionWindowMiddleRight(); // Position before showing
            devWindow.show();
            devWindow.focus();
          } else {
            await createWindow();
          }
        },
      },
      {
        label: 'Hide Development Window',
        click: () => {
          if (devWindow) {
            devWindow.hide();
          }
        },
      }
    );
  }

  // Add update options (always present)
  menuItems.push(
    { type: 'separator' },
    {
      label: 'Check for Updates...',
      click: () => {
        checkForUpdatesManually();
      },
    },
    {
      label: `Version: ${formatTimestampVersion(app.getVersion())}`,
      enabled: false,
    }
  );

  // Add quit option (always present)
  menuItems.push(
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);

  // Use click handler instead of setContextMenu to work around Electron tray menu crash on macOS
  tray.on('click', () => {
    if (tray) tray.popUpContextMenu(contextMenu);
  });

  tray.on('right-click', () => {
    if (tray) tray.popUpContextMenu(contextMenu);
  });
};

// Helper function to position window at middle-right of screen
const positionWindowMiddleRight = (): void => {
  if (!devWindow) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const windowBounds = devWindow.getBounds();

  // Position at middle-right: 20px margin from right edge, vertically centered
  const x = screenWidth - windowBounds.width - 20;
  const y = Math.floor((screenHeight - windowBounds.height) / 2);

  devWindow.setPosition(x, y);
  console.log(`[WINDOW] Positioned at middle-right: x=${x}, y=${y}`);
};

// Auto-updater configuration and setup
function setupAutoUpdater(): void {
  // Only enable auto-updater in production (packaged app)
  if (!app.isPackaged) {
    logger.info('[Auto-Updater] Disabled in development mode');
    return;
  }

  // Configure electron-updater
  autoUpdater.autoDownload = false; // Don't auto-download, ask user first
  autoUpdater.autoInstallOnAppQuit = true; // Install update when app quits

  // Detect update channel from version string (stable vs beta)
  const channel = getChannelFromVersion();
  autoUpdater.channel = channel;

  logger.info(`[Auto-Updater] Configured for channel: ${channel} (detected from version)`);
  logger.info(`[Auto-Updater] Current version: ${app.getVersion()}`);

  // Configure CloudFront + S3 as update server
  const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;

  // Security validation: Ensure CLOUDFRONT_DOMAIN is configured
  if (!cloudFrontDomain) {
    logger.error('[Auto-Updater] CLOUDFRONT_DOMAIN not configured - auto-updates disabled');
    return;
  }

  // Security validation: Verify domain matches CloudFront pattern
  if (!validateCloudFrontDomain(cloudFrontDomain)) {
    logger.error(
      '[Auto-Updater] SECURITY ERROR: Invalid CLOUDFRONT_DOMAIN detected',
      `Provided value: "${cloudFrontDomain}"`,
      'Domain must match *.cloudfront.net pattern',
      'Auto-updates have been disabled to prevent malicious update server redirection'
    );
    return;
  }

  const feedUrl = `https://${cloudFrontDomain}/${channel}`;
  logger.info(`[Auto-Updater] Feed URL configured: ${feedUrl}`);
  logger.info('[Auto-Updater] Security: CloudFront domain validation passed');

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedUrl,
  });

  // Event: Checking for updates
  autoUpdater.on('checking-for-update', () => {
    logger.info('[Auto-Updater] Checking for updates...');
  });

  // Event: Update available
  autoUpdater.on('update-available', (info) => {
    logger.info('[Auto-Updater] Update available:', info.version);

    // Format timestamp version for display
    const currentVersion = app.getVersion();
    const newVersion = info.version;
    const formattedNewVersion = formatTimestampVersion(newVersion);
    const formattedCurrentVersion = formatTimestampVersion(currentVersion);

    // Show dialog to user
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version of Academia is available!`,
      detail: `Current: ${formattedCurrentVersion}\nAvailable: ${formattedNewVersion}\n\nWould you like to download it now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        // User clicked Download
        logger.info('[Auto-Updater] User approved download');
        try {
          autoUpdater.downloadUpdate().catch((downloadError) => {
            logger.error('[Auto-Updater] Failed to download update:', downloadError);
            logger.error('[Auto-Updater] Error stack:', downloadError.stack);

            // Show error dialog to user
            dialog.showMessageBox({
              type: 'error',
              title: 'Update Download Failed',
              message: 'Failed to download the update.',
              detail: `An error occurred while downloading the update:\n\n${downloadError.message}\n\nYou can try again later by selecting "Check for Updates" from the menu.`,
              buttons: ['OK'],
            });
          });
        } catch (error) {
          logger.error('[Auto-Updater] Exception during downloadUpdate call:', error);
          logger.error('[Auto-Updater] Error stack:', (error as Error).stack);

          // Show error dialog to user
          dialog.showMessageBox({
            type: 'error',
            title: 'Update Download Failed',
            message: 'Failed to start the update download.',
            detail: `An error occurred:\n\n${(error as Error).message}\n\nYou can try again later by selecting "Check for Updates" from the menu.`,
            buttons: ['OK'],
          });
        }
      } else {
        logger.info('[Auto-Updater] User postponed update');
      }
    });
  });

  // Event: Update not available
  autoUpdater.on('update-not-available', (info) => {
    logger.info('[Auto-Updater] No updates available. Current version is latest:', info.version);

    // Show info dialog to user
    dialog.showMessageBox({
      type: 'info',
      title: 'No Updates Available',
      message: `Current version is latest: ${info.version}`,
      buttons: ['OK'],
    });
  });

  // Event: Update downloaded
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('[Auto-Updater] Update downloaded:', info.version);

    const formattedVersion = formatTimestampVersion(info.version);

    // Show dialog to install now or later
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'Update has been downloaded.',
      detail: `Version ${formattedVersion} is ready to install.\n\nThe application will restart to complete the installation.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        // User clicked Restart Now
        logger.info('[Auto-Updater] User approved installation, restarting...');
        autoUpdater.quitAndInstall();
      } else {
        logger.info('[Auto-Updater] User postponed installation');
      }
    });
  });

  // Event: Error
  autoUpdater.on('error', (error) => {
    // Log comprehensive error information for debugging
    logger.error('[Auto-Updater] Error occurred:', {
      message: error.message,
      code: (error as any).code,
      stack: error.stack,
      name: error.name,
    });

    // Show error dialog to user with actionable information
    dialog.showMessageBox({
      type: 'error',
      title: 'Auto-Update Error',
      message: 'An error occurred during the update process.',
      detail: `Error: ${error.message}\n\nThe update process has been interrupted. You can try checking for updates again later by selecting "Check for Updates" from the menu.\n\nIf this problem persists, please report it with the error details from the log file.`,
      buttons: ['OK'],
    }).then(() => {
      logger.info('[Auto-Updater] Error dialog dismissed by user');
    });
  });

  // Event: Download progress
  autoUpdater.on('download-progress', (progressInfo) => {
    const percent = Math.round(progressInfo.percent);
    logger.info(`[Auto-Updater] Download progress: ${percent}%`);
  });

  // Check for updates on startup (with delay to avoid blocking app initialization)
  setTimeout(() => {
    logger.info('[Auto-Updater] Performing initial update check...');
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error('[Auto-Updater] Failed to check for updates:', err);
    });
  }, 3000); // 3 second delay
}

// Helper function to format timestamp version for display
// Converts 20250106143022 to "Jan 6, 2025 14:30 UTC"
// Handles versions with channel suffix like 20250106143022-beta
function formatTimestampVersion(version: string): string {
  // Strip channel suffix if present
  const parts = version.split('-');
  const timestamp = parts[0];
  const channel = parts[1];

  // Parse timestamp: YYYYMMDDHHMMSS
  if (timestamp.length === 14) {
    const year = timestamp.substring(0, 4);
    const month = timestamp.substring(4, 6);
    const day = timestamp.substring(6, 8);
    const hour = timestamp.substring(8, 10);
    const minute = timestamp.substring(10, 12);

    // Create date string
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = monthNames[parseInt(month) - 1];

    const formatted = `${monthName} ${parseInt(day)}, ${year} ${hour}:${minute} UTC`;
    return channel ? `${formatted} (${channel})` : formatted;
  }

  // Fallback: return as-is if not timestamp format
  return version;
}

// Function to manually check for updates (called from menu)
function checkForUpdatesManually(): void {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Development Mode',
      message: 'Auto-updates are disabled in development mode.',
    });
    return;
  }

  console.log('[Auto-Updater] Manual update check requested');
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Auto-Updater] Failed to check for updates:', err);
    dialog.showMessageBox({
      type: 'error',
      title: 'Update Check Failed',
      message: 'Failed to check for updates. Please try again later.',
      detail: err.message,
    });
  });
}

app.whenReady().then(async () => {
  // Create main window (always)
  createMainWindow();

  // Only create dev window in development mode
  if (process.env.NODE_ENV === 'development') {
    createWindow();
  }
  createTray();

  // Setup auto-updater
  setupAutoUpdater();

  // Start HTTP server for data fetching
  console.log('[HTTP Server] Starting HTTP server...');
  httpServer = new AcademiaHttpServer(
    notificationManager,
    () => notificationManager.getCurrentUserId()
  );
  try {
    const port = await httpServer.start();
    console.log(`[HTTP Server] ✓ Server started on port ${port}`);
    const baseUrl = httpServer.getBaseUrl();
    console.log(`[HTTP Server] Base URL: ${baseUrl}`);

    // Set server base URL for native popups
    if (baseUrl) {
      const success = wordAccessibility.setServerBaseUrl(baseUrl);
      if (success) {
        console.log('[HTTP Server] ✓ Server URL set for native popups');
      } else {
        console.error('[HTTP Server] ✗ Failed to set server URL for native popups');
      }
    }
  } catch (error) {
    console.error('[HTTP Server] ✗ Failed to start server:', error);
  }

  // Auto-start Word button tracking if Word is running
  try {
    const wordPIDResult = execSync("pgrep 'Microsoft Word'", { encoding: 'utf8' }).trim();
    if (wordPIDResult) {
      const wordPID = parseInt(wordPIDResult);
      console.log('[WORD-BUTTON] MS Word detected (PID:', wordPID, ') - starting automatic button tracking');

      // Check accessibility permission
      if (wordAccessibility.checkPermission()) {
        // Start observing with event callback
        wordAccessibility.startObserving(wordPID, (event: AccessibilityEvent) => {
          if (event.type === 'buttonClicked') {
            if (event.text === 'academia-button-clicked') {
              console.log('[WORD-BUTTON] ✨ MS Word Academia main button clicked!');
            }
          }
        });
        isSelectionTrackingActive = true;
        console.log('[WORD-BUTTON] ✅ Automatic button tracking started successfully');
      } else {
        console.log('[WORD-BUTTON] ⚠️ Accessibility permission not granted - button will not show');
      }
    } else {
      console.log('[WORD-BUTTON] MS Word not running - button will auto-start when Word launches');
    }
  } catch (error) {
    console.log('[WORD-BUTTON] MS Word not running - button will auto-start when Word launches');
  }

  // Periodically check if Word launches (check every 5 seconds)
  wordCheckInterval = setInterval(() => {
    if (isSelectionTrackingActive) {
      return; // Already tracking
    }

    try {
      const wordPIDResult = execSync("pgrep 'Microsoft Word'", { encoding: 'utf8' }).trim();
      if (wordPIDResult) {
        const wordPID = parseInt(wordPIDResult);
        console.log('[WORD-BUTTON] MS Word launched (PID:', wordPID, ') - starting automatic button tracking');

        if (wordAccessibility.checkPermission()) {
          wordAccessibility.startObserving(wordPID, (event: AccessibilityEvent) => {
            if (event.type === 'buttonClicked') {
              if (event.text === 'academia-button-clicked') {
                console.log('[WORD-BUTTON] ✨ MS Word Academia main button clicked!');
              }
            }
          });
          isSelectionTrackingActive = true;
          console.log('[WORD-BUTTON] ✅ Automatic button tracking started successfully');
        }
      }
    } catch (error) {
      // Word not running yet
    }
  }, 5000);
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

// Helper function for cleanup
function cleanupNativeResources() {
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
}

// Helper function for cleanup before exit
async function cleanupAndExit() {
  cleanupNativeResources();

  // Stop HTTP server
  if (httpServer) {
    console.log('[APP] Stopping HTTP server...');
    try {
      await httpServer.stop();
      console.log('[APP] HTTP server stopped successfully');
    } catch (error) {
      console.error('[APP] Error stopping HTTP server:', error);
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

// Handle uncaught exceptions to ensure cleanup
process.on('uncaughtException', async (error) => {
  console.error('[APP] Uncaught exception:', error);

  // Cleanup before exit
  if (httpServer) {
    try {
      await httpServer.stop();
    } catch (e) {
      console.error('[APP] Failed to stop server:', e);
    }
  }

  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[APP] Unhandled rejection:', reason);

  // Cleanup before exit
  if (httpServer) {
    try {
      await httpServer.stop();
    } catch (e) {
      console.error('[APP] Failed to stop server:', e);
    }
  }

  process.exit(1);
});

// Handle cleanup request from dev tools (for hot reload)
ipcMain.handle('dev-cleanup-native', async () => {
  console.log('[APP] Dev-mode cleanup requested');
  cleanupNativeResources();
  return { success: true };
});

ipcMain.handle('get-app-version', async () => {
  return {
    version: app.getVersion(),
    formatted: formatTimestampVersion(app.getVersion()),
  };
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

// QR Code Authentication IPC handlers
ipcMain.handle('start-qr-auth', async () => {
  try {
    console.log('[IPC] start-qr-auth called');
    const session = await createQRAuthSession();
    console.log(`[IPC] QR auth session created with device_id: ${session.deviceId}`);
    return {
      success: true,
      deviceId: session.deviceId,
      qrCodeDataURL: session.qrCodeDataURL,
      authorizationURL: session.authorizationURL,
    };
  } catch (error: any) {
    console.error('[IPC] Failed to start QR auth:', error);
    return {
      success: false,
      error: error.message || 'Failed to create QR auth session',
    };
  }
});

ipcMain.handle('verify-qr-code', async (_event, deviceId: string, code: string) => {
  try {
    console.log(`[IPC] verify-qr-code called for device_id: ${deviceId}`);

    // Validate code format (must be 6 digits)
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
      return {
        success: false,
        error: 'Invalid code format. Please enter a 6-digit code.',
      };
    }

    // Call verification service
    const result = await verifyAuthCode(deviceId, code);

    console.log(`[IPC] Verification result for device_id ${deviceId}: authorized=${result.authorized}`);

    if (result.error) {
      return {
        success: false,
        error: result.error,
      };
    }

    return {
      success: true,
      authorized: result.authorized,
      userId: result.user_id,
    };
  } catch (error: any) {
    console.error(`[IPC] QR code verification error for device_id ${deviceId}:`, error.message);
    return {
      success: false,
      error: error.message || 'Verification failed',
    };
  }
});

// Project Sync IPC handlers
ipcMain.handle('start-project-folder-sync', async (_event, projectId: number, folderId: number, folderPath: string, manuscriptPath?: string) => {
  try {
    console.log(`[IPC] Starting project folder sync for project ${projectId}, folder ${folderId}: ${folderPath}`);
    if (manuscriptPath) {
      console.log(`[IPC] Manuscript file will be tagged: ${manuscriptPath}`);
    }
    await projectSyncService.startWatching(projectId, folderId, folderPath, manuscriptPath);
    return { success: true };
  } catch (error: any) {
    console.error('[IPC] Failed to start project folder sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-project-folder-sync', async (_event, projectId: number, folderId: number) => {
  try {
    console.log(`[IPC] Stopping project folder sync for project ${projectId}, folder ${folderId}`);
    await projectSyncService.stopWatching(projectId, folderId);
    return { success: true };
  } catch (error: any) {
    console.error('[IPC] Failed to stop project folder sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-project-sync', async (_event, projectId: number) => {
  try {
    console.log(`[IPC] Stopping all folder syncs for project ${projectId}`);
    await projectSyncService.stopWatchingProject(projectId);
    return { success: true };
  } catch (error: any) {
    console.error('[IPC] Failed to stop project sync:', error);
    return { success: false, error: error.message };
  }
});

// Generic API call handler for Projects API
ipcMain.handle('api-call', async (event, options: { method: string; endpoint: string; data?: any }) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  try {
    const { method, endpoint, data } = options;
    const client = await APIclient();

    // Log cookie metadata without exposing token values
    const cookieJar = (client.defaults.httpsAgent as any)?.options?.cookies?.jar;
    if (cookieJar && process.env.NODE_ENV === 'development') {
      const baseURL = client.defaults.baseURL || '';
      cookieJar.getCookies(baseURL, (err: Error | null, cookies: any[]) => {
        if (!err && cookies) {
          const loginTokenCookies = cookies.filter((c: any) => c.key === 'login_token');
          console.log(`[API] Request to ${endpoint} will use ${loginTokenCookies.length} login_token cookie(s)`);
          if (loginTokenCookies.length > 0) {
            loginTokenCookies.forEach((c: any, i: number) => {
              // Only log metadata, never log token values (even partially)
              console.log(`[API] Cookie ${i + 1}: domain=${c.domain}, path=${c.path}, length=${(c.value || '').length} chars`);
            });
          }
        }
      });
    }

    console.log(`[API] ${method} ${endpoint}`, data ? `with data: ${JSON.stringify(data)}` : '');

    // Send log to renderer for DevTools console
    if (senderWindow && !senderWindow.isDestroyed()) {
      senderWindow.webContents.send('api-log', {
        type: 'request',
        method,
        endpoint,
        data,
        timestamp: new Date().toISOString(),
      });
    }

    // Get CSRF token for non-GET requests
    const headers: any = {};
    if (method.toUpperCase() !== 'GET') {
      const csrfToken = await getCsrfToken();
      headers['x-csrf-token'] = csrfToken;
      console.log(`[API] Including CSRF token for ${method} request`);
    }

    let response;
    switch (method.toUpperCase()) {
      case 'GET':
        response = await client.get(endpoint);
        break;
      case 'POST':
        response = await client.post(endpoint, data, { headers });
        break;
      case 'PUT':
        response = await client.put(endpoint, data, { headers });
        break;
      case 'DELETE':
        response = await client.delete(endpoint, { headers });
        break;
      default:
        throw new Error(`Unsupported HTTP method: ${method}`);
    }

    console.log(`[API] ${method} ${endpoint} - Success:`, response.status);

    // Send success log to renderer
    if (senderWindow && !senderWindow.isDestroyed()) {
      senderWindow.webContents.send('api-log', {
        type: 'response',
        method,
        endpoint,
        status: response.status,
        statusText: response.statusText,
        timestamp: new Date().toISOString(),
      });
    }

    return response.data;
  } catch (error: any) {
    const fullUrl = error.config?.baseURL + error.config?.url;
    console.error(`[API] ${options.method} ${options.endpoint} failed:`, {
      url: fullUrl,
      status: error.response?.status,
      statusText: error.response?.statusText,
      message: error.message,
      data: error.response?.data,
    });

    // Send error log to renderer
    if (senderWindow && !senderWindow.isDestroyed()) {
      senderWindow.webContents.send('api-log', {
        type: 'error',
        method: options.method,
        endpoint: options.endpoint,
        url: fullUrl,
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        data: error.response?.data,
        timestamp: new Date().toISOString(),
      });
    }

    // Re-throw with response data if available
    if (error.response) {
      const apiError: any = new Error(error.message);
      apiError.response = {
        status: error.response.status,
        data: error.response.data,
      };
      throw apiError;
    }
    throw error;
  }
});

ipcMain.handle('select-folder', async (event) => {
  // Determine which window is requesting the dialog
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return;

  const result = await dialog.showOpenDialog(senderWindow, {
    properties: ['openDirectory'],
  });
  return result.filePaths[0];
});

// Scan folder for files
ipcMain.handle('scan-folder-for-files', async (_event, folderPaths: string[]) => {
  try {
    const allFiles: Array<{ path: string; name: string; relativePath: string; folderPath: string }> = [];

    for (const folderPath of folderPaths) {
      if (!fs.existsSync(folderPath)) {
        console.error(`[SCAN] Folder does not exist: ${folderPath}`);
        continue;
      }

      // Recursively get all files
      const scanDirectory = (dirPath: string) => {
        try {
          const items = fs.readdirSync(dirPath);

          for (const item of items) {
            // Skip hidden files/folders
            if (item.startsWith('.')) continue;

            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
              scanDirectory(fullPath);
            } else if (stat.isFile()) {
              // Only include common document types
              const ext = path.extname(fullPath).toLowerCase();
              const documentExtensions = ['.pdf', '.doc', '.docx', '.txt', '.md', '.tex', '.rtf'];

              if (documentExtensions.includes(ext)) {
                const relativePath = path.relative(folderPath, fullPath);
                allFiles.push({
                  path: fullPath,
                  name: path.basename(fullPath),
                  relativePath: relativePath,
                  folderPath: folderPath,
                });
              }
            }
          }
        } catch (error) {
          console.error(`[SCAN] Error scanning directory ${dirPath}:`, error);
        }
      };

      scanDirectory(folderPath);
    }

    console.log(`[SCAN] Found ${allFiles.length} files across ${folderPaths.length} folders`);
    return allFiles;
  } catch (error: any) {
    console.error('[SCAN] Error scanning folders:', error);
    return [];
  }
});

ipcMain.handle('upload-files', async (_event, folderPath: string) => {
  if (!devWindow) return;
  const files = fs.readdirSync(folderPath, { recursive: true }) as string[];

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf')) continue;
    const filePath = path.join(folderPath, file);
    console.log(`Uploading ${filePath}`);
    // Do this synchronously so as not to overwhelm the server and the user's network
    const result = await uploadFile(filePath, folderPath);
    devWindow.webContents.send('file-uploaded', { status: result.status, paper: result.data.private_paper });
  }
});

ipcMain.handle('search-files', async (_event, searchTerm: string) => {
  const results = await searchFiles(searchTerm);
  return results;
});

// Notification IPC handlers
ipcMain.handle('get-notifications', async (_event, options?: { status?: 'unread' | 'read' | 'dismissed'; userId?: number }) => {
  try {
    const userId = options?.userId;
    if (!userId) {
      return { notifications: [] };
    }

    const notifications = notificationManager.getNotificationsByStatus(userId, options?.status);
    return { notifications };
  } catch (error: any) {
    console.error('Failed to get notifications:', error);
    return { notifications: [] };
  }
});

// WAGENT-94: Badge update function removed - new architecture handles badges automatically

ipcMain.handle('start-notification-polling', async (_event, userId: number) => {
  console.log(`[Main] Received start-notification-polling request for user ${userId}`);
  try {
    notificationManager.startPolling(userId, 30000); // 30 second interval
    console.log(`[Main] Successfully started notification polling for user ${userId}`);

    // Note: Badge is now updated via onSyncComplete callback after each sync
    // No need for separate badge update interval

    return { success: true };
  } catch (error: any) {
    console.error('[Main] Failed to start notification polling:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-notification-polling', async () => {
  console.log('[Main] Received stop-notification-polling request');
  try {
    notificationManager.stopPolling();

    // WAGENT-94: Badge clearing handled by new architecture

    console.log('[Main] Successfully stopped notification polling');
    return { success: true };
  } catch (error: any) {
    console.error('[Main] Failed to stop notification polling:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('mark-notification-read', async (_event, id: number) => {
  try {
    await notificationManager.markAsRead(id);

    // WAGENT-94: Badge updates handled by new architecture

    return { success: true };
  } catch (error: any) {
    console.error('Failed to mark notification as read:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dismiss-notification', async (_event, id: number) => {
  try {
    await notificationManager.dismissNotification(id);

    // WAGENT-94: Badge updates handled by new architecture

    return { success: true };
  } catch (error: any) {
    console.error('Failed to dismiss notification:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-current-user', async () => {
  try {
    console.log('[IPC] get-current-user called');
    const user = await getCurrentUser();
    console.log('[IPC] get-current-user result:', user ? `user_id=${user.id}` : 'null (not logged in)');
    return user;
  } catch (error: any) {
    console.error('[IPC] Failed to get current user:', error);
    return null;
  }
});

// HTTP Server IPC handlers
ipcMain.handle('get-http-server-info', async () => {
  if (!httpServer || !httpServer.isRunning()) {
    return {
      running: false,
      baseUrl: null,
      port: null,
    };
  }

  return {
    running: true,
    baseUrl: httpServer.getBaseUrl(),
    port: httpServer.getPort(),
  };
});


// Cleanup on app quit
app.on('before-quit', async () => {
  console.log('[APP] Application quitting - cleaning up resources...');

  // Stop Word check interval
  if (wordCheckInterval) {
    console.log('[APP] Stopping Word check interval...');
    clearInterval(wordCheckInterval);
    wordCheckInterval = null;
  }

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

  // Stop notification polling and cleanup
  console.log('[APP] Closing notification manager...');
  notificationManager.close();

  // Stop HTTP server
  if (httpServer) {
    console.log('[APP] Stopping HTTP server...');
    try {
      await httpServer.stop();
      console.log('[APP] HTTP server stopped successfully');
    } catch (error) {
      console.error('[APP] Error stopping HTTP server:', error);
    }
  }

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
    console.log('[ADD-SYNC-FOLDER] Starting to add folder:', folderPath);
    const folderName = path.basename(folderPath);
    console.log('[ADD-SYNC-FOLDER] Folder name:', folderName);

    console.log('[ADD-SYNC-FOLDER] Calling backend to register folder...');
    const response = await addFolder(folderName, folderPath);
    console.log('[ADD-SYNC-FOLDER] Backend response:', response.status, response.data);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to add folder: ${response.status}`);
    }

    const folder = response.data.folder;
    console.log('[ADD-SYNC-FOLDER] Folder registered:', folder);

    // Start watching (will handle recursive subfolders automatically)
    console.log('[ADD-SYNC-FOLDER] Starting sync service watcher...');
    await syncService.startWatching(folder.folder_name, folderPath);
    console.log('[ADD-SYNC-FOLDER] Sync service watcher started successfully');

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
    console.error('[ADD-SYNC-FOLDER] Failed to add sync folder:', error);
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
        if (devWindow) {
          devWindow.webContents.send('selection-updated', event.text);
        }
        // Note: Button is now rendered natively, no IPC needed!
      } else if (event.type === 'scrollStarted') {
        console.log('[SELECTION-TRACKER] Scroll started');
        // Note: Button is now hidden natively, no IPC needed!
      } else if (event.type === 'scrollEnded') {
        console.log('[SELECTION-TRACKER] Scroll ended');
        // Note: Button is now shown natively at new position, no IPC needed!
      } else if (event.type === 'buttonClicked') {
        // Handle Academia button click
        if (event.text === 'academia-button-clicked') {
          console.log('[WORD-BUTTON] ✨ MS Word Academia main button clicked!');
        } else {
          // Legacy: Parse action and text from the message format "action|text"
          const parts = event.text.split('|');
          const action = parts.length > 0 ? parts[0] : 'unknown';
          const text = parts.length > 1 ? parts.slice(1).join('|') : event.text;

          console.log('[SELECTION-TRACKER] Button clicked:', action, 'for text:', text.substring(0, 50));

          // Handle specific actions
          if (action === 'seeMore') {
            console.log('[SUGGESTIONS] 🔍 See more clicked:', text);
          } else if (action === 'dismiss') {
            console.log('[SUGGESTIONS] ❌ Dismiss clicked:', text);
          }

          // Send to main window with action information
          if (devWindow) {
            devWindow.webContents.send('button-action', { action, text });

            // Also send selection-updated for backward compatibility
            if (action === 'lookup') {
              devWindow.webContents.send('selection-updated', text);
            }
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
  if (devWindow) {
    devWindow.webContents.send('selection-updated', selectedText);
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
  if (devWindow) {
    devWindow.minimize();
    console.log('[WINDOW] Window minimized');
    return { success: true };
  }
  return { success: false, error: 'Window not found' };
});

// Handle window close (hide instead of quit)
ipcMain.handle('close-window', async () => {
  if (devWindow) {
    devWindow.hide();
    console.log('[WINDOW] Window hidden');
    return { success: true };
  }
  return { success: false, error: 'Window not found' };
});

// Handle position debug info request
ipcMain.handle('get-position-debug-info', async () => {
  try {
    // Get position data from native bridge
    const documentTopLeftCorner = wordAccessibility.getDocumentTopLeftCorner();
    const wordWindowBounds = wordAccessibility.getWordWindowBounds();
    const firstLinePosition = wordAccessibility.getFirstLinePosition();
    const pageCornerVisibility = wordAccessibility.getPageCornerVisibility();
    const parentHierarchy = wordAccessibility.getParentHierarchy();
    const buttonStates = wordAccessibility.getButtonStates();
    const scrollAreaBounds = wordAccessibility.getScrollAreaBounds();
    const firstTextAreaInfo = wordAccessibility.getFirstTextAreaInfo();
    // WAGENT-94: badgeState removed - badges handled by new architecture

    // Get screen height for coordinate conversion
    const primaryDisplay = screen.getPrimaryDisplay();
    const screenHeight = primaryDisplay.bounds.height;

    return {
      success: true,
      data: {
        documentTopLeftCorner,
        wordWindowBounds,
        firstLinePosition,
        pageCornerVisibility,
        parentHierarchy,
        buttonStates,
        scrollAreaBounds,
        firstTextAreaInfo,
        // badgeState removed - WAGENT-94
        screenHeight,
        timestamp: Date.now()
      }
    };
  } catch (error: any) {
    console.error('[POSITION-DEBUG] Error getting position info:', error);
    return {
      success: false,
      error: error.message,
      data: null
    };
  }
});

// Handle get all notifications request for debugging
ipcMain.handle('get-all-notifications', async () => {
  try {
    const userId = notificationManager.getCurrentUserId();

    if (!userId) {
      return {
        success: false,
        error: 'No user logged in',
        notifications: [],
        currentUserId: null
      };
    }

    // Get all notifications (no status filter)
    const notifications = notificationManager.getNotificationsByStatus(userId);

    // Get status breakdown
    const unread = notifications.filter(n => n.status === 'unread').length;
    const read = notifications.filter(n => n.status === 'read').length;
    const dismissed = notifications.filter(n => n.status === 'dismissed').length;

    return {
      success: true,
      notifications,
      currentUserId: userId,
      breakdown: { unread, read, dismissed, total: notifications.length }
    };
  } catch (error: any) {
    console.error('[NOTIFICATIONS-DEBUG] Error getting notifications:', error);
    return {
      success: false,
      error: error.message,
      notifications: [],
      currentUserId: null
    };
  }
});

ipcMain.handle('open-external-url', async (_event, url: string) => {
  try {
    // Validate URL against whitelist before opening
    const validation = validateExternalUrl(url);
    if (!validation.isValid) {
      console.error('[Main] URL validation failed:', validation.error);
      return { success: false, error: validation.error };
    }

    console.log('[Main] Opening validated external URL:', url);
    await shell.openExternal(url);
    return { success: true };
  } catch (error: any) {
    console.error('[Main] Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});
