import { app, BrowserWindow, dialog, globalShortcut, ipcMain, net, protocol, shell, systemPreferences } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { registerFileHandlers } from './fileHandlers';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { createAgentSession } from './agentSession';
import { registerSession, unregisterSession, getRegisteredSession, hasSession, destroyAllSessions } from './sessionRegistry';
import type { IPCAttachment } from '../shared/types';
import { copyClaudeMdToWorkspace, copySkillsToWorkspace, syncMiniAppAssets } from './skills';
import { containerService } from './containerService';
import { getAllPodmanDataPaths } from './podmanBinaries';
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
  listWorkspaces,
  touchWorkspace,
  type Workspace,
} from './db/workspaceRepository';
import { setupUpdater, setupUpdaterIpcHandlers } from './updater';
import { createTray, createDockIcon, rebuildTrayMenu, setShowWindowCallback } from './tray';
import { startBrowserMonitor, stopBrowserMonitor, isBrowserMonitorRunning } from './browserMonitor';
import { browserExtensionServer } from '../../server/browserExtensionServer';
import { getAllSessions } from './browserMonitor/repository';
import { initFileMonitor, startFileMonitor, stopFileMonitor, isFileMonitorRunning } from './fileMonitor';
import { getAllFileSessions, getTodayFileSessions } from './fileMonitor/repository';
import { initActivityQuery } from './activityQuery';
import { initSessionFiles, getAllSessionFiles } from './db/sessionFilesRepository';
import { initSchedulingDatabase, closeSchedulingDatabase } from './db/schedulingDatabase';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  setTaskEnabled,
  listTaskRuns,
} from './db/scheduledTaskRepository';
import { startScheduledTasks, stopScheduledTasks, getTaskScheduler } from './scheduledTasks';
import { runScheduledTask } from './scheduledTasks/runner';
import type { CreateTaskData, UpdateTaskData, NotificationNavigationAction } from '../shared/types';
import { migrateWorkspaceFiles } from './migrateWorkspaceFiles';
import { checkLogin, logout } from '../../apiClient';
import { createCobuildingAuthSession, verifyCobuildingAuthCode, fetchCobuildingApiKey } from './cobuildingAuthService';
import { updateApiKey } from './db/workspaceRepository';
import { createQuickChatWindow, showQuickChat, updateMainWindowRef } from './quickChat';

const isSmokeTest = process.argv.includes('--smoke-test');

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const DEFAULT_ACTIVITY_SUMMARY_PROMPT =
  'Complete ALL of the following steps in order:\n' +
  '\n' +
  '1. Use the activity-summary skill to add an update to today\'s daily summary with activity since the last update.\n' +
  '2. Use the reaction skill to react to the latest update only with suggestions and relevant resources. ' +
  'The reaction skill will handle creating the user-visible reaction thread and sending the notification.';

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function isDefaultTasksSeeded(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.defaultTasksSeeded === true;
  } catch {
    return false;
  }
}

function markDefaultTasksSeeded(): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // File doesn't exist yet
  }
  data.defaultTasksSeeded = true;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function getReactionUserInstructions(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    return data.reactionUserInstructions ?? null;
  } catch {
    return null;
  }
}

function setReactionUserInstructions(instructions: string): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  data.reactionUserInstructions = instructions;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function clearReactionUserInstructions(): void {
  const settingsPath = getSettingsPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { }
  delete data.reactionUserInstructions;
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function seedDefaultTasks(workspaceId: string): void {
  createTask(workspaceId, 'Reactions', 'Summarizes your recent activity every 15 minutes', DEFAULT_ACTIVITY_SUMMARY_PROMPT, '*/15 * * * *', 'reactions-system');
  markDefaultTasksSeeded();
  log.info('[ScheduledTasks] Default tasks seeded for workspace:', workspaceId);
}

// Configure electron-log for cobuilding — write to userData so dev/prod logs are separated
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'cobuilding.log');
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

function handleNotificationNavigation(action: NotificationNavigationAction | null): void {
  log.info('[NotificationNav] handleNotificationNavigation called with action:', JSON.stringify(action));
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.info('[NotificationNav] mainWindow is null or destroyed — recreating window');
    createMainWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    if (action) {
      log.info('[NotificationNav] Sending notification:navigate IPC to renderer:', JSON.stringify(action));
      mainWindow.webContents.send('notification:navigate', action);
    }
  }
}
let activeWorkspace: Workspace | null = null;

