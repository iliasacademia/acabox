import { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createCanvas } from 'canvas';
import { autoUpdater } from 'electron-updater';
import Store from 'electron-store';
import AutoLaunch from 'auto-launch';
import { defaultLogger as logger, getChannelFromVersion } from './utils/logger';
import { login, logout, checkLogin, getCurrentUser, APIclient, getCsrfToken } from './apiClient';
import { uploadFile, searchFiles, getStatus, addFolder, removeFolder, listFiles } from './uploader';
import { syncService } from './syncService';
import { projectSyncService } from './projectSyncService';
import { notificationManager } from './notificationManager';
import { wordIntegrationService } from './wordIntegrationService';
import { wordIntegrationDataStore, ProjectFileInfo } from './wordIntegrationDataStore';
import { wordAccessibility } from './native/wordAccessibility';
import { AcademiaHttpServer } from './server/httpServer';
import { createQRAuthSession, verifyAuthCode } from './auth/qrAuthService';
import { validateExternalUrl } from './utils/urlValidation';
import { validateCloudFrontDomain } from './utils/validateCloudFrontDomain';
import { IPC_CHANNELS, NavigateToPagePayload } from './shared/types';


declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Initialize electron-store for app settings (empty for now, reserved for future settings)
const store = new Store();


// Clean up deprecated updateChannel preference from electron-store
if (store.has('updateChannel')) {
  store.delete('updateChannel');
}

// Initialize auto-launch (only in production)
const autoLauncher = new AutoLaunch({
  name: 'Academia Electron',
  path: app.getPath('exe'),
});

// Enable auto-launch on first run (only in production)
if (app.isPackaged) {
  autoLauncher.isEnabled().then((isEnabled) => {
    if (!isEnabled) {
      autoLauncher.enable().then(() => {
        logger.info('[Auto-Launch] Enabled successfully');
      }).catch((err) => {
        logger.error('[Auto-Launch] Failed to enable:', err);
      });
    } else {
      logger.info('[Auto-Launch] Already enabled');
    }
  }).catch((err) => {
    logger.error('[Auto-Launch] Failed to check status:', err);
  });
}

let devWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let httpServer: AcademiaHttpServer | null = null;

const createWindow = async (): Promise<void> => {
  devWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: true, // Use native title bar with window controls
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}), // Hide title bar but show traffic lights (macOS only)
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
    // Security: Use app.isPackaged (runtime check) in addition to NODE_ENV (build-time check)
    // This ensures production CSP even if development build is accidentally deployed
    const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;

    const scriptSrc = isDevelopment
      ? "script-src 'self' 'unsafe-eval' https://static.zdassets.com https://*.zendesk.com; " // unsafe-eval needed for webpack-dev-server, Zendesk scripts and JSONP
      : "script-src 'self' https://static.zdassets.com https://*.zendesk.com; ";

    const styleSrc = isDevelopment
      ? "style-src 'self' https://fonts.googleapis.com https://static.zdassets.com 'unsafe-inline'; " // unsafe-inline needed for style-loader and Zendesk
      : "style-src 'self' https://fonts.googleapis.com https://static.zdassets.com 'unsafe-inline'; "; // Zendesk requires unsafe-inline even in production

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          styleSrc +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data: https://*.zdassets.com https://*.zendesk.com https://*.gravatar.com; " + // Added Zendesk image domains and Gravatar for avatars
          scriptSrc +
          "worker-src 'self' blob:; " + // Datadog RUM uses blob workers for session replay
          "connect-src 'self' https://api.academia.edu https://www.academia.edu https://www.google.com https://browser-intake-datadoghq.com https://*.zendesk.com https://*.zdassets.com wss://*.zendesk.com https://*.sentry.io; " + // Added Google for connectivity check, Zendesk API, WebSocket, and Sentry
          "frame-src https://*.zendesk.com https://*.zdassets.com; " + // Zendesk widget uses iframes
          "object-src 'none'; " + // Disable plugins
          "base-uri 'self'; " + // Prevent base tag injection
          "form-action 'self'; " + // Restrict form submissions
          "frame-ancestors 'none'" // Prevent clickjacking
        ]
      }
    });
  });

  devWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Dev window is now just for development/debugging
  // Sync functionality is handled by the main window (Projects UI)
};

