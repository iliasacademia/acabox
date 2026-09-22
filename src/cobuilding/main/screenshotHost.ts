/**
 * Screenshot-to-composer — the Electron glue around `shared/screenshot.ts`.
 *
 * One invoke (`screenshot:capture`) runs the whole gesture and resolves with
 * the image, so the composer has a single await and a single result to handle:
 *
 *   1. Lay a clear, always-on-top sheet over every display.
 *   2. Wait for a click, a drag, or Esc on any of them; close them all.
 *   3. Route (`planCapture`): our own page via `capturePage`, or the macOS
 *      picker via `getDisplayMedia` in the requesting renderer.
 *
 * The picker call is made by executing the renderer's registered grab function
 * with `userGesture: true`. That is load-bearing: Chromium requires transient
 * user activation for `getDisplayMedia`, and the activation from the button
 * click has long expired by the time the user has finished dragging a box.
 */
import {
  BrowserWindow,
  ipcMain,
  screen,
  session,
  type IpcMainInvokeEvent,
  type NativeImage,
  type WebContents,
} from 'electron';
import log from 'electron-log';
import {
  SCREENSHOT_IPC,
  fitToPixelBudget,
  planCapture,
  translateGesture,
  type OverlayGesture,
  type OverlayInit,
  type Rect,
  type ScreenshotResult,
} from '../shared/screenshot';

export interface InstallScreenshotOptions {
  getMainWindow: () => BrowserWindow | null;
  /** `SCREENSHOT_OVERLAY_WINDOW_WEBPACK_ENTRY`. */
  overlayEntryUrl: string;
  /** `SCREENSHOT_OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY`. */
  overlayPreloadPath: string;
}

/** A sheet nobody touches is abandoned, not pending forever. */
const GESTURE_TIMEOUT_MS = 60_000;
/**
 * Time for the window server to take the sheets off screen before the picker
 * opens. The picker must not show our sheet in its thumbnails, and the sheet
 * must not sit over the picker's own bar.
 */
const SHEET_CLEAR_MS = 150;

let busy = false;
/** Set when Electron fell back to our handler, i.e. no system picker (macOS < 15). */
let pickerUnavailable = false;

const toRect = (r: Electron.Rectangle): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function installScreenshot(opts: InstallScreenshotOptions): void {
  // No permission is involved: with `useSystemPicker` the macOS picker is the
  // consent, and our handler runs only where that picker does not exist.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      pickerUnavailable = true;
      log.warn('[Screenshot] System picker unavailable (needs macOS 15+); refusing display capture');
      callback({});
    },
    { useSystemPicker: true },
  );

  ipcMain.handle(SCREENSHOT_IPC.capture, async (event: IpcMainInvokeEvent, press?: unknown): Promise<ScreenshotResult> => {
    if (busy) return { ok: false, reason: 'busy' };
    busy = true;
    // Read the cursor first thing: `press` is where the button was clicked in
    // page coordinates, and the pair locates our window on screen.
    const cursor = screen.getCursorScreenPoint();
    const anchor = isPoint(press) ? { page: press, screen: cursor } : null;
    try {
      return await runCapture(event.sender, opts, anchor);
    } catch (err) {
      log.error('[Screenshot] Capture failed:', err);
      return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = false;
    }
  });
}

const isPoint = (v: unknown): v is { x: number; y: number } =>
  !!v && typeof (v as { x?: unknown }).x === 'number' && typeof (v as { y?: unknown }).y === 'number' &&
  Number.isFinite((v as { x: number }).x) && Number.isFinite((v as { y: number }).y);

/**
 * Where Acabox's page really is on screen. `getContentBounds()` is the frame
 * macOS was ASKED for, and measured on macOS 26.7 the window server had placed
 * the window 28 pt lower (reported y=53, drawn at ~81) — a crop computed from
 * it came out shifted by exactly that. When the capture was started by a
 * click, that click's page position plus the OS cursor position gives the real
 * origin; a keyboard press falls back to the reported frame.
 */
function locateAcabox(
  mainWindow: BrowserWindow | null,
  anchor: { page: { x: number; y: number }; screen: { x: number; y: number } } | null,
): Rect | null {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return null;
  const reported = toRect(mainWindow.getContentBounds());
  if (!anchor) return reported;
  return {
    x: anchor.screen.x - anchor.page.x,
    y: anchor.screen.y - anchor.page.y,
    width: reported.width,
    height: reported.height,
  };
}

async function runCapture(
  requester: WebContents,
  opts: InstallScreenshotOptions,
  anchor: { page: { x: number; y: number }; screen: { x: number; y: number } } | null,
): Promise<ScreenshotResult> {
  const mainWindow = opts.getMainWindow();
  // Only a press inside the main window locates the main window.
  const acabox = locateAcabox(mainWindow, mainWindow && requester === mainWindow.webContents ? anchor : null);
  const displays = screen.getAllDisplays().map((d) => toRect(d.bounds));

  const gesture = await collectGesture(displays, acabox, opts);
  // The destroyed sheet held key-window status and macOS does not hand it back
  // to our window, so the next click on Acabox would only focus it — measured:
  // every second screenshot needed two clicks on the button.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  const plan = planCapture(gesture, acabox);
  log.info(`[Screenshot] gesture=${gesture.kind} route=${plan.route}${'crop' in plan && plan.crop ? ' cropped' : ''}`);

  if (plan.route === 'cancel') return { ok: false, reason: 'cancelled' };

  if (plan.route === 'acabox') {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, reason: 'error', message: 'Acabox window is gone.' };
    const image = plan.crop
      ? await mainWindow.webContents.capturePage(plan.crop)
      : await mainWindow.webContents.capturePage();
    const fitted = fitImage(image);
    const size = fitted.getSize();
    return { ok: true, base64: fitted.toPNG().toString('base64'), width: size.width, height: size.height, source: 'acabox' };
  }

  // Picker route. The sheets are closed already; give them a beat to leave
  // the screen, then ask the renderer (with a synthetic gesture) to open it.
  await sleep(SHEET_CLEAR_MS);
  pickerUnavailable = false;
  const payload = JSON.stringify({ crop: plan.crop ?? null, displays });
  const result = (await requester.executeJavaScript(
    `window.__acaboxScreenshotGrab ? window.__acaboxScreenshotGrab(${payload}) : ({ ok: false, reason: 'error', message: 'Screenshot grabber not loaded' })`,
    true,
  )) as ScreenshotResult;
  // The picker took focus too; give it back so the user can type straight away.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  if (!result.ok && pickerUnavailable) {
    return { ok: false, reason: 'unsupported', message: 'Capturing outside Acabox needs macOS 15 or later.' };
  }
  return result;
}