let cachedApiKey: string | null = null;

// Tracks IPC forwarding listeners per (threadId, webContentsId) to avoid duplicates.
// Both chat:subscribe and chat:send use this to ensure exactly one forwarding listener
// per session per renderer.
const forwardingListeners = new Map<string, () => void>();

function ensureForwarding(threadId: string, sender: Electron.WebContents): void {
  const key = `${threadId}:${sender.id}`;
  if (forwardingListeners.has(key)) return;

  const session = getRegisteredSession(threadId);
  if (!session) return;

  const unsubscribe = session.addListener({
    onEvent: (msg) => { if (!sender.isDestroyed()) sender.send('chat:event', threadId, msg); },
    onDone: () => { if (!sender.isDestroyed()) sender.send('chat:done', threadId); cleanup(); },
    onError: (err) => { if (!sender.isDestroyed()) sender.send('chat:error', threadId, err); cleanup(); },
  });

  const cleanup = () => {
    unsubscribe();
    forwardingListeners.delete(key);
    sender.removeListener('destroyed', cleanup);
  };

  forwardingListeners.set(key, cleanup);
  sender.on('destroyed', cleanup);
}

function createMainWindow(): void {
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

  updateMainWindowRef(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

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
}

app.whenReady().then(() => {
  systemPreferences.setUserDefault('NSNavPanelExpandedStateForSaveMode2', 'boolean', true as any);

  protocol.handle('local-file', async (request) => {
    const filePath = decodeURIComponent(request.url.slice('local-file://'.length));
    const resolved = path.resolve(filePath);
    if (
      !activeWorkspace ||
      (!resolved.startsWith(activeWorkspace.directory_path + path.sep) &&
        resolved !== activeWorkspace.directory_path)
    ) {
      log.warn(`[local-file] Forbidden: "${resolved}" outside workspace`);
      return new Response('Forbidden', { status: 403 });
    }
    const fileUrl = pathToFileURL(resolved).href;
    try {
      const response = await net.fetch(fileUrl);
      if (!response.ok) {
        log.warn(`[local-file] Fetch failed (${response.status}): ${fileUrl}`);
      }
      return response;
    } catch (err) {
      log.error(`[local-file] Error fetching "${fileUrl}":`, err);
      return new Response('Not Found', { status: 404 });
    }
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
      syncMiniAppAssets(activeWorkspace.directory_path);
    }

    createMainWindow();

    registerFileHandlers(() => activeWorkspace?.directory_path ?? null, () => mainWindow);
    initFileMonitor(() => activeWorkspace?.directory_path ?? null);
    initActivityQuery(() => activeWorkspace?.directory_path ?? null);
    initSessionFiles(() => activeWorkspace?.directory_path ?? null);
    setupUpdaterIpcHandlers();
    setupUpdater(rebuildTrayMenu);
    createTray();
    setShowWindowCallback(() => {
      if (!mainWindow) {
        createMainWindow();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    const dock = process.platform === 'darwin' ? app.dock : null;
    if (dock) {
      const dockIcon = createDockIcon();
      if (dockIcon) dock.setIcon(dockIcon);
    }
    log.info('[APP] Updater and tray initialized.');

    createQuickChatWindow(mainWindow!);
    const shortcutRegistered = globalShortcut.register('Alt+Shift+Space', () => {
      showQuickChat();
    });
    if (!shortcutRegistered) {
      log.warn('[APP] Failed to register global shortcut Option+Shift+Space — may be in use by another app');
    } else {
      log.info('[APP] Global shortcut Option+Shift+Space registered');
    }

    startFileMonitor();
    startBrowserMonitor().then(() => rebuildTrayMenu());
    initSchedulingDatabase(app.getPath('userData'));
    if (activeWorkspace && !isDefaultTasksSeeded()) {
      seedDefaultTasks(activeWorkspace.id);
    }
    startScheduledTasks(handleNotificationNavigation);

    if (isSmokeTest) {
      log.info('[SMOKE TEST] All services started — shutting down');
      console.log('[SMOKE TEST] All services started — shutting down');
      app.quit();
      return;
    }
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

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
  }
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
    if (activeWorkspace && !isDefaultTasksSeeded()) {
      seedDefaultTasks(activeWorkspace.id);
    }
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
      syncMiniAppAssets(directoryPath);
    }

    updateWorkspace(activeWorkspace.id, name, directoryPath, cachedApiKey ?? activeWorkspace.api_key);
    activeWorkspace = getActiveWorkspace() ?? null;
    return activeWorkspace ?? null;
  },
);

ipcMain.handle('workspaces:list', () => {
  return listWorkspaces();
});

ipcMain.handle('workspaces:switch', (_event, id: string) => {
  const workspaces = listWorkspaces();
  const target = workspaces.find((w) => w.id === id);
  if (!target) throw new Error('Workspace not found.');

  kernelGatewayService.stop();
  containerService.stop();

  touchWorkspace(id);
  activeWorkspace = getActiveWorkspace() ?? null;

  copySkillsToWorkspace(target.directory_path);
  copyClaudeMdToWorkspace(target.directory_path);
  syncMiniAppAssets(target.directory_path);

  return activeWorkspace ?? null;
});

// Container IPC handlers
ipcMain.handle('container:start', async () => {
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  await containerService.start(activeWorkspace.directory_path, (stage, message, percent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('container:progress', { stage, message, percent });
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
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('container:progress', { stage, message, percent });
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
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('setup:progress', { stage, message, percent });
  });
});

// ─── Debug: Data Management ─────────────────────────────────────

ipcMain.handle('debug:getDataPaths', () => {
  const userData = app.getPath('userData');
  const podmanPaths = getAllPodmanDataPaths();
  return {
    environment: app.isPackaged ? 'production' : 'development',
    userData,
    paths: [
      { label: 'User data', path: userData },
      ...podmanPaths,
    ],
  };
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('debug:clearAllData', async () => {
  log.warn('[Debug] Clearing all app data...');

  // 1. Stop container and services
  try { containerService.stop(); } catch { /* ok */ }
  try { kernelGatewayService.stop(); } catch { /* ok */ }

  // 2. Collect all paths to remove
  const userData = app.getPath('userData');
  const podmanPaths = getAllPodmanDataPaths();
  const pathsToRemove = [
    ...podmanPaths.map(p => p.path),
    userData,
  ];

  // 3. Remove each path
  const results: { path: string; removed: boolean; error?: string }[] = [];
  for (const p of pathsToRemove) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        results.push({ path: p, removed: true });
      } else {
        results.push({ path: p, removed: false, error: 'not found' });
      }
    } catch (err) {
      results.push({ path: p, removed: false, error: (err as Error).message });
    }
  }

  log.warn('[Debug] Data cleared:', results);
  return results;
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('commandLog:entry', entry);
  }
});

// System log IPC handlers
ipcMain.handle('systemLog:getAll', () => systemLogger.getAll());

systemLogger.onEntry((entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('systemLog:entry', entry);
  }
});