// Create main window (Projects UI)
const createMainWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    frame: true, // Use native title bar with window controls
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}), // Hide title bar but show traffic lights (macOS only)
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
  // Security: Use app.isPackaged (runtime check) in addition to NODE_ENV (build-time check)
  // This ensures production CSP even if development build is accidentally deployed
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const isDevelopment = process.env.NODE_ENV === 'development' && !app.isPackaged;

    const scriptSrc = isDevelopment
      ? "script-src 'self' 'unsafe-eval' https://static.zdassets.com https://*.zendesk.com; " // unsafe-eval needed for webpack-dev-server, Zendesk scripts and JSONP
      : "script-src 'self' https://static.zdassets.com https://*.zendesk.com; ";

    const styleSrc = isDevelopment
      ? "style-src 'self' https://fonts.googleapis.com https://static.zdassets.com 'unsafe-inline'; " // unsafe-inline needed for style-loader and Zendesk
      : "style-src 'self' https://fonts.googleapis.com https://static.zdassets.com 'unsafe-inline'; "; // Zendesk requires unsafe-inline even in production

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          styleSrc +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data: https://*.zdassets.com https://*.zendesk.com https://*.gravatar.com; " + // Added Zendesk image domains and Gravatar for avatars
          scriptSrc +
          "worker-src 'self' blob:; " + // Datadog RUM uses blob workers for session replay
          "connect-src 'self' https://api.academia.edu https://www.academia.edu https://www.google.com https://browser-intake-datadoghq.com https://*.zendesk.com https://*.zdassets.com wss://*.zendesk.com https://*.sentry.io; " + // Added Google for connectivity check, Zendesk API, WebSocket, and Sentry
          "frame-src https://*.zendesk.com https://*.zdassets.com; " + // Zendesk widget uses iframes
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
    logger.setMainWindow(mainWindow);
    await syncService.initialize();
    await projectSyncService.initialize();

    // Check accessibility permission on startup (macOS only)
    // Note: Permission status is cached by macOS for the app's lifetime, so we only log once here
    if (process.platform === 'darwin') {
      try {
        const hasPermission = wordAccessibility.checkPermission();
        const appInfo = wordAccessibility.getAppInfo();
        logger.info('[Permissions] Accessibility permission status:', {
          granted: hasPermission,
          bundleId: appInfo.bundleId,
          teamId: appInfo.teamId,
        });
        if (!hasPermission) {
          mainWindow?.webContents.send(IPC_CHANNELS.ACCESSIBILITY_PERMISSION_STATUS, { hasPermission: false });
        }
      } catch (error) {
        logger.error('[Permissions] Error checking permission on startup:', error);
      }
    }
  });

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  // Handle window destruction
  mainWindow.on('closed', () => {
    logger.setMainWindow(null);
    mainWindow = null;
  });
};

