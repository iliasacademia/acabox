import { BrowserWindow, ipcMain, screen } from 'electron';
import log from 'electron-log';

export interface QuickChatContext {
  frontmostApp: string | null;
  bundleId: string | null;
  documentUrl: string | null;
  selectedText: string | null;
  focusedElementDescription: string | null;
  focusedElementValue: string | null;
  focusedElementRole: string | null;
}

const EMPTY_CONTEXT: QuickChatContext = {
  frontmostApp: null,
  bundleId: null,
  documentUrl: null,
  selectedText: null,
  focusedElementDescription: null,
  focusedElementValue: null,
  focusedElementRole: null,
};

async function captureContext(): Promise<QuickChatContext> {
  return EMPTY_CONTEXT;
}

declare const QUICK_CHAT_WINDOW_WEBPACK_ENTRY: string;
declare const QUICK_CHAT_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let quickChatWindow: BrowserWindow | null = null;
let lastContext: QuickChatContext | null = null;
let mainWindowRef: BrowserWindow | null = null;

export function updateMainWindowRef(newWindow: BrowserWindow) {
  mainWindowRef = newWindow;
}

export function createQuickChatWindow(mainWindow: BrowserWindow) {
  mainWindowRef = mainWindow;

  quickChatWindow = new BrowserWindow({
    width: 680,
    height: 120,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: QUICK_CHAT_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  quickChatWindow.loadURL(QUICK_CHAT_WINDOW_WEBPACK_ENTRY);

  quickChatWindow.on('blur', () => {
    hideQuickChat();
  });

  // IPC handlers
  ipcMain.on('quick-chat:submit', (_event, text: string) => {
    hideQuickChat();

    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.show();
      mainWindowRef.focus();
      mainWindowRef.webContents.send('quick-chat:inject', {
        text,
        context: lastContext,
      });
    }
  });

  ipcMain.on('quick-chat:dismiss', () => {
    hideQuickChat();
  });

  ipcMain.on('quick-chat:resize', (_event, height: number) => {
    if (quickChatWindow && !quickChatWindow.isDestroyed()) {
      const [width] = quickChatWindow.getSize();
      quickChatWindow.setSize(width, Math.max(72, Math.ceil(height)));
      centerWindow();
    }
  });

  log.info('[QuickChat] Window created');
}

function centerWindow() {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.workArea;
  const [winWidth, winHeight] = quickChatWindow.getSize();

  quickChatWindow.setPosition(
    Math.round(x + (width - winWidth) / 2),
    Math.round(y + height * 0.25 - winHeight / 2),
  );
}

export async function showQuickChat() {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;

  // Capture context BEFORE showing window (while previous app is still frontmost)
  try {
    lastContext = await captureContext();
    log.info('[QuickChat] Context captured:', {
      app: lastContext.frontmostApp,
      hasSelection: !!lastContext.selectedText,
    });
  } catch (err) {
    log.warn('[QuickChat] Context capture failed:', err);
    lastContext = {
      frontmostApp: null,
      bundleId: null,
      documentUrl: null,
      selectedText: null,
      focusedElementDescription: null,
      focusedElementValue: null,
      focusedElementRole: null,
    };
  }

  centerWindow();
  quickChatWindow.show();
  quickChatWindow.focus();
  quickChatWindow.webContents.send('quick-chat:context', lastContext);
}

export function hideQuickChat() {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.hide();
  }
}
