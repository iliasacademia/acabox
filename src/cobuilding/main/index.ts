import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerFileHandlers } from './fileHandlers';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { createAgentSession, type AgentSession } from './agentSession';
import type { IPCAttachment } from '../shared/types';
import { copyClaudeMdToWorkspace, copySkillsToWorkspace, syncMiniAppAssets } from './skills';
import { containerService } from './containerService';
import { kernelGatewayService } from './kernelGatewayService';
import { initDatabase, closeDatabase } from './db/database';
import { initObservationsDatabase, closeObservationsDatabase } from './db/observationsDatabase';
import {
  listSessions,
  getSession,
  updateSessionTitle,
  deleteSession,
  getMessages,
} from './db/chatRepository';
import {
  createWorkspace,
  updateWorkspace,
  getActiveWorkspace,
  type Workspace,
} from './db/workspaceRepository';
import { setupUpdater, setupUpdaterIpcHandlers } from './updater';
import { createTray, rebuildTrayMenu } from './tray';
import { startBrowserMonitor, stopBrowserMonitor } from './browserMonitor';
import { initFileMonitor, startFileMonitor, stopFileMonitor } from './fileMonitor';
import { initActivityQuery } from './activityQuery';
import { initSessionFiles } from './db/sessionFilesRepository';
import { startHourlySummary, stopHourlySummary } from './hourlySummary';
import { migrateWorkspaceFiles } from './migrateWorkspaceFiles';
import { checkLogin, logout } from '../../apiClient';
import { createCobuildingAuthSession, verifyCobuildingAuthCode, fetchCobuildingApiKey } from './cobuildingAuthService';
import { updateApiKey } from './db/workspaceRepository';

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Configure electron-log for cobuilding
log.transports.file.fileName = app.isPackaged ? 'cobuilding-cobuild.log' : 'cobuilding-dev.log';
log.transports.file.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v' + app.getVersion() + '] [{level}] {text}';
log.transports.console.level = app.isPackaged ? false : 'debug';

import { systemLogger } from './systemLogger';
systemLogger.init();