// Helper function to create text-based icon
const createTextIcon = (letter: string): Electron.NativeImage | null => {
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

    // Measure the actual text dimensions
    const letterToRender = letter.toUpperCase();

    // Draw the letter centered
    ctx.fillText(letterToRender, renderSize / 2, renderSize / 2);

    // Get image data from high-res canvas
    const imageData = ctx.getImageData(0, 0, renderSize, renderSize);
    const buffer = Buffer.from(imageData.data);

    // Create NativeImage from high-resolution bitmap
    let icon = nativeImage.createFromBitmap(buffer, {
      width: renderSize,
      height: renderSize
    });

    if (icon.isEmpty()) {
      logger.error('[TRAY] Text icon is empty after creation');
      return null;
    }

    // Resize down to final size for sharp, anti-aliased result
    icon = icon.resize({
      width: finalSize,
      height: finalSize,
      quality: 'best'
    });

    // Set as template image for proper dark mode support
    icon.setTemplateImage(true);

    return icon;
  } catch (error) {
    logger.error('[TRAY] ERROR creating text icon:', error);
    logger.error('[TRAY] Error message:', (error as Error).message);
    logger.error('[TRAY] Error stack:', (error as Error).stack);
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
  let icon: Electron.NativeImage;

  // Handle text icon separately
  if (iconType === 'text') {
    const textIcon = createTextIcon('A');
    if (!textIcon) {
      logger.error('[TRAY] Failed to create text icon');
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

  try {
    icon = nativeImage.createFromNamedImage(systemIconName);
  } catch (error) {
    logger.error('[TRAY] ERROR creating icon from named image:', error);
    logger.error('[TRAY] Error stack:', (error as Error).stack);
    return null;
  }

  // Resize icon to match standard menu bar icon size (18pt for normal, 36pt for retina)
  // macOS menu bar icons are typically 18x18 points
  try {
    icon = icon.resize({ width: 18, height: 18 });
  } catch (error) {
    logger.error('[TRAY] ERROR resizing icon:', error);
  }

  // Set as template image for proper dark mode support
  try {
    icon.setTemplateImage(true);
  } catch (error) {
    logger.error('[TRAY] ERROR setting template image:', error);
  }

  return icon;
};

const createTray = (): void => {
  const icon = createTrayIcon('text'); // Default to letter "A"
  if (!icon) {
    logger.error('[TRAY] Failed to create icon, aborting tray creation');
    return;
  }

  // Create tray
  try {
    tray = new Tray(icon);
  } catch (error) {
    logger.error('[TRAY] ERROR creating tray:', error);
    logger.error('[TRAY] Error message:', (error as Error).message);
    logger.error('[TRAY] Error stack:', (error as Error).stack);
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
      },
      {
        label: 'Open Dev Popup UI',
        click: () => {
          const baseUrl = httpServer?.getBaseUrl();
          const token = httpServer?.getAuthToken();
          if (baseUrl && token) {
            shell.openExternal(`${baseUrl}/dev?token=${token}`);
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

  // Add permissions option (always present)
  menuItems.push(
    { type: 'separator' },
    {
      label: 'Request Permissions',
      click: () => {
        wordAccessibility.requestPermission();
      },
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
  logger.debug(`[WINDOW] Positioned at middle-right: x=${x}, y=${y}`);
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

  // electron-updater will automatically append platform-specific manifest:
  // - macOS: {channel}-mac.yml
  // - Windows: {channel}.yml (Squirrel.Windows)
  const feedUrl = `https://${cloudFrontDomain}/${channel}`;
  logger.info(`[Auto-Updater] Platform: ${process.platform}`);
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

  // Event: Update available - send to renderer for banner display
  autoUpdater.on('update-available', (info) => {
    logger.info('[Auto-Updater] Update available:', info.version);

    const formattedVersion = formatTimestampVersion(info.version);

    // Send to renderer to show banner (non-disruptive)
    mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_AVAILABLE, {
      version: info.version,
      formattedVersion: formattedVersion,
    });
  });

  // Event: Update not available - silent, just log
  autoUpdater.on('update-not-available', (info) => {
    logger.info('[Auto-Updater] No updates available. Current version is latest:', info.version);
    // Silent - no dialog, no banner when already on latest version
  });

  // Event: Update downloaded - notify renderer and auto-restart
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('[Auto-Updater] Update downloaded:', info.version);

    // Notify renderer that download is complete
    mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOADED);

    // Auto-restart after short delay to show completion state in banner
    setTimeout(() => {
      logger.info('[Auto-Updater] Auto-restarting to install update...');
      autoUpdater.quitAndInstall();
    }, 1500);
  });

  // Event: Error - send to renderer for banner display
  autoUpdater.on('error', (error) => {
    // Log comprehensive error information for debugging
    logger.error('[Auto-Updater] Error occurred:', {
      message: error.message,
      code: (error as any).code,
      stack: error.stack,
      name: error.name,
    });

    // Send to renderer to show error in banner
    mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_ERROR, {
      message: error.message || 'Download failed',
    });
  });

  // Event: Download progress - send to renderer for banner display
  autoUpdater.on('download-progress', (progressInfo) => {
    const percent = Math.round(progressInfo.percent);
    logger.info(`[Auto-Updater] Download progress: ${percent}%`);

    // Send progress to renderer for banner
    mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, {
      percent: percent,
    });
  });

  // Check for updates on startup (with delay to avoid blocking app initialization)
  setTimeout(() => {
    logger.info('[Auto-Updater] Performing initial update check...');
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error('[Auto-Updater] Failed to check for updates:', err);
    });
  }, 3000); // 3 second delay

  // Check for updates every hour (3600000ms = 1 hour)
  setInterval(() => {
    logger.info('[Auto-Updater] Performing hourly update check...');
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error('[Auto-Updater] Hourly check failed:', err);
    });
  }, 3600000);
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

  logger.info('[Auto-Updater] Manual update check requested');
  autoUpdater.checkForUpdates().catch((err) => {
    logger.error('[Auto-Updater] Failed to check for updates:', err);
    // Error will be sent to renderer via the error event handler
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
  logger.debug('[HTTP Server] Starting HTTP server...');
  httpServer = new AcademiaHttpServer(
    notificationManager,
    () => notificationManager.getCurrentUserId()
  );
  try {
    const port = await httpServer.start();
    logger.debug(`[HTTP Server] ✓ Server started on port ${port}`);
    const baseUrl = httpServer.getBaseUrl();
    logger.debug(`[HTTP Server] Base URL: ${baseUrl}`);

    // Initialize Word integration with server URL
    if (baseUrl) {
      wordIntegrationService.initialize(baseUrl);
    }

    // Set server base URL and auth token for native popups
    const authToken = httpServer.getAuthToken();
    if (baseUrl && authToken) {
      const urlSuccess = wordAccessibility.setServerBaseUrl(baseUrl);
      const tokenSuccess = wordAccessibility.setAuthToken(authToken);
      if (urlSuccess && tokenSuccess) {
        logger.debug('[HTTP Server] ✓ Server URL and auth token set for native popups');
      } else {
        logger.error('[HTTP Server] ✗ Failed to set server URL or auth token for native popups');
      }
    } else if (baseUrl) {
      const success = wordAccessibility.setServerBaseUrl(baseUrl);
      if (success) {
        logger.debug('[HTTP Server] ✓ Server URL set for native popups (no auth token)');
      }
    }

    // Set up native logging to same file as TypeScript logger
    const logFilePath = logger.getLogFilePath();
    if (logFilePath) {
      const logSuccess = wordAccessibility.setLogFilePath(logFilePath);
      if (logSuccess) {
        logger.debug('[Native] ✓ Native logging initialized to:', logFilePath);
      } else {
        logger.warn('[Native] ✗ Failed to initialize native logging');
      }
    }
  } catch (error) {
    logger.error('[HTTP Server] ✗ Failed to start server:', error);
    // Initialize Word integration without server URL
    wordIntegrationService.initialize();
  }

  // Set up navigation handler for popup-to-main-window navigation
  wordIntegrationService.setNavigationHandler((payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      logger.warn('[Main] Main window not available for navigation');
      return;
    }

    // Show and focus the main window
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();

    // Send navigation event to renderer
    mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
      page: payload.page,
      projectId: payload.projectId,
      conversationId: payload.conversationId,
    } as NavigateToPagePayload);
  });
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