// File Monitor IPC handlers
ipcMain.handle('fileMonitor:status', () => ({ running: isFileMonitorRunning() }));
ipcMain.handle('fileMonitor:start', () => { startFileMonitor(); });
ipcMain.handle('fileMonitor:stop', () => { stopFileMonitor(); });
ipcMain.handle('fileMonitor:getTodaySessions', () => getTodayFileSessions());
ipcMain.handle('fileMonitor:openFile', (_event, fileUrl: string, bundleId?: string) => {
  try {
    const filePath = decodeURIComponent(new URL(fileUrl).pathname);
    if (bundleId) {
      return require('child_process').execFileSync('open', ['-b', bundleId, filePath]).toString();
    }
    return shell.openPath(filePath);
  } catch {
    return shell.openPath(fileUrl);
  }
});

// Observations IPC handlers
ipcMain.handle('observations:getBrowserSessions', () => getAllSessions());
ipcMain.handle('observations:getFileSessions', () => getAllFileSessions());
ipcMain.handle('observations:getSessionFiles', () => getAllSessionFiles());

// Session IPC handlers
ipcMain.handle('sessions:list', (_event, source?: string) => {
  if (!activeWorkspace) return [];
  return listSessions(activeWorkspace.id, source);
});
ipcMain.handle('sessions:get', (_event, id: string) => getSession(id));
ipcMain.handle('sessions:rename', (_event, id: string, title: string) => updateSessionTitle(id, title));
ipcMain.handle('sessions:delete', (_event, id: string) => {
  deleteSession(id);
  const session = getRegisteredSession(id);
  if (session) {
    session.destroy();
    unregisterSession(id);
  }
});
ipcMain.handle('messages:list', (_event, sessionId: string) => getMessages(sessionId));

