import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
const { validateCloudFrontDomain } = require('../../utils/validateCloudFrontDomain');

declare const COBUILD_UPDATE_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILD_UPDATE_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let updateWindow: BrowserWindow | null = null;
let updaterConfigured = false;

function createUpdateWindow(version: string) {
  if (updateWindow) {
    updateWindow.focus();
    return;
  }

  updateWindow = new BrowserWindow({
    width: 400,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Update Available',
    show: false,
    webPreferences: {
      preload: COBUILD_UPDATE_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  updateWindow.loadURL(COBUILD_UPDATE_WINDOW_WEBPACK_ENTRY);

  updateWindow.once('ready-to-show', () => {
    updateWindow?.show();
    updateWindow?.webContents.send('cobuild:update-init', { version });
  });

  updateWindow.on('closed', () => {
    updateWindow = null;
  });
}

export function setupUpdater(onRebuildTrayMenu: (statusLabel?: string) => void) {
  if (!app.isPackaged) {
    log.info('[UPDATER] Skipping updater setup (not packaged).');
    return;
  }

  const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;
  if (!cloudFrontDomain || !validateCloudFrontDomain(cloudFrontDomain)) {
    log.warn('[UPDATER] Skipping updater setup (missing or invalid CLOUDFRONT_DOMAIN).');
    return;
  }

  autoUpdater.channel = 'cobuild';
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const arch = process.arch;
  const feedUrl = process.platform === 'darwin'
    ? `https://${cloudFrontDomain}/cobuild/${arch}`
    : `https://${cloudFrontDomain}/cobuild`;

  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  log.info('[UPDATER] Configured with feed URL:', feedUrl);

  autoUpdater.on('update-available', (info) => {
    log.info('[UPDATER] Update available:', info.version);
    createUpdateWindow(info.version);
    onRebuildTrayMenu();
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[UPDATER] No update available.');
    onRebuildTrayMenu('Up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    updateWindow?.webContents.send('cobuild:download-progress', { percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', () => {
    log.info('[UPDATER] Update downloaded, quitting and installing.');
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.on('error', (err) => {
    log.error('[UPDATER] Error:', err.message);
    updateWindow?.webContents.send('cobuild:update-error', { message: err.message });
    onRebuildTrayMenu();
  });

  updaterConfigured = true;
}

export function setupUpdaterIpcHandlers() {
  ipcMain.handle('cobuild:download-and-restart', () => {
    if (updaterConfigured) {
      return autoUpdater.downloadUpdate();
    }
    return null;
  });

  ipcMain.handle('cobuild:cancel-update', () => {
    updateWindow?.close();
    return null;
  });
}

export function isUpdaterConfigured(): boolean {
  return updaterConfigured;
}

export function checkForUpdates() {
  autoUpdater.checkForUpdates();
}
