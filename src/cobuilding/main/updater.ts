import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

declare const COBUILD_UPDATE_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILD_UPDATE_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// --- Release feed configuration -------------------------------------------
// Acabox publishes packaged binaries + electron-updater metadata to GitHub
// Releases (see scripts/release.mjs). The app SOURCE repo can stay private,
// but for the *installed* app to download updates without shipping a token,
// the RELEASE repo must be PUBLIC. Recommended: a dedicated public repo that
// holds only built artifacts:
//     gh repo create iliasacademia/acabox-releases --public
//
// The baked-in defaults below are what production builds use. The env
// overrides exist only for testing against a different repo.
const UPDATE_OWNER = process.env.ACABOX_UPDATE_OWNER || 'iliasacademia';
const UPDATE_REPO = process.env.ACABOX_UPDATE_REPO || 'acabox-releases';
// Set ONLY if the release repo is PRIVATE — NOT recommended: the token ships
// inside the app bundle and is extractable. Prefer a public release repo.
const UPDATE_TOKEN = process.env.ACABOX_UPDATE_TOKEN || undefined;

let updateWindow: BrowserWindow | null = null;
let updaterConfigured = false;
let isManualCheck = false;
let pendingUpdateVersion: string | null = null;

function createUpdateWindow(version: string) {
  if (updateWindow) {
    updateWindow.focus();
    return;
  }

  pendingUpdateVersion = version;

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
  });

  updateWindow.on('closed', () => {
    updateWindow = null;
    pendingUpdateVersion = null;
  });
}

export function setupUpdater(onRebuildTrayMenu: (statusLabel?: string) => void) {
  if (!app.isPackaged) {
    log.info('[UPDATER] Skipping updater setup (not packaged).');
    return;
  }

  if (!UPDATE_OWNER || !UPDATE_REPO) {
    log.warn('[UPDATER] Skipping updater setup (no release repo configured).');
    return;
  }

  autoUpdater.autoDownload = false; // prompt the user before downloading
  autoUpdater.autoInstallOnAppQuit = true;

  // GitHub Releases feed. The default channel ('latest') matches the
  // `latest-mac.yml` / `latest.yml` metadata that scripts/release.mjs
  // attaches to each release. Fork isolation is inherent — we point at the
  // Acabox release repo, never the upstream Coscientist feed.
  const feed: Parameters<typeof autoUpdater.setFeedURL>[0] = UPDATE_TOKEN
    ? { provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO, private: true, token: UPDATE_TOKEN }
    : { provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO };

  autoUpdater.setFeedURL(feed);
  log.info(`[UPDATER] Configured GitHub Releases feed: ${UPDATE_OWNER}/${UPDATE_REPO}`);

  autoUpdater.on('update-available', (info) => {
    log.info('[UPDATER] Update available:', info.version);
    createUpdateWindow(info.version);
    onRebuildTrayMenu(`Update available: v${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[UPDATER] No update available.');
    onRebuildTrayMenu('Up to date');

    if (isManualCheck) {
      isManualCheck = false;
      const now = new Date();
      const checkedAt = now.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      dialog.showMessageBox({
        type: 'info',
        title: 'No Updates Available',
        message: "You're on the latest version",
        detail: `Version: ${app.getVersion()}\nChecked at: ${checkedAt}`,
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    log.info(`[UPDATER] Download progress: ${Math.round(progress.percent)}% (${progress.transferred}/${progress.total})`);
    updateWindow?.webContents.send('cobuild:download-progress', { percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', () => {
    log.info('[UPDATER] Update downloaded, quitting and installing.');
    // NOTE (macOS): Squirrel.Mac only applies updates to a Developer-ID-signed
    // + notarized build. On an unsigned/ad-hoc build this step fails and
    // surfaces via the 'error' handler below — expected until signing is set up.
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.on('error', (err) => {
    log.error('[UPDATER] Error:', err.message);
    updateWindow?.webContents.send('cobuild:update-error', { message: err.message });
    onRebuildTrayMenu();
  });

  updaterConfigured = true;

  // Silent check shortly after launch. Any failure (no release yet, offline,
  // private-repo 404, unsigned-install on macOS) is caught by the 'error'
  // handler above and logged — it never blocks or crashes the app.
  setTimeout(() => checkForUpdates(false), 10_000);
}

export function setupUpdaterIpcHandlers() {
  ipcMain.handle('cobuild:download-and-restart', async () => {
    if (updaterConfigured) {
      log.info('[UPDATER] Starting update download...');
      try {
        const result = await autoUpdater.downloadUpdate();
        log.info('[UPDATER] downloadUpdate() resolved:', result);
        return result;
      } catch (err) {
        log.error('[UPDATER] downloadUpdate() failed:', (err as Error).message);
        throw err;
      }
    }
    return null;
  });

  ipcMain.handle('cobuild:get-update-version', () => {
    return pendingUpdateVersion;
  });

  ipcMain.handle('cobuild:cancel-update', () => {
    updateWindow?.close();
    return null;
  });
}

export function isUpdaterConfigured(): boolean {
  return updaterConfigured;
}

export function checkForUpdates(manual?: boolean) {
  isManualCheck = !!manual;
  autoUpdater.checkForUpdates();
}
