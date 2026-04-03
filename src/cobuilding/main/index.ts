import { app, BrowserWindow } from 'electron';
import * as path from 'path';

declare const COBUILDING_WINDOW_WEBPACK_ENTRY: string;
declare const COBUILDING_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

app.setName('Cobuilding');
app.setPath('userData', path.join(app.getPath('appData'), 'academia-electron'));

let mainWindow: BrowserWindow | null = null;

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

app.on('window-all-closed', () => {
  app.quit();
});