process.on('uncaughtException', (error) => {
  log.error('[FATAL] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('[FATAL] Unhandled rejection:', reason);
});

const MAX_WORKSPACE_NAME_LENGTH = 100;

function validateWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Workspace name cannot be empty.');
  }
  if (trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new Error(`Workspace name cannot exceed ${MAX_WORKSPACE_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.config', '.password-store'];

function validateDirectoryPath(directoryPath: string): string {
  const resolved = path.resolve(directoryPath);
  const homeDir = app.getPath('home');

  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    throw new Error('Workspace directory must be within your home directory.');
  }

  const relative = path.relative(homeDir, resolved);
  const firstSegment = relative.split(path.sep)[0];
  if (SENSITIVE_HOME_DIRS.includes(firstSegment)) {
    throw new Error('Cannot create a workspace in a sensitive directory.');
  }

  return resolved;
}

app.setName('Academia Coscientist');
app.setPath('userData', path.join(app.getPath('appData'), 'academia-electron', app.isPackaged ? 'production' : 'development'));

// Register deep link protocol — must happen before app is ready
app.setAsDefaultProtocolClient('cobuilding-agent');

let pendingDeepLinkUrl: string | null = null;

function handleDeepLinkUrl(url: string) {
  try {
    const parsed = new URL(url);
    const verificationCode = parsed.searchParams.get('verification_code');
    const deviceId = parsed.searchParams.get('device_id');
    if (!verificationCode || !/^\d{6}$/.test(verificationCode)) {
      log.warn('[Deep Link] Received URL with missing or invalid verification_code:', url);
      return;
    }
    if (!deviceId) {
      log.warn('[Deep Link] Received URL with missing device_id:', url);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('auth:deepLinkCallback', { verificationCode, deviceId });
    } else {
      pendingDeepLinkUrl = url;
    }
  } catch (err) {
    log.error('[Deep Link] Failed to parse URL:', err);
  }
}

// macOS: deep link when app is already running
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('cobuilding-agent://')) {
    handleDeepLinkUrl(url);
  }
});

let mainWindow: BrowserWindow | null = null;
let activeWorkspace: Workspace | null = null;

const sessions = new Map<string, AgentSession>();
let cachedApiKey: string | null = null;

app.whenReady().then(() => {
  protocol.handle('local-file', (request) => {
    const filePath = decodeURIComponent(request.url.slice('local-file://'.length));
    const resolved = path.resolve(filePath);
    if (
      !activeWorkspace ||
      (!resolved.startsWith(activeWorkspace.directory_path + path.sep) &&
        resolved !== activeWorkspace.directory_path)
    ) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(`file://${resolved}`);
  });

  initDatabase(app.getPath('userData'));
  initObservationsDatabase(app.getPath('userData'));
  commandLogger.init();
  log.info('[APP] App ready. Version:', app.getVersion(), 'Packaged:', app.isPackaged);
  log.info('[APP] userData path:', app.getPath('userData'));

  try {
    log.info('[APP] Initializing database...');
    initDatabase(app.getPath('userData'));
    initObservationsDatabase(app.getPath('userData'));
    log.info('[APP] Database initialized.');

    log.info('[APP] Loading active workspace...');
    activeWorkspace = getActiveWorkspace() ?? null;
    log.info('[APP] Active workspace:', activeWorkspace ? activeWorkspace.name : 'none');

    if (activeWorkspace) {
      migrateWorkspaceFiles(activeWorkspace.directory_path);
      copySkillsToWorkspace(activeWorkspace.directory_path);
      copyClaudeMdToWorkspace(activeWorkspace.directory_path);
    }

    log.info('[APP] Creating main window...');
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      title: 'Academia Coscientist',
      show: false,
      webPreferences: {
        preload: COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    log.info('[APP] Main window created.');

    registerFileHandlers(() => activeWorkspace?.directory_path ?? null, () => mainWindow);
    initFileMonitor(() => activeWorkspace?.directory_path ?? null);
    initActivityQuery(() => activeWorkspace?.directory_path ?? null);
    initSessionFiles(() => activeWorkspace?.directory_path ?? null);
    setupUpdaterIpcHandlers();
    setupUpdater(rebuildTrayMenu);
    createTray();
    log.info('[APP] Updater and tray initialized.');

    startFileMonitor();
    startBrowserMonitor().then(() => rebuildTrayMenu());
    startHourlySummary();

    const url = COBUILDING_WINDOW_WEBPACK_ENTRY;
    log.info('[APP] Loading URL:', url);
    mainWindow.loadURL(url);

    mainWindow.once('ready-to-show', () => {
      log.info('[APP] Window ready-to-show, calling show().');
      mainWindow?.show();
    });

    // Dispatch any deep link URL that arrived before the window was ready
    if (pendingDeepLinkUrl && mainWindow && !mainWindow.isDestroyed()) {
      const urlToDispatch = pendingDeepLinkUrl;
      pendingDeepLinkUrl = null;
      mainWindow.webContents.once('did-finish-load', () => {
        handleDeepLinkUrl(urlToDispatch);
      });
    }

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      log.error('[APP] Window failed to load:', errorCode, errorDescription);
    });

    mainWindow.webContents.on('did-finish-load', () => {
      log.info('[APP] Window did-finish-load.');
    });
  } catch (error) {
    log.error('[APP] Fatal error during startup:', error);
    dialog.showErrorBox(
      'Academia Coscientist - Startup Error',
      `The application failed to start.\n\n${error instanceof Error ? error.message : String(error)}\n\nCheck the log file for details:\n${log.transports.file.getFile().path}`,
    );
  }
}).catch((error) => {
  log.error('[APP] app.whenReady() rejected:', error);
});

// Workspace IPC handlers
ipcMain.handle('workspaces:getActive', () => {
  return activeWorkspace ?? null;
});

ipcMain.handle('workspaces:getDefaultDirectory', (_event, name: string) => {
  const safeName = name.slice(0, MAX_WORKSPACE_NAME_LENGTH)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'my-workspace';
  return path.join(app.getPath('home'), 'Academia Coscientist', safeName);
});

ipcMain.handle(
  'workspaces:create',
  async (_event, data: { name: string; directoryPath: string }) => {
    const name = validateWorkspaceName(data.name);
    const directoryPath = validateDirectoryPath(data.directoryPath);

    if (fs.existsSync(directoryPath)) {
      throw new Error('Directory already exists. Please choose a path that does not exist yet.');
    }

    // Fetch API key automatically — use cached value if available, otherwise fetch now
    let apiKey = cachedApiKey ?? '';
    if (!apiKey) {
      try {
        const result = await fetchCobuildingApiKey();
        cachedApiKey = result.apiKey;
        apiKey = result.apiKey;
      } catch (err) {
        log.warn('[workspaces:create] Could not fetch API key:', err);
      }
    }

    fs.mkdirSync(directoryPath, { recursive: true });
    copySkillsToWorkspace(directoryPath);
    syncMiniAppAssets(directoryPath);
    copyClaudeMdToWorkspace(directoryPath);

    const id = randomUUID();
    createWorkspace(id, name, directoryPath, apiKey);
    activeWorkspace = getActiveWorkspace() ?? null;
    return activeWorkspace ?? null;
  },
);