/**
 * Fetches all projects and their files, extracts manuscript paths,
 * and passes them to wordIntegrationService and wordIntegrationDataStore.
 */
async function refreshManuscriptPaths(): Promise<void> {
  try {
    // Check if user is logged in first - if not, clear cache and return
    const isLoggedIn = await checkLogin();
    if (!isLoggedIn) {
      logger.info('[MANUSCRIPT-PATHS] User is logged out, clearing cache');
      wordIntegrationService.setManuscriptPaths([]);
      wordIntegrationDataStore.setProjectFileCache(new Map());
      return;
    }

    const client = await APIclient();

    // Fetch all projects
    const projectsResponse = await client.get('/v0/co_scientist/projects');
    const projects = projectsResponse.data?.projects || [];

    if (projects.length === 0) {
      wordIntegrationService.setManuscriptPaths([]);
      wordIntegrationDataStore.setProjectFileCache(new Map());
      return;
    }

    // Fetch files for each project in parallel, attaching project_id to each file
    const filesPromises = projects.map(async (project: { id: number }) => {
      try {
        const filesResponse = await client.get(`/v0/co_scientist/projects/${project.id}/files`);
        const files = filesResponse.data?.files || [];
        // Attach project_id to each file for building the cache
        return files.map((file: any) => ({ ...file, project_id: project.id }));
      } catch (error) {
        logger.error(`[MANUSCRIPT-PATHS] Failed to fetch files for project ${project.id}:`, error);
        return [];
      }
    });

    const allFilesArrays = await Promise.all(filesPromises);
    const allFiles = allFilesArrays.flat();

    // Filter for primary manuscript files
    const manuscriptFiles = allFiles.filter(
      (file: { is_primary_manuscript: boolean }) => file.is_primary_manuscript
    );

    // Build project file cache: filePath → { project_id, project_file_id }
    const projectFileCache = new Map<string, ProjectFileInfo>();
    for (const file of manuscriptFiles) {
      projectFileCache.set(file.file_path, {
        project_id: file.project_id,
        project_file_id: file.id,  // file.id is the project_file_id
      });
    }

    // Extract unique paths for tracking
    const manuscriptPaths = [...new Set(manuscriptFiles.map((f: { file_path: string }) => f.file_path))];

    wordIntegrationService.setManuscriptPaths(manuscriptPaths);
    wordIntegrationDataStore.setProjectFileCache(projectFileCache);

  } catch (error) {
    logger.error('[MANUSCRIPT-PATHS] Error refreshing manuscript paths:', error);
    wordIntegrationService.setManuscriptPaths([]);
    wordIntegrationDataStore.setProjectFileCache(new Map());
  }
}

