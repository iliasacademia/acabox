import { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, nativeImage, shell, powerMonitor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import FormData from 'form-data';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { autoUpdater } from 'electron-updater';
import { store } from './appStore';
import AutoLaunch from 'auto-launch';
import { defaultLogger as logger, getChannelFromVersion } from './utils/logger';
import { login, logout, checkLogin, APIclient, getCsrfToken } from './apiClient';
import { callBackendApi } from './apiCall';
import { clearCachedUserData, fetchAndUpdateCache } from './userDataCache';
import { uploadFile, searchFiles, getStatus, addFolder, removeFolder, listFiles } from './uploader';
import { syncService } from './syncService';
import { projectSyncService } from './projectSyncService';
import { notificationManager } from './notificationManager';
import { eventsManager } from './eventsManager';
import { wordAccessibility } from './native/wordAccessibility';
import { AcademiaHttpServer } from './server/httpServer';
import { createQRAuthSession, verifyAuthCode } from './auth/qrAuthService';
import { validateExternalUrl } from './utils/urlValidation';
import { validateCloudFrontDomain } from './utils/validateCloudFrontDomain';
import { IPC_CHANNELS, NavigateToPagePayload, FEATURES } from './shared/types';
import { getDeviceId } from './utils/deviceId';
import { windowMonitorService } from './windowMonitorService';
import { wordIntegrationDataStoreV2 } from './wordIntegrationDataStoreV2';
import { sessionsTracker } from './sessionsTracker';
import { remoteFeatureFlags, REMOTE_FLAGS } from './remoteFeatureFlags';
import { sessionSyncService } from './sessionSyncService';
import { refreshManuscriptPaths } from './server/services/manuscriptPathsService';
import { podmanService } from './podmanService';
import { getLocalConversationDb } from './localConversationDb';
import { LocalAgentService } from './localAgentService';

// Set display name for menu bar (needed in dev mode where the binary is named "Electron")
app.setName('Writing Agent');
// Lock userData to the original path so renaming productName doesn't break existing user data
app.setPath('userData', path.join(app.getPath('appData'), 'academia-electron'));

// Register deep link protocol — must happen before app is ready
app.setAsDefaultProtocolClient('writing-agent');

// Pending deep link URL received before the main window was ready
let pendingDeepLinkUrl: string | null = null;

function handleDeepLinkUrl(url: string) {
  try {
    const parsed = new URL(url);
    const verificationCode = parsed.searchParams.get('verification_code');
    const deviceId = parsed.searchParams.get('device_id');
    if (!verificationCode || !/^\d{6}$/.test(verificationCode)) {
      logger.warn('[Deep Link] Received URL with missing or invalid verification_code:', url);
      return;
    }
    if (!deviceId) {
      logger.warn('[Deep Link] Received URL with missing device_id:', url);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send(IPC_CHANNELS.DEEP_LINK_CALLBACK, { verificationCode, deviceId });
    } else {
      pendingDeepLinkUrl = url;
    }
  } catch (err) {
    logger.error('[Deep Link] Failed to parse URL:', err);
  }
}

// macOS: deep link when app is already running
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('writing-agent://')) {
    handleDeepLinkUrl(url);
  }
});

const isSmokeTest = process.argv.includes('--smoke-test');
const ACTIVITY_FLUSH_INTERVAL_MS = 300_000; // 5 minutes

// Supported document extensions (without dots) for file selection and scanning
const SUPPORTED_DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt', 'md', 'tex', 'rtf'];

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Re-export store is imported from ./appStore


// Clean up deprecated updateChannel preference from electron-store
if (store.has('updateChannel')) {
  store.delete('updateChannel');
}