async function generateSessionTitle(sessionId: string, firstMessage: string, apiKey: string): Promise<void> {
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: `Give a short title (5 words or less) that summarizes this message. Reply with ONLY the title, no quotes or punctuation.\n\nMessage: ${firstMessage}`,
        },
      ],
    });
    const title = (response.content[0].type === 'text' ? response.content[0].text : '').trim();
    if (title) {
      updateSessionTitle(sessionId, title);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sessions:titleUpdated', sessionId, title);
    }
  } catch (err) {
    log.warn('[TitleGen] Failed to generate session title:', err);
  }
}

ipcMain.on('chat:send', (event, { threadId, text, attachments }: { threadId: string; text: string; attachments?: IPCAttachment[] }) => {
  if (!activeWorkspace) {
    event.sender.send('chat:error', threadId, 'No active workspace');
    return;
  }

  const existingRunning = getRegisteredSession(threadId);
  if (existingRunning?.isRunning) {
    // Session is already running (e.g. scheduled task or previous user chat).
    // Ensure IPC forwarding is set up (idempotent — won't duplicate).
    ensureForwarding(threadId, event.sender);
    existingRunning.sendMessage(text, attachments);
    return;
  }

  let isFirstMessage = false;

  if (!hasSession(threadId)) {
    const existingDbSession = getSession(threadId);
    isFirstMessage = !existingDbSession;

    const session = createAgentSession(
      threadId,
      {
        onEvent: () => {},
        onDone: () => {},
        onError: () => { unregisterSession(threadId); },
      },
      activeWorkspace,
      existingDbSession?.sdk_session_id ?? undefined,
      undefined,
      handleNotificationNavigation,
    );

    registerSession(threadId, session);

    event.sender.on('destroyed', () => {
      session.destroy();
      unregisterSession(threadId);
    });
  }

  ensureForwarding(threadId, event.sender);
  getRegisteredSession(threadId)!.sendMessage(text, attachments);

  if (isFirstMessage && activeWorkspace.api_key) {
    generateSessionTitle(threadId, text, activeWorkspace.api_key);
  }
});

ipcMain.on('chat:subscribe', (event, threadId: string) => {
  ensureForwarding(threadId, event.sender);
});

ipcMain.on('chat:unsubscribe', (event, threadId: string) => {
  const key = `${threadId}:${event.sender.id}`;
  forwardingListeners.get(key)?.();
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

// Scheduled Tasks IPC handlers
ipcMain.handle('scheduledTasks:list', () => {
  if (!activeWorkspace) return [];
  return listTasks(activeWorkspace.id);
});

ipcMain.handle('scheduledTasks:get', (_event, id: string) => {
  return getTask(id) ?? null;
});

ipcMain.handle('scheduledTasks:create', (_event, data: CreateTaskData) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = createTask(activeWorkspace.id, data.name, data.description, data.prompt, data.cron_expression, data.session_source ?? null);
  getTaskScheduler().scheduleTask(task.id);
  return task;
});

ipcMain.handle('scheduledTasks:update', (_event, id: string, data: UpdateTaskData) => {
  const existing = getTask(id);
  if (existing?.session_source === 'reactions-system') {
    data = { cron_expression: data.cron_expression, enabled: data.enabled };
  }
  const task = updateTask(id, data);
  if (task) {
    if (task.enabled) {
      getTaskScheduler().scheduleTask(id);
    } else {
      getTaskScheduler().unscheduleTask(id);
    }
  }
  return task ?? null;
});

ipcMain.handle('scheduledTasks:delete', (_event, id: string) => {
  const task = getTask(id);
  if (task?.session_source === 'reactions-system') {
    throw new Error('System tasks cannot be deleted');
  }
  getTaskScheduler().unscheduleTask(id);
  deleteTask(id);
});

ipcMain.handle('scheduledTasks:setEnabled', (_event, id: string, enabled: boolean) => {
  setTaskEnabled(id, enabled);
  if (enabled) {
    getTaskScheduler().scheduleTask(id);
  } else {
    getTaskScheduler().unscheduleTask(id);
  }
});

ipcMain.handle('scheduledTasks:runNow', async (_event, id: string) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  await runScheduledTask(task, activeWorkspace, handleNotificationNavigation);
});