// Helper function for cleanup
function cleanupNativeResources() {
  wordIntegrationService.cleanup();
}

// Helper function for cleanup before exit
async function cleanupAndExit() {
  cleanupNativeResources();

  // Stop HTTP server
  if (httpServer) {
    logger.debug('[APP] Stopping HTTP server...');
    try {
      await httpServer.stop();
      logger.debug('[APP] HTTP server stopped successfully');
    } catch (error) {
      logger.error('[APP] Error stopping HTTP server:', error);
    }
  }

  process.exit(0);
}

// Handle terminal signals for proper cleanup
process.on('SIGINT', () => {
  logger.debug('[APP] Received SIGINT (Ctrl+C) - cleaning up...');
  cleanupAndExit();
});

process.on('SIGTERM', () => {
  logger.debug('[APP] Received SIGTERM - cleaning up...');
  cleanupAndExit();
});

process.on('SIGHUP', () => {
  logger.debug('[APP] Received SIGHUP (terminal closed) - cleaning up...');
  cleanupAndExit();
});

// Handle uncaught exceptions to ensure cleanup
process.on('uncaughtException', async (error) => {
  logger.error('[APP] Uncaught exception:', error);

  // Cleanup before exit
  if (httpServer) {
    try {
      await httpServer.stop();
    } catch (e) {
      logger.error('[APP] Failed to stop server:', e);
    }
  }

  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logger.error('[APP] Unhandled rejection:', reason);

  // Cleanup before exit
  if (httpServer) {
    try {
      await httpServer.stop();
    } catch (e) {
      logger.error('[APP] Failed to stop server:', e);
    }
  }

  process.exit(1);
});

// Handle cleanup request from dev tools (for hot reload)
ipcMain.handle('dev-cleanup-native', async () => {
  logger.debug('[APP] Dev-mode cleanup requested');
  cleanupNativeResources();
  return { success: true };
});

ipcMain.handle('get-app-version', async () => {
  return {
    version: app.getVersion(),
    formatted: formatTimestampVersion(app.getVersion()),
  };
});

// Handle download-update request from renderer (triggered by banner click)
ipcMain.handle(IPC_CHANNELS.DOWNLOAD_UPDATE, async () => {
  logger.info('[Auto-Updater] User initiated download from banner');
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    logger.error('[Auto-Updater] Download failed:', error);
    throw error;
  }
});

