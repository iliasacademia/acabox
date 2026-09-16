/**
 * Find-in-page host — the thin Electron glue around `findInPage.ts`'s
 * electron-free controller. Owns the bar's `WebContentsView` and the IPC
 * handlers for the main renderer and the bar renderer.
 *
 * One controller/view pair per main `BrowserWindow`, created lazily on the
 * first ⌘F so nothing extra is spun up until the user asks for find. The app
 * recreates its main window (macOS re-activate), so the pair is keyed off
 * `getMainWindow()`'s current return value rather than assumed to be
 * permanent — see `getOrCreate` below.
 *
 * Design and tickets: docs/design/find-in-page.md (ticket F1).
 */
import { ipcMain, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import log from 'electron-log';
import { FIND_IPC, computeFindBarBounds, type FindQuery, type FindStep, type FindClose } from '../shared/findInPage';
import { createFindController, type FindController } from './findInPage';

export interface InstallFindInPageOptions {
  getMainWindow: () => BrowserWindow | null;
  /** `FIND_BAR_WINDOW_WEBPACK_ENTRY` (F5 passes it; a webpack-injected global). */
  barEntryUrl: string;
  /** `FIND_BAR_WINDOW_PRELOAD_WEBPACK_ENTRY`. */
  barPreloadPath: string;
}

interface FindInstance {
  win: BrowserWindow;
  view: WebContentsView;
  controller: FindController;
  loaded: Promise<void>;
}

/**
 * Registers the IPC handlers once. Returns nothing — like `quickChat.ts`,
 * this module holds its own module-scope state rather than being a class,
 * matching the existing pattern for a second web-contents host owned by main.
 */
export function installFindInPage(opts: InstallFindInPageOptions): void {
  let current: FindInstance | null = null;

  function getOrCreate(): FindInstance | null {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed()) return null;

    if (current && current.win === win && !current.win.isDestroyed()) {
      return current;
    }

    // Either there was no instance yet, or the tracked window was replaced
    // (macOS re-activate creates a new BrowserWindow) or destroyed.
    current = createInstance(win);
    return current;
  }

  /**
   * Like `getOrCreate`, but never creates. Every handler except `open` must
   * use this: the main renderer sends `find:refresh` on mount and on every
   * tab change, so if that handler could create the view, every user who
   * never pressed ⌘F would still get a bar `WebContentsView` (and its own
   * renderer process) spun up on first tab switch.
   */
  function getExisting(): FindInstance | null {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed()) return null;
    if (current && current.win === win && !current.win.isDestroyed()) {
      return current;
    }
    return null;
  }

  function createInstance(win: BrowserWindow): FindInstance {
    const view = new WebContentsView({
      webPreferences: {
        preload: opts.barPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    view.setBackgroundColor('#00000000');
    win.contentView.addChildView(view);
    view.setBounds(computeFindBarBounds(win.getContentBounds().width));
    view.setVisible(false);

    const loaded = view.webContents.loadURL(opts.barEntryUrl).then(
      () => undefined,
      (err) => {
        log.error('[FindInPage] Bar view failed to load:', err);
      },
    );

    const controller = createFindController({
      findInPage(text, options) {
        win.webContents.findInPage(text, options);
      },
      stopFindInPage(action) {
        win.webContents.stopFindInPage(action);
      },
      showBar() {
        view.setVisible(true);
      },
      hideBar() {
        view.setVisible(false);
      },
      focusBar() {
        void loaded.then(() => {
          view.webContents.focus();
          view.webContents.send(FIND_IPC.barFocus);
        });
      },
      focusPage() {
        win.webContents.focus();
      },
      sendToBar(result) {
        view.webContents.send(FIND_IPC.barResult, result);
      },
    });

    win.webContents.on('found-in-page', (_event, result) => {
      controller.onFoundInPage({
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      });
    });

    const onResize = () => {
      if (win.isDestroyed()) return;
      view.setBounds(computeFindBarBounds(win.getContentBounds().width));
    };
    win.on('resize', onResize);

    win.once('closed', () => {
      // The main window's web contents is already gone; don't call
      // stopFindInPage on it. The bar's web contents is a separate
      // WebContentsView, though, and is not guaranteed to die with the
      // window on its own — close it explicitly.
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
      win.removeListener('resize', onResize);
      if (current && current.win === win) {
        current = null;
      }
    });

    log.info('[FindInPage] View created for window', win.id);

    return { win, view, controller, loaded };
  }

  ipcMain.handle(FIND_IPC.open, (_event: IpcMainInvokeEvent) => {
    const instance = getOrCreate();
    if (!instance) return;
    log.info('[FindInPage] Open');
    // `showBar` is synchronous (setVisible); `focusBar` (a controller dep,
    // see createInstance) itself awaits `loaded` before focusing/sending
    // `barFocus`, so the bar is never focused before its page has loaded.
    instance.controller.open();
  });

  ipcMain.on(FIND_IPC.next, (_event: IpcMainEvent, step: FindStep) => {
    const instance = getExisting();
    if (!instance) return;
    instance.controller.step(step.forward);
  });

  ipcMain.on(FIND_IPC.refresh, (_event: IpcMainEvent) => {
    const instance = getExisting();
    if (!instance) return;
    instance.controller.refresh();
  });

  ipcMain.on(FIND_IPC.barQuery, (_event: IpcMainEvent, query: FindQuery) => {
    const instance = getExisting();
    if (!instance) return;
    instance.controller.query(query.text);
  });

  ipcMain.on(FIND_IPC.barStep, (_event: IpcMainEvent, step: FindStep) => {
    const instance = getExisting();
    if (!instance) return;
    instance.controller.step(step.forward);
  });

  ipcMain.on(FIND_IPC.barClose, (_event: IpcMainEvent, close: FindClose) => {
    const instance = getExisting();
    if (!instance) return;
    log.info('[FindInPage] Close (keepSelection=%s)', close.keepSelection);
    instance.controller.close(close.keepSelection);
  });
}