ipcMain.handle('dialog:selectDirectory', async () => {
  if (!mainWindow) return undefined;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  return result.filePaths[0];
});

ipcMain.handle(
  'workspaces:update',
  (_event, data: { name: string; directoryPath: string }) => {
    if (!activeWorkspace) {
      throw new Error('No active workspace to update.');
    }

    const name = validateWorkspaceName(data.name);
    const directoryPath = validateDirectoryPath(data.directoryPath);

    if (directoryPath !== activeWorkspace.directory_path) {
      // Stop containers so they restart with the new volume mount
      kernelGatewayService.stop();
      containerService.stop();

      if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
      }
      copySkillsToWorkspace(directoryPath);
      copyClaudeMdToWorkspace(directoryPath);
    }

    updateWorkspace(activeWorkspace.id, name, directoryPath, cachedApiKey ?? activeWorkspace.api_key);
    activeWorkspace = getActiveWorkspace() ?? null;
    return activeWorkspace ?? null;
  },
);

// Container IPC handlers
ipcMain.handle('container:start', async () => {
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  await containerService.start(activeWorkspace.directory_path, (stage, message, percent) => {
    mainWindow?.webContents.send('container:progress', { stage, message, percent });
  });
});

ipcMain.handle('container:stop', () => {
  containerService.stop();
});

ipcMain.handle('container:status', () => {
  return { running: containerService.isRunning() };
});

ipcMain.handle('container:exec', async (_event, command: string[]) => {
  return containerService.exec(command);
});

ipcMain.handle('container:execLogged', async (_event, command: string[], meta?: { source?: string; appDirName?: string | null }) => {
  return containerService.execLogged(command, meta as any);
});

ipcMain.handle('container:getBinaryMode', () => {
  return containerService.getBinaryMode();
});

ipcMain.handle('container:setBinaryMode', (_event, mode: string) => {
  containerService.setBinaryMode(mode as 'system' | 'bundled');
});

ipcMain.handle('container:getImageSource', () => {
  return containerService.getImageSource();
});

ipcMain.handle('container:setImageSource', (_event, source: string) => {
  containerService.setImageSource(source as 'registry' | 'local');
});

ipcMain.handle('container:getBundledStatus', () => {
  return containerService.getBundledBinaryStatus();
});

ipcMain.handle('container:downloadBinaries', async () => {
  await containerService.downloadBundledBinaries((stage, message, percent) => {
    mainWindow?.webContents.send('container:progress', { stage, message, percent });
  });
});

ipcMain.handle('container:getName', () => {
  return containerService.getContainerName();
});

ipcMain.handle('container:isImageBuilt', async () => {
  return containerService.isImageBuilt();
});

ipcMain.handle('container:deleteBinaries', () => {
  containerService.deleteBundledBinaries();
});

ipcMain.handle('container:deleteImage', async () => {
  await containerService.deleteImage();
});

ipcMain.handle('container:ensureSetup', async () => {
  await containerService.ensureSetup((stage, message, percent) => {
    mainWindow?.webContents.send('setup:progress', { stage, message, percent });
  });
});

// Jupyter kernel gateway IPC handlers
ipcMain.handle('jupyter:startGateway', async () => {
  try {
    if (!activeWorkspace) return { error: 'No active workspace' };
    return await kernelGatewayService.start(activeWorkspace.directory_path);
  } catch (err) {
    return { error: (err as Error).message };
  }
});

ipcMain.handle('jupyter:stopGateway', () => {
  kernelGatewayService.stop();
});

ipcMain.handle('jupyter:gatewayStatus', () => {
  return kernelGatewayService.getStatus();
});

ipcMain.handle('jupyter:listKernels', () => {
  return kernelGatewayService.listKernels();
});

ipcMain.handle('jupyter:shutdownKernel', (_event, kernelId: string) => {
  return kernelGatewayService.shutdownKernel(kernelId);
});

// Command log IPC handlers
import { commandLogger } from './commandLogger';

ipcMain.handle('commandLog:getAll', () => commandLogger.getAll());
ipcMain.handle('commandLog:getByApp', (_event, appDirName: string) => commandLogger.getByApp(appDirName));
ipcMain.handle('commandLog:getAppNames', () => commandLogger.getAppNames());

commandLogger.onEntry((entry) => {
  mainWindow?.webContents.send('commandLog:entry', entry);
});

