/**
 * `main/findInPageHost.ts` — the Electron glue around the (separately
 * tested) find-in-page controller.
 *
 * Two things this file exists to pin, both from a coordinator review of the
 * first pass: (1) the bar `WebContentsView` must stay LAZY — every handler
 * except `find:open` used to call the same `getOrCreate()`, so the main
 * renderer's `find:refresh` (sent on mount and on every tab change, per F3)
 * would have spun up a bar view — and its own renderer process — for every
 * user who never pressed ⌘F; (2) on `win`'s `closed` event, the bar's own
 * `WebContentsView` web contents must be closed explicitly rather than
 * assumed to die with the window.
 *
 * `electron` is mocked with self-contained jest.fn()s only — `ipcMain.handle`/
 * `.on` record their own calls (inspected via `.mock.calls` to find a
 * handler by channel) and `WebContentsView`'s mock implementation returns a
 * fresh fake instance per construction (inspected via `.mock.results`). Doing
 * it this way (rather than populating outer maps from inside the `jest.mock`
 * factory) keeps the factory referencing nothing from outer scope, which
 * sidesteps ts-jest's hoisting rules entirely.
 */
jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
  WebContentsView: jest.fn().mockImplementation(() => ({
    setBackgroundColor: jest.fn(),
    setBounds: jest.fn(),
    setVisible: jest.fn(),
    webContents: {
      loadURL: jest.fn().mockResolvedValue(undefined),
      focus: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      isDestroyed: jest.fn(() => false),
    },
  })),
}));
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ipcMain, WebContentsView } from 'electron';
import { FIND_IPC } from '../../shared/findInPage';
import { installFindInPage } from '../findInPageHost';

const BAR_URL = 'file:///find-bar.html';
const BAR_PRELOAD = '/path/to/findBarPreload.js';

type Handler = (...args: any[]) => any;

/** Finds the handler `ipcMain.handle(channel, handler)` was called with. */
function getIpcHandleHandler(channel: string): Handler {
  const calls = (ipcMain.handle as unknown as jest.Mock).mock.calls as [string, Handler][];
  const call = calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`no ipcMain.handle registered for "${channel}"`);
  return call[1];
}

/** Finds the (most recently registered) handler for `ipcMain.on(channel, handler)`. */
function getIpcOnHandler(channel: string): Handler {
  const calls = (ipcMain.on as unknown as jest.Mock).mock.calls as [string, Handler][];
  const matching = calls.filter(([ch]) => ch === channel);
  const last = matching[matching.length - 1];
  if (!last) throw new Error(`no ipcMain.on registered for "${channel}"`);
  return last[1];
}

/** Every fake `WebContentsView` constructed so far, in construction order. */
function createdViews(): any[] {
  return (WebContentsView as unknown as jest.Mock).mock.results.map((r) => r.value);
}

/** A fake main `BrowserWindow`, per the coordinator's spec for this test. */
function makeFakeWindow() {
  const listeners: Record<string, Handler[]> = {};
  const record = (event: string, cb: Handler) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
  };

  const win: any = {
    id: 1,
    isDestroyed: jest.fn(() => false),
    getContentBounds: jest.fn(() => ({ width: 1200, height: 800 })),
    contentView: { addChildView: jest.fn() },
    on: jest.fn((event: string, cb: Handler) => {
      record(event, cb);
      return win;
    }),
    once: jest.fn((event: string, cb: Handler) => {
      record(event, cb);
      return win;
    }),
    removeListener: jest.fn((event: string, cb: Handler) => {
      listeners[event] = (listeners[event] || []).filter((l) => l !== cb);
      return win;
    }),
    webContents: {
      findInPage: jest.fn(),
      stopFindInPage: jest.fn(),
      focus: jest.fn(),
      on: jest.fn(),
    },
  };

  const fire = (event: string, ...args: any[]) => {
    for (const cb of listeners[event] || []) cb(...args);
  };

  return { win, fire };
}

let win: any;
let fire: (event: string, ...args: any[]) => void;

beforeEach(() => {
  jest.clearAllMocks();
  ({ win, fire } = makeFakeWindow());
  installFindInPage({ getMainWindow: () => win, barEntryUrl: BAR_URL, barPreloadPath: BAR_PRELOAD });
});

test('find:refresh, find:next, and every bar:* handler are no-ops before find:open — no WebContentsView is created', () => {
  getIpcOnHandler(FIND_IPC.refresh)({});
  getIpcOnHandler(FIND_IPC.next)({}, { forward: true });
  getIpcOnHandler(FIND_IPC.barQuery)({}, { text: 'abc' });
  getIpcOnHandler(FIND_IPC.barStep)({}, { forward: true });
  getIpcOnHandler(FIND_IPC.barClose)({}, { keepSelection: false });

  expect(WebContentsView).not.toHaveBeenCalled();
  expect(createdViews()).toHaveLength(0);
  expect(win.webContents.findInPage).not.toHaveBeenCalled();
  expect(win.webContents.stopFindInPage).not.toHaveBeenCalled();
});

test('find:open constructs exactly one WebContentsView and adds it to contentView; a second open constructs none more', () => {
  const openHandler = getIpcHandleHandler(FIND_IPC.open);

  openHandler({});

  expect(createdViews()).toHaveLength(1);
  expect(win.contentView.addChildView).toHaveBeenCalledWith(createdViews()[0]);

  openHandler({});

  expect(createdViews()).toHaveLength(1);
});

test('after open, findbar:query runs findInPage and findbar:close stops the search and hides the bar', () => {
  getIpcHandleHandler(FIND_IPC.open)({});
  const view = createdViews()[0];

  getIpcOnHandler(FIND_IPC.barQuery)({}, { text: 'abc' });
  // F7: the controller's new-query path now sends {forward:true, findNext:true}
  // — {findNext:false} was measured to not emit `found-in-page` on the first
  // call for a term on this Electron build.
  expect(win.webContents.findInPage).toHaveBeenCalledWith('abc', { forward: true, findNext: true });

  getIpcOnHandler(FIND_IPC.barClose)({}, { keepSelection: true });
  expect(win.webContents.stopFindInPage).toHaveBeenCalledWith('keepSelection');
  expect(view.setVisible).toHaveBeenCalledWith(false);
});

test("the window's closed listener closes the bar's web contents, and a later open builds a fresh view", () => {
  getIpcHandleHandler(FIND_IPC.open)({});
  const firstView = createdViews()[0];

  fire('closed');

  expect(firstView.webContents.close).toHaveBeenCalled();

  getIpcHandleHandler(FIND_IPC.open)({});

  expect(createdViews()).toHaveLength(2);
  expect(createdViews()[1]).not.toBe(firstView);
});