// Clean up deprecated popupVersion preference from electron-store
if (store.has('popupVersion')) {
  store.delete('popupVersion');
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
const localAgentService = new LocalAgentService();

// Flags for app lifecycle management
let isQuitting = false;
let isQuittingForUpdate = false;
let startupUpdatePhase: 'checking' | 'done' = 'done';
let updateCheckSource: 'startup' | 'hourly' | 'event' = 'startup';

const createWindow = async (): Promise<void> => {
  const isDevelopment = !app.isPackaged;
  const devPort = isDevelopment ? new URL(MAIN_WINDOW_WEBPACK_ENTRY).port : '';
  const devTitle = devPort ? `Development Mode (port ${devPort})` : 'Development Mode';

  devWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: true, // Use native window frame with full title bar and border
    title: isDevelopment ? devTitle : '', // Show "Development Mode" in dev, empty in production
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
      ? "script-src 'self' 'unsafe-eval' https://edge.fullstory.com; "
      : "script-src 'self' https://edge.fullstory.com; ";

    const styleSrc = isDevelopment
      ? "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
      : "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; ";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          styleSrc +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data: https://*.gravatar.com https://rs.fullstory.com;" +
          scriptSrc +
          "worker-src 'self' blob:; " +
          "connect-src 'self' https://api.academia.edu https://www.academia.edu https://www.google.com https://*.sentry.io https://rs.fullstory.com https://*.fullstory.com;" +
          "object-src 'none'; " +
          "base-uri 'self'; " +
          "form-action 'self'; " +
          "frame-ancestors 'none'"
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
  const isDevelopment = !app.isPackaged;
  const devPort = isDevelopment ? new URL(MAIN_WINDOW_WEBPACK_ENTRY).port : '';
  const devTitle = devPort ? `Development Mode (port ${devPort})` : 'Development Mode';

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    frame: true, // Use native window frame with full title bar and border
    title: isDevelopment ? devTitle : '', // Show "Development Mode" in dev, empty in production
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
      ? "script-src 'self' 'unsafe-eval' https://edge.fullstory.com; "
      : "script-src 'self' https://edge.fullstory.com; ";

    const styleSrc = isDevelopment
      ? "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
      : "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; ";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          styleSrc +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data: https://*.gravatar.com https://rs.fullstory.com;" +
          scriptSrc +
          "worker-src 'self' blob:; " +
          "connect-src 'self' https://api.academia.edu https://www.academia.edu https://www.google.com https://*.sentry.io https://rs.fullstory.com https://*.fullstory.com;" +
          "object-src 'none'; " +
          "base-uri 'self'; " +
          "form-action 'self'; " +
          "frame-ancestors 'none'"
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

  // Initialize events manager with main window
  eventsManager.setMainWindow(mainWindow);

  // Initialize local agent service with main window
  localAgentService.setMainWindow(mainWindow);

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
        mainWindow?.webContents.send(IPC_CHANNELS.ACCESSIBILITY_PERMISSION_STATUS, { hasPermission });
      } catch (error) {
        logger.error('[Permissions] Error checking permission on startup:', error);
      }
    }
  });

  // Show window when ready — but only if the startup update phase is done.
  // If an update check is in progress, the window will be shown after it completes.
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && startupUpdatePhase === 'done') {
      mainWindow.show();
    }
  });

  // Prevent window from being destroyed on close (macOS behavior)
  mainWindow.on('close', (event) => {
    // On macOS in production, hide window instead of closing it
    // In development, let it close normally so Ctrl+C works
    // Exception: Allow window to close when quitting for update
    if (process.platform === 'darwin' && app.isPackaged && !isQuittingForUpdate) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Handle window destruction (only when actually destroyed, e.g., on quit)
  mainWindow.on('closed', () => {
    logger.setMainWindow(null);
    mainWindow = null;
  });
};

const createTray = (): void => {
  const iconPath = path.join(__dirname, 'assets/icons/dock-icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    logger.error('[TRAY] Failed to load dock icon from', iconPath);
    return;
  }
  icon = icon.resize({ width: 22, height: 22 });

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
      },
      {
        label: 'Sync Sessions',
        click: () => {
          sessionSyncService.syncNow(sessionsTracker);
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
    },
    {
      label: 'Reset App Monitoring',
      click: () => {
        try {
          windowMonitorService.restart();
        } catch (error) {
          logger.error('[TRAY] Failed to reset app monitoring:', error);
        }
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

// Position Word on the left 66.5% and Academia app on the right 33.5% of the screen
const arrangeSideBySideWithWord = (): void => {
  if (process.platform !== 'darwin') return;
  if (!mainWindow) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const workArea = primaryDisplay.workArea;
  const wordWidth = Math.floor(screenWidth * 0.665);
  const appWidth = screenWidth - wordWidth;

  // Move Academia app to right 33.5%
  const appX = workArea.x + wordWidth;
  mainWindow.setBounds({ x: appX, y: workArea.y, width: appWidth, height: screenHeight }, true);
  logger.info('[Window] Positioned Academia on right 33.5% of screen');

  // Move Word to left 66.5% — poll until Word has a window open (up to ~5s)
  const wordLeft = workArea.x;
  const wordRight = workArea.x + wordWidth;
  const bottom = workArea.y + screenHeight;
  execFile('osascript', [
    '-e', 'repeat 10 times',
    '-e', 'try',
    '-e', 'tell application "Microsoft Word"',
    '-e', 'if (count of windows) > 0 then',
    '-e', `set bounds of window 1 to {${wordLeft}, ${workArea.y}, ${wordRight}, ${bottom}}`,
    '-e', 'exit repeat',
    '-e', 'end if',
    '-e', 'end tell',
    '-e', 'end try',
    '-e', 'delay 0.5',
    '-e', 'end repeat',
  ], (error) => {
    if (error) logger.warn('[Window] Failed to position Word:', error.message);
    else logger.info('[Window] Positioned Word on left 66.5% of screen');
  });
};

// Auto-updater configuration and setup
// Returns a Promise that resolves when the startup update check is complete.
// During startup, updates are downloaded silently and installed before the window shows.
type UpdateResult = 'update-installing' | 'no-update' | 'error' | 'timeout';

function setupAutoUpdater(): Promise<UpdateResult> {
  // Only enable auto-updater in production (packaged app)
  if (!app.isPackaged) {
    logger.info('[Auto-Updater] Disabled in development mode');
    return Promise.resolve('no-update');
  }

  // Configure electron-updater
  autoUpdater.autoDownload = true; // Auto-download for seamless startup updates
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
    return Promise.resolve('no-update');
  }

  // Security validation: Verify domain matches CloudFront pattern
  if (!validateCloudFrontDomain(cloudFrontDomain)) {
    logger.error(
      '[Auto-Updater] SECURITY ERROR: Invalid CLOUDFRONT_DOMAIN detected',
      `Provided value: "${cloudFrontDomain}"`,
      'Domain must match *.cloudfront.net pattern',
      'Auto-updates have been disabled to prevent malicious update server redirection'
    );
    return Promise.resolve('no-update');
  }

  // electron-updater will automatically append platform-specific manifest:
  // - macOS: {channel}-mac.yml
  // - Windows: {channel}.yml (Squirrel.Windows)
  // For macOS, include architecture in path for arm64/x64 specific builds
  const arch = process.arch; // 'arm64' or 'x64'
  const feedUrl = process.platform === 'darwin'
    ? `https://${cloudFrontDomain}/${channel}/${arch}`
    : `https://${cloudFrontDomain}/${channel}`;
  logger.info(`[Auto-Updater] Platform: ${process.platform}`);
  logger.info(`[Auto-Updater] Architecture: ${arch}`);
  logger.info(`[Auto-Updater] Feed URL configured: ${feedUrl}`);
  logger.info('[Auto-Updater] Security: CloudFront domain validation passed');

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedUrl,
  });

  // Mark that we're in the startup update phase
  startupUpdatePhase = 'checking';

  return new Promise<UpdateResult>((resolve) => {
    let settled = false;
    const settle = (result: UpdateResult) => {
      if (settled) return;
      settled = true;
      startupUpdatePhase = 'done';
      autoUpdater.autoDownload = false; // Disable auto-download after startup
      resolve(result);
    };

    // 30-second timeout — if check+download isn't complete, show the app
    const startupTimeout = setTimeout(() => {
      logger.info('[Auto-Updater] Startup timeout reached (30s), showing app');
      settle('timeout');
    }, 30000);

    const clearStartupTimeout = () => clearTimeout(startupTimeout);

    // Event: Checking for updates
    autoUpdater.on('checking-for-update', () => {
      logger.info('[Auto-Updater] Checking for updates...');
    });

    // Event: Update available - during startup, download is automatic (autoDownload=true)
    // During running mode (hourly checks), send to renderer for banner display
    autoUpdater.on('update-available', (info) => {
      logger.info('[Auto-Updater] Update available:', info.version);

      const formattedVersion = formatTimestampVersion(info.version);

      // Only act if startup phase is done (mid-session checks)
      if (startupUpdatePhase === 'done') {
        if (updateCheckSource === 'event') {
          // Resume/unlock: auto-download silently
          autoUpdater.downloadUpdate().catch((err) => {
            logger.error('[Auto-Updater] Auto-download after event check failed:', err);
          });
        } else {
          // Hourly: show banner, wait for user to click Download
          mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_AVAILABLE, {
            version: info.version,
            formattedVersion: formattedVersion,
          });
        }
      }
    });

    // Event: Update not available - silent, just log
    autoUpdater.on('update-not-available', (info) => {
      logger.info('[Auto-Updater] No updates available. Current version is latest:', info.version);
      clearStartupTimeout();
      settle('no-update');
    });

    // Event: Update downloaded - during startup, restart immediately; during running, show banner
    autoUpdater.on('update-downloaded', (info) => {
      logger.info('[Auto-Updater] Update downloaded:', info.version);
      clearStartupTimeout();

      if (!settled) {
        // Startup phase: restart immediately before the window ever shows
        logger.info('[Auto-Updater] Startup: installing update immediately...');
        isQuittingForUpdate = true;
        settle('update-installing');
        autoUpdater.quitAndInstall(true, true); // isSilent=true, isForceRunAfter=true
      } else {
        // Running mode (hourly check or timeout): notify renderer and restart after delay
        mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOADED);
        setTimeout(() => {
          logger.info('[Auto-Updater] Auto-restarting to install update...');
          store.set('updateRestartWindowVisible', mainWindow?.isVisible() ?? true);
          isQuittingForUpdate = true;
          autoUpdater.quitAndInstall(true, true);
        }, 1500);
      }
    });

    // Event: Error - during startup, show app normally; during running, show banner
    autoUpdater.on('error', (error) => {
      logger.error('[Auto-Updater] Error occurred:', {
        message: error.message,
        code: (error as any).code,
        stack: error.stack,
        name: error.name,
      });

      clearStartupTimeout();

      if (!settled) {
        // Startup phase: show app normally
        settle('error');
      } else {
        // Running mode: send to renderer for banner
        mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_ERROR, {
          message: error.message || 'Download failed',
        });
      }
    });

    // Event: Download progress - only send to renderer if startup phase is done
    autoUpdater.on('download-progress', (progressInfo) => {
      const percent = Math.round(progressInfo.percent);
      logger.info(`[Auto-Updater] Download progress: ${percent}%`);

      if (startupUpdatePhase === 'done') {
        mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, {
          percent: percent,
        });
      }
    });

    // Check for updates immediately on startup (no delay)
    logger.info('[Auto-Updater] Performing initial update check...');
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error('[Auto-Updater] Failed to check for updates:', err);
      clearStartupTimeout();
      settle('error');
    });

    // Check for updates every hour (3600000ms = 1 hour)
    setInterval(() => {
      logger.info('[Auto-Updater] Performing hourly update check...');
      updateCheckSource = 'hourly';
      autoUpdater.checkForUpdates().catch((err) => {
        logger.error('[Auto-Updater] Hourly check failed:', err);
      });
    }, 3600000);

    // Check for updates when system resumes from sleep
    powerMonitor.on('resume', () => {
      logger.info('[Auto-Updater] System resumed from sleep, checking for updates...');
      updateCheckSource = 'event';
      autoUpdater.checkForUpdates().catch((err) => {
        logger.error('[Auto-Updater] Resume check failed:', err);
      });
    });

    // Restart app monitoring on wake to clear stale webview panels
    powerMonitor.on('resume', () => {
      logger.info('[WindowMonitorService] System resumed from sleep, restarting app monitoring...');
      windowMonitorService.restart();
    });

    // Check for updates when screen is unlocked (covers lock-without-sleep case)
    powerMonitor.on('unlock-screen', () => {
      logger.info('[Auto-Updater] Screen unlocked, checking for updates...');
      updateCheckSource = 'event';
      autoUpdater.checkForUpdates().catch((err) => {
        logger.error('[Auto-Updater] Unlock-screen check failed:', err);
      });
    });
  });
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
  // Start activity tracking (before login — app session with user_id = null)
  if (FEATURES.SESSION_CAPTURE_ENABLED) {
    sessionsTracker.recordAppStarted();
    sessionsTracker.startPeriodicFlush(ACTIVITY_FLUSH_INTERVAL_MS);
    sessionSyncService.start(sessionsTracker, ACTIVITY_FLUSH_INTERVAL_MS);
  }

  // Create main window (always)
  createMainWindow();

  // Dispatch any deep link URL that arrived before the window was ready
  if (pendingDeepLinkUrl && mainWindow && !mainWindow.isDestroyed()) {
    const urlToDispatch = pendingDeepLinkUrl;
    pendingDeepLinkUrl = null;
    mainWindow.webContents.once('did-finish-load', () => {
      handleDeepLinkUrl(urlToDispatch);
    });
  }

  // Only create dev window in development mode
  if (process.env.NODE_ENV === 'development') {
    createWindow();
  }
  createTray();

  // Set dock icon to the Academia logo on black background
  const dock = process.platform === 'darwin' ? app.dock : null;
  if (dock) {
    dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets/icons/dock-icon.png')));
  }

  // Setup auto-updater — wait for startup update check before showing the window.
  // If an update is downloaded during startup, the app restarts before showing anything.
  const updateResult = await setupAutoUpdater();
  logger.info(`[Auto-Updater] Startup update result: ${updateResult}`);

  if (updateResult === 'update-installing') {
    // App is about to quit and restart with the new version — don't show window or start services
    return;
  }

  // Check if previous launch saved a window-visibility preference (from update restart)
  const shouldShowWindow = store.get('updateRestartWindowVisible', true) as boolean;
  store.delete('updateRestartWindowVisible'); // One-time flag, clean up

  if (shouldShowWindow && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }

  // Start HTTP server for data fetching
  logger.debug('[HTTP Server] Starting HTTP server...');
  httpServer = new AcademiaHttpServer(
    notificationManager,
    () => notificationManager.getCurrentUserId()
  );

  // Set up navigation handler for HTTP API navigation requests
  httpServer.setNavigationHandler(async (payload) => {
    // Handle external URL navigation separately
    if (payload.page === 'external' && payload.url) {
      const validation = validateExternalUrl(payload.url);
      if (!validation.isValid) {
        logger.error('[Main] External URL validation failed:', validation.error);
        throw new Error(validation.error || 'Invalid URL');
      }
      logger.info('[Main] Opening external URL:', payload.url);
      await shell.openExternal(payload.url);
      return;
    }

    const sendNavigationEvent = () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        logger.warn('[Main] Main window not available for navigation after creation');
        return;
      }

      // Show and focus the main window
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      arrangeSideBySideWithWord();

      // Send navigation event to renderer
      mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
        page: payload.page,
        projectId: payload.projectId,
        conversationId: payload.conversationId,
        openDiffModal: payload.openDiffModal ?? false,
      } as NavigateToPagePayload);
    };

    // If main window exists, navigate immediately
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendNavigationEvent();
      return;
    }

    // Main window was closed, create it first
    logger.info('[Main] Main window not available, creating new window for navigation');
    await createMainWindow();

    // Wait for window to finish loading before sending navigation event
    if (mainWindow && !mainWindow.isDestroyed()) {
      await new Promise<void>((resolve) => {
        mainWindow!.webContents.once('did-finish-load', () => {
          sendNavigationEvent();
          resolve();
        });
      });
    }
  });

  try {
    const port = await httpServer.start();
    logger.debug(`[HTTP Server] ✓ Server started on port ${port}`);
    const baseUrl = httpServer.getBaseUrl();
    logger.debug(`[HTTP Server] Base URL: ${baseUrl}`);

    // Initialize local agent service with HTTP server info
    localAgentService.setHttpPort(port);
    const authToken = httpServer.getAuthToken();
    if (authToken) {
      localAgentService.setAuthToken(authToken);
    }

    if (FEATURES.MS_WORD_INTEGRATION_ENABLED && FEATURES.MS_WORD_V2_ENABLED) {
      if (baseUrl && authToken) {
        windowMonitorService.start(baseUrl, authToken, store.get('windowMonitorAllAppsEnabled', false) as boolean);
      }
    }
  } catch (error) {
    logger.error('[HTTP Server] ✗ Failed to start server:', error);
  }

  if (isSmokeTest) {
    console.log('[SMOKE TEST] All services started — shutting down');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Quit when all windows are closed, except on macOS in production
  // In development, always quit when windows are closed
  if (process.platform !== 'darwin' || !app.isPackaged) {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS, re-create or show the main window when dock icon is clicked
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else if (mainWindow) {
    // Window exists but might be hidden - show it
    mainWindow.show();
    mainWindow.focus();
  }
});