// System log IPC handlers
ipcMain.handle('systemLog:getAll', () => systemLogger.getAll());

systemLogger.onEntry((entry) => {
  mainWindow?.webContents.send('systemLog:entry', entry);
});

// Session IPC handlers
ipcMain.handle('sessions:list', () => {
  if (!activeWorkspace) return [];
  return listSessions(activeWorkspace.id);
});
ipcMain.handle('sessions:get', (_event, id: string) => getSession(id));
ipcMain.handle('sessions:rename', (_event, id: string, title: string) => updateSessionTitle(id, title));
ipcMain.handle('sessions:delete', (_event, id: string) => {
  deleteSession(id);
  if (sessions.has(id)) {
    sessions.get(id)!.destroy();
    sessions.delete(id);
  }
});
ipcMain.handle('messages:list', (_event, sessionId: string) => getMessages(sessionId));

ipcMain.on('chat:send', (event, { threadId, text, attachments }: { threadId: string; text: string; attachments?: IPCAttachment[] }) => {
  if (!activeWorkspace) {
    event.sender.send('chat:error', threadId, 'No active workspace');
    return;
  }

  if (!sessions.has(threadId)) {
    const existingSession = getSession(threadId);
    const session = createAgentSession(
      threadId,
      {
        onEvent: (msg) => event.sender.send('chat:event', threadId, msg),
        onDone: () => event.sender.send('chat:done', threadId),
        onError: (err) => {
          event.sender.send('chat:error', threadId, err);
          sessions.delete(threadId);
        },
      },
      activeWorkspace,
      existingSession?.sdk_session_id ?? undefined,
    );

    sessions.set(threadId, session);

    event.sender.on('destroyed', () => {
      session.destroy();
      sessions.delete(threadId);
    });
  }

  sessions.get(threadId)!.sendMessage(text, attachments);
});

// Auth IPC handlers
ipcMain.handle('auth:checkLogin', async () => {
  try {
    const loggedIn = await checkLogin();
    if (loggedIn) {
      fetchCobuildingApiKey().then(({ apiKey }) => {
        cachedApiKey = apiKey;
        if (activeWorkspace) {
          updateApiKey(activeWorkspace.id, apiKey);
          activeWorkspace = { ...activeWorkspace, api_key: apiKey };
        }
      }).catch((err) => log.warn('[Auth] fetchCobuildingApiKey error:', err));
    }
    return { loggedIn };
  } catch (error) {
    log.error('[Auth] checkLogin error:', error);
    return { loggedIn: false };
  }
});

ipcMain.handle('auth:startQRAuth', async () => {
  try {
    const session = await createCobuildingAuthSession();
    return {
      success: true,
      deviceId: session.deviceId,
      qrCodeDataURL: session.qrCodeDataURL,
      authorizationURL: session.authorizationURL,
    };
  } catch (error: any) {
    log.error('[Auth] startQRAuth error:', error);
    return { success: false, error: error.message || 'Failed to create QR auth session' };
  }
});

ipcMain.handle('auth:verifyQRCode', async (_event, deviceId: string, code: string) => {
  try {
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
      return { success: false, error: 'Invalid code format. Please enter a 6-digit code.' };
    }
    const result = await verifyCobuildingAuthCode(deviceId, code);
    if (result.error) {
      return { success: false, error: result.error };
    }
    if (result.authorized) {
      fetchCobuildingApiKey().then(({ apiKey }) => {
        cachedApiKey = apiKey;
        if (activeWorkspace) {
          updateApiKey(activeWorkspace.id, apiKey);
          activeWorkspace = { ...activeWorkspace, api_key: apiKey };
        }
      }).catch((err) => log.warn('[Auth] fetchCobuildingApiKey after verify error:', err));
    }
    return { success: true, authorized: result.authorized, userId: result.user_id };
  } catch (error: any) {
    log.error('[Auth] verifyQRCode error:', error);
    return { success: false, error: error.message || 'Verification failed' };
  }
});

ipcMain.handle('auth:getApiKey', () => {
  return { apiKey: cachedApiKey };
});

ipcMain.handle('auth:logout', async () => {
  try {
    const result = await logout();
    return result;
  } catch (error: any) {
    log.error('[Auth] logout error:', error);
    return { success: false, error: error.message };
  }
});

app.on('window-all-closed', () => {
  for (const session of sessions.values()) {
    session.destroy();
  }
  sessions.clear();
  kernelGatewayService.stop();
  containerService.stop();
  stopHourlySummary();
  stopFileMonitor();
  stopBrowserMonitor();
  closeObservationsDatabase();
  closeDatabase();
  app.quit();
});
