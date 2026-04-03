import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createAgentSession, type AgentSession } from './agentSession';
import type { IPCAttachment } from '../shared/types';
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

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

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

function validateDirectoryPath(directoryPath: string): string {
  const resolved = path.resolve(directoryPath);
  const homeDir = app.getPath('home');

  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    throw new Error('Workspace directory must be within your home directory.');
  }

  return resolved;
}

app.setName('Academia Coscientist');
app.setPath('userData', path.join(app.getPath('appData'), 'academia-electron'));

let mainWindow: BrowserWindow | null = null;
let activeWorkspace: Workspace | null = null;

const sessions = new Map<string, AgentSession>();

app.whenReady().then(() => {
  initDatabase(app.getPath('userData'));
  activeWorkspace = getActiveWorkspace() ?? null;

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

  mainWindow.loadURL(COBUILDING_WINDOW_WEBPACK_ENTRY);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
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
    }

    updateWorkspace(activeWorkspace.id, name, directoryPath, data.apiKey);
    activeWorkspace = getActiveWorkspace() ?? null;
    return activeWorkspace ?? null;
  },
);

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
  closeDatabase();
  app.quit();
});
