import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { createAgentSession, type AgentSession } from './agentSession';

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

app.setName('Cobuilding');
app.setPath('userData', path.join(app.getPath('appData'), 'academia-electron'));

let mainWindow: BrowserWindow | null = null;

const sessions = new Map<string, AgentSession>();

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Cobuilding',
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

ipcMain.on('chat:send', (event, { threadId, text }: { threadId: string; text: string }) => {
  if (!sessions.has(threadId)) {
    const session = createAgentSession({
      onEvent: (msg) => event.sender.send('chat:event', threadId, msg),
      onDone: () => event.sender.send('chat:done', threadId),
      onError: (err) => {
        event.sender.send('chat:error', threadId, err);
        sessions.delete(threadId);
      },
    });

    sessions.set(threadId, session);

    event.sender.on('destroyed', () => {
      session.destroy();
      sessions.delete(threadId);
    });
  }

  sessions.get(threadId)!.sendMessage(text);
});

app.on('window-all-closed', () => {
  for (const session of sessions.values()) {
    session.destroy();
  }
  sessions.clear();
  app.quit();
});
