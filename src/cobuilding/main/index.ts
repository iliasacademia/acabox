import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerFileHandlers } from './fileHandlers';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { createAgentSession, type AgentSession } from './agentSession';
import type { IPCAttachment } from '../shared/types';
import { copySkillsToWorkspace } from './skills';
import { containerService } from './containerService';
import { initDatabase, closeDatabase } from './db/database';
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
import { startReactions, stopReactions } from './browserMonitor';
import { initFileMonitor, stopFileMonitor } from './fileMonitor';

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Configure electron-log for cobuilding
log.transports.file.fileName = app.isPackaged ? 'cobuilding-cobuild.log' : 'cobuilding-dev.log';
log.transports.file.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [v' + app.getVersion() + '] [{level}] {text}';
log.transports.console.level = app.isPackaged ? false : 'debug';

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
app.setPath('userData', path.join(app.getPath('appData'), 'academia-electron'));

let mainWindow: BrowserWindow | null = null;
let activeWorkspace: Workspace | null = null;

const sessions = new Map<string, AgentSession>();

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
  activeWorkspace = getActiveWorkspace() ?? null;
  log.info('[APP] App ready. Version:', app.getVersion(), 'Packaged:', app.isPackaged);
  log.info('[APP] userData path:', app.getPath('userData'));

  try {
    log.info('[APP] Initializing database...');
    initDatabase(app.getPath('userData'));
    log.info('[APP] Database initialized.');

    log.info('[APP] Loading active workspace...');
    activeWorkspace = getActiveWorkspace() ?? null;
    log.info('[APP] Active workspace:', activeWorkspace ? activeWorkspace.name : 'none');

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

    registerFileHandlers(() => activeWorkspace?.directory_path ?? null);
    initFileMonitor(() => activeWorkspace?.directory_path ?? null);
    setupUpdaterIpcHandlers();
    setupUpdater(rebuildTrayMenu);
    createTray();
    log.info('[APP] Updater and tray initialized.');

    startReactions();

    const url = COBUILDING_WINDOW_WEBPACK_ENTRY;
    log.info('[APP] Loading URL:', url);
    mainWindow.loadURL(url);

    mainWindow.once('ready-to-show', () => {
      log.info('[APP] Window ready-to-show, calling show().');
      mainWindow?.show();
    });

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
  (_event, data: { name: string; directoryPath: string; apiKey: string }) => {
    const name = validateWorkspaceName(data.name);
    const directoryPath = validateDirectoryPath(data.directoryPath);

    if (fs.existsSync(directoryPath)) {
      throw new Error('Directory already exists. Please choose a path that does not exist yet.');
    }

    fs.mkdirSync(directoryPath, { recursive: true });
    copySkillsToWorkspace(directoryPath);

    const id = randomUUID();
    createWorkspace(id, name, directoryPath, data.apiKey);
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
  (_event, data: { name: string; directoryPath: string; apiKey: string }) => {
    if (!activeWorkspace) {
      throw new Error('No active workspace to update.');
    }

    const name = validateWorkspaceName(data.name);
    const directoryPath = validateDirectoryPath(data.directoryPath);

    if (directoryPath !== activeWorkspace.directory_path && !fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
      copySkillsToWorkspace(directoryPath);
    }

    updateWorkspace(activeWorkspace.id, name, directoryPath, data.apiKey);
    activeWorkspace = getActiveWorkspace() ?? null;
    return activeWorkspace ?? null;
  },
);

// Container IPC handlers
ipcMain.handle('container:start', async () => {
  if (!activeWorkspace) {
    throw new Error('No active workspace');
  }
  await containerService.start(activeWorkspace.directory_path, (stage, message) => {
    mainWindow?.webContents.send('container:progress', { stage, message });
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
  await containerService.downloadBundledBinaries((stage, message) => {
    mainWindow?.webContents.send('container:progress', { stage, message });
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
  await containerService.ensureSetup((stage, message) => {
    mainWindow?.webContents.send('setup:progress', { stage, message });
  });
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

app.on('window-all-closed', () => {
  for (const session of sessions.values()) {
    session.destroy();
  }
  sessions.clear();
  containerService.stop();
  stopFileMonitor();
  stopReactions();
  closeDatabase();
  app.quit();
});