function fitImage(image: NativeImage): NativeImage {
  const { width, height } = image.getSize();
  const fit = fitToPixelBudget(width, height);
  if (fit.width === width) return image;
  return image.resize({ width: fit.width, height: fit.height, quality: 'best' });
}

/**
 * Show one sheet per display and resolve with the first gesture on any of
 * them. Every sheet is destroyed before this resolves.
 */
function collectGesture(displays: Rect[], acabox: Rect | null, opts: InstallScreenshotOptions): Promise<OverlayGesture> {
  return new Promise((resolve) => {
    const sheets: BrowserWindow[] = [];
    let settled = false;

    const finish = (gesture: OverlayGesture) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(SCREENSHOT_IPC.overlayDone, onDone);
      ipcMain.removeListener(SCREENSHOT_IPC.overlayAnchor, onAnchor);
      for (const w of sheets) if (!w.isDestroyed()) w.destroy();
      resolve(gesture);
    };

    /** Each sheet's true origin, once calibrated; keyed by webContents id. */
    const origins = new Map<number, { x: number; y: number }>();
    /** Where each sheet was asked to go — the fallback when never calibrated. */
    const requested = new Map<number, { x: number; y: number }>();
    const ownSheet = (id: number) => sheets.some((w) => !w.isDestroyed() && w.webContents.id === id);

    // The page's coordinates plus where the OS says the cursor is gives the
    // sheet's real origin, whatever the window server did with its frame.
    const onAnchor = (event: Electron.IpcMainEvent, point: { x: number; y: number }) => {
      if (!ownSheet(event.sender.id) || typeof point?.x !== 'number' || typeof point?.y !== 'number') return;
      const cursor = screen.getCursorScreenPoint();
      const origin = { x: cursor.x - point.x, y: cursor.y - point.y };
      origins.set(event.sender.id, origin);
      event.sender.send(SCREENSHOT_IPC.overlayOrigin, origin);
    };

    const onDone = (event: Electron.IpcMainEvent, gesture: OverlayGesture) => {
      // Only our own sheets may end the gesture.
      if (!ownSheet(event.sender.id)) return;
      if (!gesture || typeof gesture !== 'object' || !('kind' in gesture)) return finish({ kind: 'cancel' });
      const origin = origins.get(event.sender.id) ?? requested.get(event.sender.id) ?? { x: 0, y: 0 };
      finish(translateGesture(gesture, origin.x, origin.y));
    };
    ipcMain.on(SCREENSHOT_IPC.overlayDone, onDone);
    ipcMain.on(SCREENSHOT_IPC.overlayAnchor, onAnchor);
    const timer = setTimeout(() => finish({ kind: 'cancel' }), GESTURE_TIMEOUT_MS);

    const cursor = screen.getCursorScreenPoint();
    for (const display of displays) {
      const sheet = new BrowserWindow({
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        roundedCorners: false,
        enableLargerThanScreen: true,
        webPreferences: {
          preload: opts.overlayPreloadPath,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      // `modal-panel`, above every app window but under the menu bar and Dock.
      // NOT `screen-saver`: measured on macOS 26.7, windows at the menu-bar
      // level or higher were kept off screen entirely (CGWindowList
      // onscreen=false, even as the front app) — the sheet was invisible and
      // click-through while the capture waited. `modal-panel` rendered in the
      // same conditions.
      sheet.setAlwaysOnTop(true, 'modal-panel');
      // On the current Space even when it is a full-screen one.
      // `skipTransformProcessType` is load-bearing: without it Electron briefly
      // flips the process type, which deactivated Acabox (measured — the menu
      // bar switched to the app behind it) and sent Esc to that app.
      sheet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      sheet.setBounds(display);
      sheets.push(sheet);
      requested.set(sheet.webContents.id, { x: display.x, y: display.y });

      const init: OverlayInit = { display, acabox };
      sheet.webContents.once('did-finish-load', () => {
        if (settled || sheet.isDestroyed()) return;
        sheet.webContents.send(SCREENSHOT_IPC.overlayInit, init);
        // The sheet under the cursor becomes the key window so Esc and the
        // crosshair work there; the others show without stealing it.
        const underCursor =
          cursor.x >= display.x && cursor.x < display.x + display.width &&
          cursor.y >= display.y && cursor.y < display.y + display.height;
        sheet.showInactive();
        if (underCursor) sheet.focus();
      });
      sheet.on('closed', () => {
        // A sheet closed from outside (e.g. ⌘W) cancels rather than hangs.
        if (!settled) finish({ kind: 'cancel' });
      });
      sheet.loadURL(opts.overlayEntryUrl).catch((err) => {
        log.error('[Screenshot] Overlay failed to load:', err);
        finish({ kind: 'cancel' });
      });
    }
  });
}