ipcMain.handle('scheduledTasks:listRuns', (_event, taskId: string) => {
  return listTaskRuns(taskId);
});

// Reaction prompt IPC handlers
ipcMain.handle('reactionPrompt:get', () => {
  return { instructions: getReactionUserInstructions() };
});

ipcMain.handle('reactionPrompt:set', (_event, instructions: string) => {
  setReactionUserInstructions(instructions);
});

ipcMain.handle('reactionPrompt:reset', () => {
  clearReactionUserInstructions();
});

// FOCUS.md IPC handlers
ipcMain.handle('focusPrompt:get', () => {
  if (!activeWorkspace) return { content: '' };
  const focusPath = path.join(activeWorkspace.directory_path, '.academia', 'FOCUS.md');
  try {
    return { content: fs.readFileSync(focusPath, 'utf-8') };
  } catch {
    return { content: '' };
  }
});

ipcMain.handle('focusPrompt:set', (_event, content: string) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const academiaDir = path.join(activeWorkspace.directory_path, '.academia');
  fs.mkdirSync(academiaDir, { recursive: true });
  fs.writeFileSync(path.join(academiaDir, 'FOCUS.md'), content, 'utf-8');
});

// SOUL.md IPC handlers
ipcMain.handle('soulPrompt:get', () => {
  if (!activeWorkspace) return { content: '' };
  const soulPath = path.join(activeWorkspace.directory_path, '.academia', 'SOUL.md');
  try {
    return { content: fs.readFileSync(soulPath, 'utf-8') };
  } catch {
    return { content: '' };
  }
});

ipcMain.handle('soulPrompt:set', (_event, content: string) => {
  if (!activeWorkspace) throw new Error('No active workspace');
  const academiaDir = path.join(activeWorkspace.directory_path, '.academia');
  fs.mkdirSync(academiaDir, { recursive: true });
  fs.writeFileSync(path.join(academiaDir, 'SOUL.md'), content, 'utf-8');
});

// Browser Monitor IPC handlers
ipcMain.handle('browserMonitor:status', () => {
  return {
    serverRunning: isBrowserMonitorRunning(),
    extensionConnected: browserExtensionServer.isConnected(),
  };
});

ipcMain.handle('browserMonitor:start', async () => {
  await startBrowserMonitor();
  rebuildTrayMenu();
});

ipcMain.handle('browserMonitor:stop', async () => {
  await stopBrowserMonitor();
  rebuildTrayMenu();
});

ipcMain.handle('browserMonitor:downloadExtension', async () => {
  const zipPath = app.isPackaged
    ? path.join(process.resourcesPath, 'extension.zip')
    : path.join(app.getAppPath(), 'browser-extension', 'extension.zip');

  if (!fs.existsSync(zipPath)) {
    return { success: false, error: 'Browser extension zip not found' };
  }

  const destDir = app.getPath('downloads');
  const destPath = path.join(destDir, 'academia-browser-extension.zip');
  fs.copyFileSync(zipPath, destPath);
  shell.showItemInFolder(destPath);
  return { success: true, path: destPath };
});

// Shell IPC handlers
ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new Error('Invalid URL');
  }
  await shell.openExternal(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  const steps: [string, () => void][] = [
    ['globalShortcut.unregisterAll', () => globalShortcut.unregisterAll()],
    ['stopFileMonitor', stopFileMonitor],
    ['stopBrowserMonitor', stopBrowserMonitor],
    ['stopScheduledTasks', stopScheduledTasks],
    ['destroyAllSessions', destroyAllSessions],
    ['kernelGatewayService.stop', () => kernelGatewayService.stop()],
    ['containerService.stop', () => containerService.stop()],
    ['closeSchedulingDatabase', closeSchedulingDatabase],
    ['closeObservationsDatabase', closeObservationsDatabase],
    ['closeDatabase', closeDatabase],
  ];
  for (const [name, fn] of steps) {
    try {
      fn();
    } catch (err) {
      log.error(`[APP] Cleanup step "${name}" failed:`, err);
    }
  }
});