// Permission IPC handlers (macOS only)
ipcMain.handle(IPC_CHANNELS.CHECK_ACCESSIBILITY_PERMISSION, async () => {
  if (process.platform !== 'darwin') {
    return { success: true, hasPermission: true };
  }
  try {
    const hasPermission = wordAccessibility.checkPermission();
    return { success: true, hasPermission };
  } catch (error: any) {
    return { success: false, hasPermission: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.REQUEST_ACCESSIBILITY_PERMISSION, async () => {
  if (process.platform !== 'darwin') {
    return { success: true, hasPermission: true };
  }
  try {
    wordAccessibility.openAccessibilitySettings();
    const hasPermission = wordAccessibility.checkPermission();
    if (hasPermission) {
      await refreshManuscriptPaths();
    }
    return { success: true, hasPermission };
  } catch (error: any) {
    return { success: false, hasPermission: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.RESET_ACCESSIBILITY_PERMISSION, async () => {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Only supported on macOS' };
  }
  try {
    const result = wordAccessibility.resetAndRequestPermission();
    return { success: true, ...result };
  } catch (error: any) {
    return { success: false, resetSuccess: false, error: error.message };
  }
});

// App lifecycle IPC handlers
ipcMain.handle(IPC_CHANNELS.RESTART_APP, () => {
  logger.info('[App] Restarting app to apply permission changes...');
  app.relaunch();
  app.quit();
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
    logger.error('Login failed:', error);
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

  // Clear Word integration only after successful logout
  if (result.success) {
    wordIntegrationService.setManuscriptPaths([]);
    wordIntegrationDataStore.setProjectFileCache(new Map());
  }

  return result;
});

// Manuscript paths refresh IPC handler
ipcMain.handle(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS, async () => {
  try {
    await refreshManuscriptPaths();
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to refresh manuscript paths:', error);
    return { success: false, error: error.message };
  }
});

// QR Code Authentication IPC handlers
ipcMain.handle('start-qr-auth', async () => {
  try {
    const session = await createQRAuthSession();
    return {
      success: true,
      deviceId: session.deviceId,
      qrCodeDataURL: session.qrCodeDataURL,
      authorizationURL: session.authorizationURL,
    };
  } catch (error: any) {
    logger.error('[IPC] Failed to start QR auth:', error);
    return {
      success: false,
      error: error.message || 'Failed to create QR auth session',
    };
  }
});

ipcMain.handle('verify-qr-code', async (_event, deviceId: string, code: string) => {
  try {
    // Validate code format (must be 6 digits)
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
      return {
        success: false,
        error: 'Invalid code format. Please enter a 6-digit code.',
      };
    }

    // Call verification service
    const result = await verifyAuthCode(deviceId, code);

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
    logger.error(`[IPC] QR code verification error for device_id ${deviceId}:`, error.message);
    return {
      success: false,
      error: error.message || 'Verification failed',
    };
  }
});

// Project Sync IPC handlers
ipcMain.handle('start-project-folder-sync', async (_event, projectId: number, folderId: number, folderPath: string, manuscriptPath?: string) => {
  try {
    await projectSyncService.startWatching(projectId, folderId, folderPath, manuscriptPath);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to start project folder sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-project-folder-sync', async (_event, projectId: number, folderId: number) => {
  try {
    await projectSyncService.stopWatching(projectId, folderId);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to stop project folder sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-project-sync', async (_event, projectId: number) => {
  try {
    await projectSyncService.stopWatchingProject(projectId);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to stop project sync:', error);
    return { success: false, error: error.message };
  }
});

// Get watcher status for a project folder
ipcMain.handle(IPC_CHANNELS.GET_PROJECT_WATCHER_STATUS, async (_event, projectId: number, folderId: number) => {
  try {
    const status = projectSyncService.getWatcherStatus(projectId, folderId);

    if (!status) {
      return {
        watcherActive: false,
        status: 'idle',
        error: 'Folder not being watched'
      };
    }

    return status;
  } catch (error: any) {
    logger.error('[IPC] Failed to get watcher status:', error);
    return {
      watcherActive: false,
      status: 'error',
      error: error.message
    };
  }
});

// Debug: Get all active watchers
ipcMain.handle(IPC_CHANNELS.DEBUG_GET_ACTIVE_WATCHERS, async () => {
  try {
    const allFolders = projectSyncService.getAllWatchedFolders();
    return {
      success: true,
      count: allFolders.length,
      folders: allFolders.map(f => ({
        projectId: f.projectId,
        folderId: f.folderId,
        folderPath: f.folderPath,
        status: f.status,
        watcherActive: f.watcher !== null
      }))
    };
  } catch (error: any) {
    logger.error('[IPC] Failed to get active watchers:', error);
    return { success: false, error: error.message };
  }
});

// Generic API call handler for Projects API
ipcMain.handle('api-call', async (_event, options: { method: string; endpoint: string; data?: any }) => {
  try {
    const { method, endpoint, data } = options;
    const client = await APIclient();

    // Get CSRF token for non-GET requests
    const headers: any = {};
    if (method.toUpperCase() !== 'GET') {
      const csrfToken = await getCsrfToken();
      headers['x-csrf-token'] = csrfToken;
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

    return response.data;
  } catch (error: any) {
    const fullUrl = error.config?.baseURL + error.config?.url;
    logger.error(`[API] ${options.method} ${options.endpoint} failed:`, {
      url: fullUrl,
      status: error.response?.status,
      statusText: error.response?.statusText,
      message: error.message,
      data: error.response?.data,
    });

    // Re-throw with response data embedded in error message for IPC serialization
    // IPC can't serialize custom properties, so we include error details in the message
    if (error.response) {
      // Extract backend error message
      let backendError = null;
      if (error.response.data?.error) {
        backendError = error.response.data.error;
      } else if (error.response.data?.errors) {
        const errors = error.response.data.errors;
        if (Array.isArray(errors)) {
          backendError = errors.join(', ');
        } else if (typeof errors === 'object') {
          backendError = Object.values(errors).flat().join(', ');
        }
      }

      // Create error with backend details in message
      if (backendError) {
        throw new Error(`API Error: ${backendError}`);
      } else {
        throw new Error(`Request failed with status code ${error.response.status}`);
      }
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
        logger.error(`[SCAN] Folder does not exist: ${folderPath}`);
        continue;
      }

      // Recursively get all files
      const scanDirectory = (dirPath: string) => {
        try {
          const items = fs.readdirSync(dirPath);

          for (const item of items) {
            // Skip hidden files/folders and temporary files
            if (item.startsWith('.')) continue;
            // Skip Word temporary lock files (~$filename.docx)
            if (item.startsWith('~$')) continue;

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
          logger.error(`[SCAN] Error scanning directory ${dirPath}:`, error);
        }
      };

      scanDirectory(folderPath);
    }

    logger.debug(`[SCAN] Found ${allFiles.length} files across ${folderPaths.length} folders`);
    return allFiles;
  } catch (error: any) {
    logger.error('[SCAN] Error scanning folders:', error);
    return [];
  }
});

ipcMain.handle('upload-files', async (_event, folderPath: string) => {
  if (!devWindow) return;
  const files = fs.readdirSync(folderPath, { recursive: true }) as string[];

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf')) continue;
    const filePath = path.join(folderPath, file);
    logger.debug(`Uploading ${filePath}`);
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
    logger.error('Failed to get notifications:', error);
    return { notifications: [] };
  }
});

// WAGENT-94: Badge update function removed - new architecture handles badges automatically

ipcMain.handle('start-notification-polling', async (_event, userId: number) => {
  try {
    notificationManager.startPolling(userId, 30000); // 30 second interval
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to start notification polling:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-notification-polling', async () => {
  try {
    notificationManager.stopPolling();
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to stop notification polling:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('mark-notification-read', async (_event, id: number) => {
  try {
    await notificationManager.markAsRead(id);

    // WAGENT-94: Badge updates handled by new architecture

    return { success: true };
  } catch (error: any) {
    logger.error('Failed to mark notification as read:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dismiss-notification', async (_event, id: number) => {
  try {
    await notificationManager.dismissNotification(id);

    // WAGENT-94: Badge updates handled by new architecture

    return { success: true };
  } catch (error: any) {
    logger.error('Failed to dismiss notification:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-current-user', async () => {
  try {
    const user = await getCurrentUser();
    return user;
  } catch (error: any) {
    logger.error('[IPC] Failed to get current user:', error);
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
  logger.debug('[APP] Application quitting - cleaning up resources...');

  // Stop Word integration (intervals and native observers)
  wordIntegrationService.cleanup();

  // Stop all sync watchers
  logger.debug('[APP] Stopping sync watchers...');
  await syncService.stopAll();

  // Stop notification polling and cleanup
  logger.debug('[APP] Closing notification manager...');
  notificationManager.close();

  // Stop HTTP server
  if (httpServer) {
    logger.debug('[APP] Stopping HTTP server...');
    try {
      await httpServer.stop();
      logger.debug('[APP] HTTP server stopped successfully');
    } catch (error) {
      logger.error('[APP] Error stopping HTTP server:', error);
    }
  }

  logger.debug('[APP] Cleanup complete');
});

// Sync Folder IPC handlers
ipcMain.handle('get-sync-folders', async () => {
  try {
    logger.debug('[GET-SYNC-FOLDERS] Fetching status from backend...');
    const statusData = await getStatus();
    logger.debug('[GET-SYNC-FOLDERS] Response from backend:', JSON.stringify(statusData, null, 2));

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
    logger.error('[GET-SYNC-FOLDERS] Backend offline or error:', error);

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
    logger.debug('[ADD-SYNC-FOLDER] Starting to add folder:', folderPath);
    const folderName = path.basename(folderPath);
    logger.debug('[ADD-SYNC-FOLDER] Folder name:', folderName);

    logger.debug('[ADD-SYNC-FOLDER] Calling backend to register folder...');
    const response = await addFolder(folderName, folderPath);
    logger.debug('[ADD-SYNC-FOLDER] Backend response:', response.status, response.data);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to add folder: ${response.status}`);
    }

    const folder = response.data.folder;
    logger.debug('[ADD-SYNC-FOLDER] Folder registered:', folder);

    // Start watching (will handle recursive subfolders automatically)
    logger.debug('[ADD-SYNC-FOLDER] Starting sync service watcher...');
    await syncService.startWatching(folder.folder_name, folderPath);
    logger.debug('[ADD-SYNC-FOLDER] Sync service watcher started successfully');

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
    logger.error('[ADD-SYNC-FOLDER] Failed to add sync folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-sync-folder', async (_event, folderId: string) => {
  try {
    await syncService.stopWatching(folderId);
    await removeFolder(folderId);
    return { success: true };
  } catch (error: any) {
    logger.error('Failed to remove sync folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sync-folder-now', async (_event, folderId: string) => {
  try {
    await syncService.syncNow(folderId);
    return { success: true };
  } catch (error: any) {
    logger.error('Failed to sync folder:', error);
    return { success: false, error: error.message };
  }
});

// Reinitialize sync services after user login
// This is needed when the app starts without a user logged in - sync services skip initialization
// and need to be reinitialized once the user logs in
ipcMain.handle(IPC_CHANNELS.REINITIALIZE_SYNC, async () => {
  logger.debug('[Main] Reinitializing sync services after login');
  try {
    await syncService.initialize();
    await projectSyncService.initialize();
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to reinitialize sync services:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-folder-files', async (_event, folderId: string) => {
  try {
    logger.debug('[GET-FOLDER-FILES] Fetching files for folder:', folderId);
    const filesData = await listFiles(folderId);
    logger.debug('[GET-FOLDER-FILES] Received data from backend:', JSON.stringify(filesData, null, 2));

    if (!filesData || !filesData.files) {
      logger.error('[GET-FOLDER-FILES] Invalid response structure:', filesData);
      return { success: false, error: 'Invalid response from backend', files: [] };
    }

    logger.debug('[GET-FOLDER-FILES] Found', filesData.files.length, 'files');

    const formattedFiles = filesData.files.map((file: any) => ({
      path: file.relative_path,
      fileName: file.file_name || file.relative_path.split('/').pop(),
      status: 'success', // Files from S3 are successfully synced
      timestamp: file.last_modified || file.mtime,
      size: file.size,
    }));
    logger.debug('[GET-FOLDER-FILES] Returning', formattedFiles.length, 'formatted files');
    return { success: true, files: formattedFiles };
  } catch (error: any) {
    logger.error('[GET-FOLDER-FILES] Failed to get folder files:', error);
    return { success: false, error: error.message, files: [] };
  }
});

// Handle tray icon change
ipcMain.handle('change-tray-icon', async (_event, iconType: TrayIconType) => {
  if (!tray) {
    logger.error('[TRAY] Tray not initialized, cannot change icon');
    return { success: false, error: 'Tray not initialized' };
  }

  try {
    const newIcon = createTrayIcon(iconType);
    if (!newIcon) {
      logger.error('[TRAY] Failed to create new icon');
      return { success: false, error: 'Failed to create icon' };
    }

    tray.setImage(newIcon);
    return { success: true };
  } catch (error) {
    logger.error('[TRAY] ERROR changing icon:', error);
    return { success: false, error: (error as Error).message };
  }
});


// Handle position debug info request
ipcMain.handle('get-position-debug-info', async () => {
  return wordIntegrationService.getPositionDebugInfo();
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
    logger.error('[NOTIFICATIONS-DEBUG] Error getting notifications:', error);
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
      logger.error('[Main] URL validation failed:', validation.error);
      return { success: false, error: validation.error };
    }

    await shell.openExternal(url);
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});

// Navigation handler - focus main window and relay navigation event
ipcMain.handle(IPC_CHANNELS.NAVIGATE_TO_PAGE, async (_event, payload: NavigateToPagePayload) => {
  try {
    if (!mainWindow) {
      logger.warn('[Main] Main window not available for navigation');
      return { success: false, error: 'Main window not available' };
    }

    // Focus/show the main window
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();

    // Send navigation event to renderer
    mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_PAGE, payload);

    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Error navigating to page:', error);
    return { success: false, error: error.message };
  }
});