// refreshManuscriptPaths extracted to server/services/manuscriptPathsService.ts

// Helper function for cleanup
function cleanupNativeResources() {
  // V1 native cleanup removed — V2 cleanup handled by windowMonitorService
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
ipcMain.handle(IPC_CHANNELS.DEV_CLEANUP_NATIVE, async () => {
  logger.debug('[APP] Dev-mode cleanup requested');
  cleanupNativeResources();
  return { success: true };
});

ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, async () => {
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

ipcMain.handle(IPC_CHANNELS.SCHEDULE_POPUP_AUTO_OPEN, (_event, filePath: string) => {
  if (FEATURES.ONBOARDING_V3_ENABLED) {
    windowMonitorService.scheduleAutoOpenForPath(filePath);
  }
});

ipcMain.handle(IPC_CHANNELS.REVIEW_PRE_CHECK, async (_event, filePath: string) => {
  const { reviewPreCheck, wordSave } = await import('./server/wordActions');
  const wid = windowMonitorService.getWindowIdForDocumentPath(filePath);
  if (!wid) {
    logger.warn('[IPC] review-pre-check: no window found for path:', filePath);
    return { canProceed: true }; // fail-open
  }
  const windowId = parseInt(wid, 10);
  if (isNaN(windowId)) {
    return { canProceed: true };
  }
  const result = await reviewPreCheck(windowId);
  // Auto-save if "always save before review" is enabled
  if (!result.canProceed && result.reason === 'unsaved_changes' && store.get('alwaysSaveBeforeReview', false)) {
    logger.info('[IPC] Auto-saving before review (alwaysSaveBeforeReview is enabled)');
    const saveResult = await wordSave(windowId);
    if (saveResult.success) {
      // Sync file to backend before proceeding with review
      try {
        const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(filePath);
        if (projectFile) {
          await projectSyncService.syncFileOnce(projectFile.project_id, filePath);
        }
      } catch (syncErr) {
        logger.error('[IPC] Post-save sync error (non-fatal):', syncErr);
      }
      return { canProceed: true };
    }
    // If auto-save failed, fall through to show the prompt
  }
  return result;
});

ipcMain.handle(IPC_CHANNELS.WORD_SAVE_DOCUMENT, async (_event, filePath: string, alwaysSave?: boolean) => {
  const { wordSave } = await import('./server/wordActions');
  const wid = windowMonitorService.getWindowIdForDocumentPath(filePath);
  if (!wid) {
    return { success: false, error: 'No window found for path: ' + filePath };
  }
  const windowId = parseInt(wid, 10);
  if (isNaN(windowId)) {
    return { success: false, error: 'Invalid window ID' };
  }
  if (alwaysSave) {
    store.set('alwaysSaveBeforeReview', true);
    logger.info('[IPC] Setting alwaysSaveBeforeReview to true');
  }
  const result = await wordSave(windowId);
  if (result.success) {
    // Sync file to backend before returning so review uses latest content
    try {
      const projectFile = wordIntegrationDataStoreV2.getProjectFileForPath(filePath);
      if (projectFile) {
        await projectSyncService.syncFileOnce(projectFile.project_id, filePath);
      }
    } catch (syncErr) {
      logger.error('[IPC] Post-save sync error (non-fatal):', syncErr);
    }
  }
  return result;
});

ipcMain.handle(IPC_CHANNELS.GET_ALWAYS_SAVE_BEFORE_REVIEW, async () => {
  return store.get('alwaysSaveBeforeReview', false);
});

ipcMain.handle(IPC_CHANNELS.SET_ALWAYS_SAVE_BEFORE_REVIEW, async (_event, enabled: boolean) => {
  store.set('alwaysSaveBeforeReview', enabled);
});

// Feature flag IPC handlers
ipcMain.handle(IPC_CHANNELS.GET_ALL_APPS_MONITOR_ENABLED, async () => {
  return store.get('windowMonitorAllAppsEnabled', false);
});

ipcMain.handle(IPC_CHANNELS.SET_ALL_APPS_MONITOR_ENABLED, async (_event, enabled: boolean) => {
  store.set('windowMonitorAllAppsEnabled', enabled);
  if (app.isPackaged) {
    app.relaunch();
  }
  app.quit();
});

// Local Agent settings
ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_GET_API_KEY, () => {
  return store.get('bedrockApiKey', '');
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_SET_API_KEY, (_, key: string) => {
  store.set('bedrockApiKey', key);
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_GET_MODEL, () => {
  return store.get('localAgentModel', 'us.anthropic.claude-sonnet-4-6-20250514-v1:0');
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_SET_MODEL, (_, model: string) => {
  store.set('localAgentModel', model);
});

// Local Agent conversation handlers
ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_LIST_CONVERSATIONS, (_, data: { offset?: number; limit?: number; archived?: boolean }) => {
  const db = getLocalConversationDb();
  const offset = data.offset || 0;
  const limit = data.limit || 20;

  let conversations, totalCount;
  if (data.archived) {
    conversations = db.listArchivedConversations.all(limit, offset);
    totalCount = (db.countArchivedConversations.get() as any).count;
  } else {
    conversations = db.listConversations.all(limit, offset);
    totalCount = (db.countConversations.get() as any).count;
  }

  return {
    conversations,
    has_more: offset + conversations.length < totalCount,
    total_count: totalCount,
  };
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_GET_CONVERSATION, (_, conversationId: number) => {
  const db = getLocalConversationDb();
  const conversation = db.getConversation.get(conversationId);
  if (!conversation) return null;

  const messages = db.getMessages.all(conversationId);

  const formattedMessages = (messages as any[]).map(msg => ({
    ...msg,
    data: msg.data ? JSON.parse(msg.data) : null,
    contexts: [],
  }));

  return {
    conversation,
    messages: formattedMessages,
  };
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_CREATE_CONVERSATION, async (_, data: { content: string; agent_name: string; title?: string; manuscript_file_path?: string }) => {
  const userId = notificationManager.getCurrentUserId() || 0;
  const result = await localAgentService.createConversation(data.content, userId, data.manuscript_file_path);
  return { conversation: result.conversation };
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_SEND_MESSAGE, async (_, data: { conversation_id: number; content: string }) => {
  const userId = notificationManager.getCurrentUserId() || 0;
  await localAgentService.sendMessage(data.conversation_id, data.content, userId);

  const db = getLocalConversationDb();
  const messages = db.getMessages.all(data.conversation_id) as any[];
  const userMessage = messages.find(m => m.role === 'user' && m.content === data.content);

  return { message: userMessage ? { ...userMessage, data: null, contexts: [] } : {} };
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_STOP, (_, conversationId: number) => {
  localAgentService.stopConversation(conversationId);
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_ARCHIVE_CONVERSATION, (_, conversationId: number) => {
  const db = getLocalConversationDb();
  db.archiveConversation.run(new Date().toISOString(), conversationId);
});

ipcMain.handle(IPC_CHANNELS.LOCAL_AGENT_UNARCHIVE_CONVERSATION, (_, conversationId: number) => {
  const db = getLocalConversationDb();
  db.unarchiveConversation.run(conversationId);
});

// App lifecycle IPC handlers
ipcMain.handle(IPC_CHANNELS.RESTART_APP, () => {
  logger.info('[App] Restarting app to apply permission changes...');
  app.relaunch();
  app.quit();
});

ipcMain.handle(IPC_CHANNELS.CHECK_LOGIN, async () => {
  const result = await checkLogin();
  return result;
});

ipcMain.handle(IPC_CHANNELS.LOGIN, async (_event, email: string, password: string) => {
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

ipcMain.handle(IPC_CHANNELS.LOGOUT, async () => {
  const result = await logout();

  // Clear Word integration only after successful logout
  if (result.success) {
    // Close activity sessions and start new user-less app session
    if (FEATURES.SESSION_CAPTURE_ENABLED) {
      sessionsTracker.recordUserLoggedOut();
      sessionSyncService.stop();
    }

    // Stop polling
    notificationManager.stopPolling();
    eventsManager.stopPolling();

    // Clear cached user data
    clearCachedUserData();

    // Clear Word integration data
    if (FEATURES.MS_WORD_INTEGRATION_ENABLED && FEATURES.MS_WORD_V2_ENABLED) {
      wordIntegrationDataStoreV2.setProjectFileCache(new Map());
    }
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

// Open file in default application (Word for .docx)
ipcMain.handle(IPC_CHANNELS.OPEN_FILE, async (_event, filePath: string, page?: number) => {
  try {
    // If a page number is provided and the file is a PDF, use openExternal with a #page fragment.
    // shell.openPath does not support URL fragments.
    if (page && filePath.toLowerCase().endsWith('.pdf')) {
      const fileUrl = `file://${encodeURI(filePath)}#page=${page}`;
      await shell.openExternal(fileUrl);
      return { success: true };
    }
    const result = await shell.openPath(filePath);
    if (result) {
      // result is an error string if it failed, empty string if success
      logger.error('[Main] Failed to open file:', result);
      return { success: false, error: result };
    }
    // Arrange side-by-side for Word documents
    if (/\.docx?$/i.test(filePath)) {
      arrangeSideBySideWithWord();
    }
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to open file:', error);
    return { success: false, error: error.message };
  }
});

// Show file in Finder/Explorer
ipcMain.handle(IPC_CHANNELS.SHOW_FILE_IN_FOLDER, async (_event, filePath: string) => {
  try {
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to show file in folder:', error);
    return { success: false, error: error.message };
  }
});

// Check if file exists (with path validation to prevent traversal attacks)
ipcMain.handle(IPC_CHANNELS.CHECK_FILE_EXISTS, async (_event, filePath: string) => {
  try {
    // Validate that the path is within allowed directories
    const allowedBasePaths = [
      app.getPath('userData'),
      app.getPath('documents'),
      app.getPath('desktop'),
      app.getPath('downloads'),
      app.getPath('home')
    ];

    const resolvedPath = path.resolve(filePath);
    const isAllowed = allowedBasePaths.some(basePath =>
      resolvedPath.startsWith(path.resolve(basePath))
    );

    if (!isAllowed) {
      logger.warn('[Main] Rejected file access outside allowed paths:', filePath);
      return { exists: false, error: 'Access denied' };
    }

    const exists = fs.existsSync(resolvedPath);
    return { exists };
  } catch (error: any) {
    logger.error('[Main] Failed to check file existence:', error);
    return { exists: false, error: error.message };
  }
});

// QR Code Authentication IPC handlers
ipcMain.handle(IPC_CHANNELS.START_QR_AUTH, async () => {
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

ipcMain.handle(IPC_CHANNELS.VERIFY_QR_CODE, async (_event, deviceId: string, code: string) => {
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
ipcMain.handle(IPC_CHANNELS.START_PROJECT_FOLDER_FILE_SYNC, async (_event, projectId: number, folderId: number, folderPath: string, filePath: string) => {
  try {
    await projectSyncService.startWatchingFolderFile(projectId, folderId, folderPath, filePath);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to start project file sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.START_PROJECT_FOLDER_SYNC, async (_event, projectId: number, folderId: number, folderPath: string, manuscriptPath?: string) => {
  try {
    await projectSyncService.startWatching(projectId, folderId, folderPath, manuscriptPath);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to start project folder sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.UPDATE_PROJECT_MANUSCRIPT_PATH, async (_event, projectId: number, manuscriptPath: string) => {
  try {
    projectSyncService.updateManuscriptPath(projectId, manuscriptPath);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to update manuscript path:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.START_PROJECT_FILE_SYNC, async (_event, projectId: number, filePath: string) => {
  try {
    await projectSyncService.startWatchingFile(projectId, filePath);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to start project file sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.SYNC_PROJECT_FILE_ONCE, async (_event, projectId: number, filePath: string) => {
  try {
    await projectSyncService.syncFileOnce(projectId, filePath);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to sync file once:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.STOP_PROJECT_FOLDER_SYNC, async (_event, projectId: number, folderId: number) => {
  try {
    await projectSyncService.stopWatching(projectId, folderId);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to stop project folder sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.STOP_PROJECT_SYNC, async (_event, projectId: number) => {
  try {
    await projectSyncService.stopWatchingProject(projectId);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to stop project sync:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEAR_NOTIFICATIONS_FOR_PROJECT, async (_event, projectId: number) => {
  try {
    notificationManager.clearNotificationsForProject(projectId);
    return { success: true };
  } catch (error: any) {
    logger.error('[IPC] Failed to clear notifications for project:', error);
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

// Generic API call handler — delegates to shared callBackendApi helper
ipcMain.handle(IPC_CHANNELS.API_CALL, async (_event, options: { method: string; endpoint: string; data?: any }) => {
  return callBackendApi({
    method: options.method.toUpperCase() as any,
    endpoint: options.endpoint,
    data: options.data,
  });
});

ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async (event) => {
  // Determine which window is requesting the dialog
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return;

  const result = await dialog.showOpenDialog(senderWindow, {
    properties: ['openDirectory'],
  });
  return result.filePaths[0];
});

ipcMain.handle(IPC_CHANNELS.SELECT_FILE, async (event, options?: string | { defaultPath?: string; extensions?: string[]; multiSelection?: boolean }) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return;

  // Support both old signature (defaultPath string) and new (options object)
  const defaultPath = typeof options === 'string' ? options : options?.defaultPath;
  const extensions = (typeof options === 'object' && options?.extensions) || SUPPORTED_DOCUMENT_EXTENSIONS;
  const multiSelection = typeof options === 'object' && options?.multiSelection;

  const properties: ('openFile' | 'multiSelections')[] = ['openFile'];
  if (multiSelection) {
    properties.push('multiSelections');
  }

  const result = await dialog.showOpenDialog(senderWindow, {
    defaultPath,
    properties,
    filters: [
      { name: 'Documents', extensions }
    ]
  });

  // Return array if multiSelection, single path otherwise for backwards compatibility
  return multiSelection ? result.filePaths : result.filePaths[0];
});

// Create conversation (multipart/form-data, file optional)
ipcMain.handle(IPC_CHANNELS.CREATE_CONVERSATION_WITH_FILE, async (_event, data: {
  content?: string;
  agent_name?: string;
  title?: string;
  project_id?: number;
  project_file_ids?: number[];
  filePath?: string;
}) => {
  try {
    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    const formData = new FormData();
    if (data.content) formData.append('content', data.content);
    if (data.agent_name) formData.append('agent_name', data.agent_name);
    if (data.title) formData.append('title', data.title);
    if (data.project_id) {
      formData.append('parent_id', data.project_id.toString());
      formData.append('parent_type', 'Project');
    }
    if (data.project_file_ids && data.project_file_ids.length > 0) {
      data.project_file_ids.forEach(id => formData.append('project_file_ids[]', id.toString()));
    }
    if (data.filePath && fs.existsSync(data.filePath)) {
      formData.append('file', fs.createReadStream(data.filePath));
    }

    logger.debug(`[IPC] create-conversation-with-file → POST v0/co_scientist/create_conversation (hasFile=${!!data.filePath})`);

    const response = await client.post('v0/co_scientist/create_conversation', formData, {
      headers: {
        'x-csrf-token': csrfToken,
        ...formData.getHeaders(),
      },
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      let backendError: string | null = null;
      if (response.data?.error) backendError = response.data.error;
      else if (response.data?.errors) {
        const errors = response.data.errors;
        if (Array.isArray(errors)) backendError = errors.join(', ');
        else if (typeof errors === 'object') backendError = Object.values(errors).flat().join(', ');
      }
      throw new Error(backendError || `Request failed with status code ${response.status}`);
    }

    return response.data;
  } catch (error: any) {
    logger.error('[IPC] Error creating conversation:', error);
    throw error;
  }
});

// Send message (multipart/form-data, file optional)
ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE_WITH_FILE, async (_event, data: {
  conversation_id: number;
  content?: string;
  project_id?: number;
  project_file_ids?: number[];
  filePath?: string;
}) => {
  try {
    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    const formData = new FormData();
    formData.append('conversation_id', data.conversation_id.toString());
    formData.append('content', data.content ?? '');
    if (data.project_id) {
      formData.append('parent_id', data.project_id.toString());
      formData.append('parent_type', 'Project');
    }
    if (data.project_file_ids && data.project_file_ids.length > 0) {
      data.project_file_ids.forEach(id => formData.append('project_file_ids[]', id.toString()));
    }
    if (data.filePath && fs.existsSync(data.filePath)) {
      formData.append('file', fs.createReadStream(data.filePath));
    }

    logger.debug(`[IPC] send-message-with-file → POST v0/co_scientist/create_message (conversation_id=${data.conversation_id}, hasFile=${!!data.filePath})`);

    const response = await client.post(
      'v0/co_scientist/create_message',
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
      let backendError: string | null = null;
      if (response.data?.error) backendError = response.data.error;
      else if (response.data?.errors) {
        const errors = response.data.errors;
        if (Array.isArray(errors)) backendError = errors.join(', ');
        else if (typeof errors === 'object') backendError = Object.values(errors).flat().join(', ');
      }
      throw new Error(backendError || `Request failed with status code ${response.status}`);
    }

    return response.data;
  } catch (error: any) {
    logger.error('[IPC] Error sending message:', error);
    throw error;
  }
});

// Upload supporting material
ipcMain.handle(IPC_CHANNELS.UPLOAD_SUPPORTING_MATERIAL, async (_event, data: { projectId: number; filePath: string; category?: string }) => {
  try {
    logger.debug(`[IPC] Uploading supporting material: ${data.filePath} for project ${data.projectId}`);
    const result = await projectSyncService.uploadSupportingMaterial(
      data.projectId,
      data.filePath,
      data.category || 'reference'
    );

    if (result.success) {
      logger.debug(`[IPC] Successfully uploaded supporting material, file ID: ${result.file?.id}`);
      return {
        file: result.file,
        uploaded: true
      };
    } else {
      logger.error(`[IPC] Failed to upload supporting material: ${result.error}`);
      throw new Error(result.error || 'Upload failed');
    }
  } catch (error: any) {
    logger.error('[IPC] Error uploading supporting material:', error);
    throw error;
  }
});

// Scan folder for files
ipcMain.handle(IPC_CHANNELS.SCAN_FOLDER_FOR_FILES, async (_event, folderPaths: string[]) => {
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
              const ext = path.extname(fullPath).toLowerCase().slice(1); // Remove leading dot

              if (SUPPORTED_DOCUMENT_EXTENSIONS.includes(ext)) {
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

ipcMain.handle(IPC_CHANNELS.UPLOAD_FILES, async (_event, folderPath: string) => {
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

ipcMain.handle(IPC_CHANNELS.SEARCH_FILES, async (_event, searchTerm: string) => {
  const results = await searchFiles(searchTerm);
  return results;
});

// Notification IPC handlers
ipcMain.handle(IPC_CHANNELS.GET_NOTIFICATIONS, async (_event, options?: { status?: 'unread' | 'read' | 'dismissed'; userId?: number }) => {
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

ipcMain.handle(IPC_CHANNELS.START_NOTIFICATION_POLLING, async (_event, userId: number) => {
  try {
    if (FEATURES.SESSION_CAPTURE_ENABLED) {
      sessionsTracker.recordUserLoggedIn(userId);
      sessionSyncService.start(sessionsTracker, ACTIVITY_FLUSH_INTERVAL_MS);
    }
    notificationManager.startPolling(userId, 30000); // 30 second interval
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to start notification polling:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.STOP_NOTIFICATION_POLLING, async () => {
  try {
    notificationManager.stopPolling();
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to stop notification polling:', error);
    return { success: false, error: error.message };
  }
});

// Events polling handlers
ipcMain.handle(IPC_CHANNELS.START_EVENTS_POLLING, async (_event, userId: number) => {
  try {
    eventsManager.startPolling(userId, 10000); // 10 second interval
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to start events polling:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.STOP_EVENTS_POLLING, async () => {
  try {
    eventsManager.stopPolling();
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Failed to stop events polling:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.MARK_NOTIFICATION_READ, async (_event, id: number) => {
  try {
    await notificationManager.markAsRead(id);

    // WAGENT-94: Badge updates handled by new architecture

    return { success: true };
  } catch (error: any) {
    logger.error('Failed to mark notification as read:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.DISMISS_NOTIFICATION, async (_event, id: number) => {
  try {
    await notificationManager.dismissNotification(id);

    // WAGENT-94: Badge updates handled by new architecture

    return { success: true };
  } catch (error: any) {
    logger.error('Failed to dismiss notification:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.GET_CURRENT_USER, async () => {
  return await fetchAndUpdateCache();
});

// System IPC handlers
ipcMain.handle(IPC_CHANNELS.GET_DEVICE_ID, () => {
  return getDeviceId();
});

ipcMain.handle(IPC_CHANNELS.GET_APP_INFO, () => {
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  };
});

// HTTP Server IPC handlers
ipcMain.handle(IPC_CHANNELS.GET_HTTP_SERVER_INFO, async () => {
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
app.on('before-quit', async (event) => {
  // If quitting for update, allow it to proceed naturally
  if (isQuittingForUpdate) {
    logger.info('[APP] Quitting for update installation - skipping cleanup');
    return; // Let update process handle quit
  }

  if (isQuitting) {
    return; // Already quitting, let it proceed
  }

  // Prevent quit until cleanup is done
  event.preventDefault();
  isQuitting = true;

  logger.debug('[APP] Application quitting - cleaning up resources...');

  // Set a timeout to force quit if cleanup hangs
  const forceQuitTimeout = setTimeout(() => {
    logger.warn('[APP] Cleanup timeout - forcing quit');
    app.exit(0);
  }, 5000); // 5 second timeout

  try {
    // Close all activity sessions and stop periodic flush
    if (FEATURES.SESSION_CAPTURE_ENABLED) {
      sessionsTracker.recordAppStopping();
      sessionsTracker.stopPeriodicFlush();
      sessionSyncService.stop();
    }

    // Stop window monitor service (V2 Rust processes)
    windowMonitorService.stop();

    // Stop Podman container if running
    podmanService.stop();

    // Stop all sync watchers
    logger.debug('[APP] Stopping sync watchers...');
    await syncService.stopAll();

    // Stop notification polling and cleanup
    logger.debug('[APP] Closing notification manager...');
    notificationManager.close();

    // Stop events polling and cleanup
    logger.debug('[APP] Closing events manager...');
    eventsManager.close();

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
    clearTimeout(forceQuitTimeout);
    app.exit(0); // Force exit after cleanup
  } catch (error) {
    logger.error('[APP] Error during cleanup:', error);
    clearTimeout(forceQuitTimeout);
    app.exit(1);
  }
});

// Sync Folder IPC handlers
ipcMain.handle(IPC_CHANNELS.GET_SYNC_FOLDERS, async () => {
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

ipcMain.handle(IPC_CHANNELS.ADD_SYNC_FOLDER, async (_event, folderPath: string) => {
  try {
    logger.debug('[ADD-SYNC-FOLDER] Starting to add folder:', folderPath);
    const folderName = path.basename(folderPath);
    logger.debug('[ADD-SYNC-FOLDER] Folder name:', folderName);

    logger.debug('[ADD-SYNC-FOLDER] Calling backend to register folder...');
    const response = await addFolder(folderName, folderPath);
    logger.debug(`[ADD-SYNC-FOLDER] Backend response: ${response.status} ${JSON.stringify(response.data)}`);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to add folder: ${response.status}`);
    }

    const folder = response.data.folder;
    logger.debug(`[ADD-SYNC-FOLDER] Folder registered: ${JSON.stringify(folder)}`);

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

ipcMain.handle(IPC_CHANNELS.REMOVE_SYNC_FOLDER, async (_event, folderId: string) => {
  try {
    await syncService.stopWatching(folderId);
    await removeFolder(folderId);
    return { success: true };
  } catch (error: any) {
    logger.error('Failed to remove sync folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle(IPC_CHANNELS.SYNC_FOLDER_NOW, async (_event, folderId: string) => {
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

ipcMain.handle(IPC_CHANNELS.GET_FOLDER_FILES, async (_event, folderId: string) => {
  try {
    logger.debug('[GET-FOLDER-FILES] Fetching files for folder:', folderId);
    const filesData = await listFiles(folderId);
    logger.debug('[GET-FOLDER-FILES] Received data from backend:', JSON.stringify(filesData, null, 2));

    if (!filesData || !filesData.files) {
      logger.error(`[GET-FOLDER-FILES] Invalid response structure: ${JSON.stringify(filesData)}`);
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

// Window control handlers
ipcMain.handle(IPC_CHANNELS.MINIMIZE_WINDOW, async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow) {
    senderWindow.minimize();
    return { success: true };
  }
  return { success: false, error: 'Window not found' };
});

ipcMain.handle(IPC_CHANNELS.CLOSE_WINDOW, async (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow) {
    senderWindow.close();
    return { success: true };
  }
  return { success: false, error: 'Window not found' };
});

// Handle position debug info request
ipcMain.handle(IPC_CHANNELS.GET_POSITION_DEBUG_INFO, async () => {
  return {};
});

// Handle get all notifications request for debugging
ipcMain.handle(IPC_CHANNELS.GET_ALL_NOTIFICATIONS, async () => {
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

const execAsync = promisify(exec);

async function isZoteroRunning(): Promise<boolean> {
  try {
    await execAsync('pgrep -ix zotero');
    return true;
  } catch {
    return false; // pgrep exits with code 1 if no match
  }
}

async function waitForZotero(timeoutMs = 3000, intervalMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isZoteroRunning()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  // Proceed anyway after timeout — Zotero may still handle it
}

ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (_event, url: string) => {
  try {
    // Validate URL against whitelist before opening
    const validation = validateExternalUrl(url);
    if (!validation.isValid) {
      logger.error('[Main] URL validation failed:', validation.error);
      return { success: false, error: validation.error };
    }

    // For zotero:// deep links, ensure Zotero is running before sending the link
    if (url.startsWith('zotero://')) {
      const isRunning = await isZoteroRunning();
      if (!isRunning) {
        logger.info('[Main] Zotero not running, launching and waiting before sending deep link');
        // Launch Zotero by opening the deep link
        await shell.openExternal(url);
        // Wait for Zotero to initialize, then re-send the deep link
        await waitForZotero();
        await shell.openExternal(url);
        return { success: true };
      }
    }

    await shell.openExternal(url);
    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});

// Podman sandbox handlers
ipcMain.handle(IPC_CHANNELS.PODMAN_GET_STATUS, async () => {
  return { running: podmanService.isRunning() };
});

ipcMain.handle(IPC_CHANNELS.PODMAN_OPEN_SANDBOX, async () => {
  if (podmanService.isRunning()) {
    const url = podmanService.getShellUrl();
    if (url) await shell.openExternal(url);
    return { success: true, shellUrl: url, previewUrl: podmanService.getPreviewUrl() };
  }

    // Show a progress window during setup
    const progressWindow = new BrowserWindow({
      width: 420,
      height: 280,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const progressHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head><style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 24px;
               background: #1e1e1e; color: #e0e0e0; display: flex; flex-direction: column; justify-content: center;
               -webkit-app-region: drag; height: 100vh; box-sizing: border-box; }
        h3 { margin: 0 0 8px 0; font-size: 14px; font-weight: 600; }
        #status { font-size: 12px; color: #aaa; word-break: break-word; }
        #error { display: none; margin-top: 12px; }
        #error h3 { color: #ff6b6b; }
        #error p { font-size: 12px; color: #ccc; margin: 4px 0 0 0; word-break: break-word; }
        #closeBtn { display: none; margin-top: 12px; padding: 6px 16px; background: #444; color: #e0e0e0;
                     border: none; border-radius: 4px; cursor: pointer; font-size: 12px; -webkit-app-region: no-drag; }
        #closeBtn:hover { background: #555; }
      </style></head>
      <body>
        <div id="progress">
          <h3>Starting Sandbox...</h3>
          <div id="status">Initializing...</div>
        </div>
        <div id="error">
          <h3>Error</h3>
          <p id="errorMsg"></p>
        </div>
        <button id="closeBtn">Close</button>
      </body>
      </html>
    `)}`;

    progressWindow.loadURL(progressHtml);
    progressWindow.once('ready-to-show', () => progressWindow.show());

    try {
      const skipChecksum = store.get('podmanSkipChecksum', false) as boolean;
      const extraDomains = (store.get('podmanTrustedDomains', []) as string[]);
      const allowAllTraffic = store.get('podmanAllowAllTraffic', false) as boolean;
      await podmanService.start((stage, message) => {
        if (!progressWindow.isDestroyed()) {
          progressWindow.webContents.executeJavaScript(
            `document.getElementById('status').textContent = ${JSON.stringify(message)};`
          ).catch(() => {});
        }
      }, skipChecksum, extraDomains, allowAllTraffic);

      // Success — close the progress window
      if (!progressWindow.isDestroyed()) {
        progressWindow.close();
      }

      const shellUrl = podmanService.getShellUrl();
      if (shellUrl) await shell.openExternal(shellUrl);
      return { success: true, shellUrl, previewUrl: podmanService.getPreviewUrl() };
    } catch (error: unknown) {
      const logPath = path.join(app.getPath('userData'), 'podman-dev.log');
      const message = error instanceof Error ? error.message : String(error);

      // Show the error in the progress window and wait for Close button click
      if (!progressWindow.isDestroyed()) {
        const errorText = `${message}\\n\\nSee logs at: ${logPath}`;
        await progressWindow.webContents.executeJavaScript(`
          document.getElementById('progress').style.display = 'none';
          document.getElementById('error').style.display = 'block';
          document.getElementById('errorMsg').textContent = ${JSON.stringify(errorText)};
          document.getElementById('closeBtn').style.display = 'inline-block';
          new Promise(resolve => document.getElementById('closeBtn').addEventListener('click', resolve, { once: true }));
        `).catch(() => {});
        if (!progressWindow.isDestroyed()) {
          progressWindow.close();
        }
      }

      return { success: false, error: message, logPath };
    }
});

ipcMain.handle(IPC_CHANNELS.PODMAN_OPEN_PREVIEW, async () => {
  if (!podmanService.isRunning()) {
    return { success: false, error: 'Sandbox is not running. Open it first.' };
  }
  const url = podmanService.getPreviewUrl();
  if (url) await shell.openExternal(url);
  return { success: true };
});

ipcMain.handle(IPC_CHANNELS.PODMAN_OPEN_FOLDER, async () => {
  const folderPath = path.join(app.getPath('userData'), 'podman');
  // Ensure the folder exists
  const fs = require('fs');
  fs.mkdirSync(folderPath, { recursive: true });
  await shell.openPath(folderPath);
  return { success: true };
});


ipcMain.handle(IPC_CHANNELS.PODMAN_STOP, async () => {
  try {
    podmanService.stop();
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

ipcMain.handle(IPC_CHANNELS.PODMAN_UNINSTALL, async () => {
  try {
    await podmanService.uninstall();
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
});

ipcMain.handle(IPC_CHANNELS.PODMAN_GET_SKIP_CHECKSUM, async () => {
  return store.get('podmanSkipChecksum', false);
});

ipcMain.handle(IPC_CHANNELS.PODMAN_SET_SKIP_CHECKSUM, async (_event, enabled: boolean) => {
  store.set('podmanSkipChecksum', enabled);
  return { success: true };
});

ipcMain.handle(IPC_CHANNELS.PODMAN_GET_TRUSTED_DOMAINS, async () => {
  return store.get('podmanTrustedDomains', []);
});

ipcMain.handle(IPC_CHANNELS.PODMAN_SET_TRUSTED_DOMAINS, async (_event, domains: string[]) => {
  // Validate each domain
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*$/;
  const valid = domains.every(d => typeof d === 'string' && domainRegex.test(d));
  if (!valid) {
    return { success: false, error: 'Invalid domain format' };
  }
  store.set('podmanTrustedDomains', domains);
  return { success: true };
});

ipcMain.handle(IPC_CHANNELS.PODMAN_GET_ALLOW_ALL_TRAFFIC, async () => {
  return store.get('podmanAllowAllTraffic', false);
});

ipcMain.handle(IPC_CHANNELS.PODMAN_SET_ALLOW_ALL_TRAFFIC, async (_event, enabled: boolean) => {
  store.set('podmanAllowAllTraffic', enabled);
  return { success: true };
});

ipcMain.handle(IPC_CHANNELS.PODMAN_UPDATE_FIREWALL, async () => {
  try {
    if (!podmanService.isRunning()) {
      return { success: false, error: 'Sandbox is not running' };
    }
    const extraDomains = (store.get('podmanTrustedDomains', []) as string[]);
    const allowAllTraffic = store.get('podmanAllowAllTraffic', false) as boolean;
    await podmanService.updateFirewall(extraDomains, allowAllTraffic);
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
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
    arrangeSideBySideWithWord();

    // Send navigation event to renderer
    mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_PAGE, payload);

    return { success: true };
  } catch (error: any) {
    logger.error('[Main] Error navigating to page:', error);
    return { success: false, error: error.message };
  }
});
