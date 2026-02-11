import { createInitialState } from '../windowMonitor/initialState';
import { reduceWindowMonitorEvent } from '../windowMonitor/reducer';
import { SystemState, WindowMonitorEvent, AppInfo, WindowInfoWithBounds } from '../windowMonitor/types';

// --- Test helpers ---

const TS = '2024-01-01T00:00:00.000Z';
let tsCounter = 0;
function ts(): string {
  tsCounter++;
  return `2024-01-01T00:00:${String(tsCounter).padStart(2, '0')}.000Z`;
}

function makeApp(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    pid: 100,
    name: 'TestApp',
    identifier: 'com.test.app',
    identifierType: 'bundleId',
    ...overrides,
  };
}

function makeWindow(overrides: Partial<WindowInfoWithBounds> = {}): WindowInfoWithBounds {
  return {
    id: '1',
    title: 'Test Window',
    documentPath: null,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    ...overrides,
  };
}

function reduce(state: SystemState, events: WindowMonitorEvent[]): SystemState {
  return events.reduce(reduceWindowMonitorEvent, state);
}

beforeEach(() => {
  tsCounter = 0;
});

// --- App lifecycle ---

describe('App lifecycle', () => {
  test('APP_EXISTING adds an app', () => {
    const state = reduceWindowMonitorEvent(createInitialState(), {
      event: 'APP_EXISTING',
      timestamp: TS,
      platform: 'macos',
      app: makeApp(),
    });
    expect(state.apps).toHaveLength(1);
    expect(state.apps[0].identifier).toBe('com.test.app');
    expect(state.apps[0].pid).toBe(100);
    expect(state.apps[0].isFocused).toBe(false);
  });

  test('APP_LAUNCHED adds an app', () => {
    const state = reduceWindowMonitorEvent(createInitialState(), {
      event: 'APP_LAUNCHED',
      timestamp: TS,
      platform: 'macos',
      app: makeApp(),
    });
    expect(state.apps).toHaveLength(1);
  });

  test('APP_EXISTING is idempotent', () => {
    const event: WindowMonitorEvent = {
      event: 'APP_EXISTING',
      timestamp: TS,
      platform: 'macos',
      app: makeApp(),
    };
    const state = reduce(createInitialState(), [event, event]);
    expect(state.apps).toHaveLength(1);
  });

  test('APP_TERMINATED removes app and its windows', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow() },
      { event: 'APP_TERMINATED', timestamp: ts(), platform: 'macos', app },
    ]);
    expect(state.apps).toHaveLength(0);
  });

  test('APP_TERMINATED clears system focus if app was focused', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'APP_TERMINATED', timestamp: ts(), platform: 'macos', app },
    ]);
    expect(state.focusedAppIdentifier).toBeNull();
    expect(state.focusedAppPid).toBeNull();
  });

  test('APP_FOCUSED sets app focus and system focus', () => {
    const app = makeApp();
    const state = reduceWindowMonitorEvent(createInitialState(), {
      event: 'APP_FOCUSED',
      timestamp: TS,
      platform: 'macos',
      app,
    });
    expect(state.focusedAppIdentifier).toBe('com.test.app');
    expect(state.focusedAppPid).toBe(100);
    expect(state.apps[0].isFocused).toBe(true);
  });

  test('APP_FOCUSED clears previous app focus', () => {
    const app1 = makeApp({ pid: 100, identifier: 'com.app.one' });
    const app2 = makeApp({ pid: 200, identifier: 'com.app.two' });
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: app1 },
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: app2 },
    ]);
    expect(state.apps.find((a) => a.identifier === 'com.app.one')!.isFocused).toBe(false);
    expect(state.apps.find((a) => a.identifier === 'com.app.two')!.isFocused).toBe(true);
    expect(state.focusedAppIdentifier).toBe('com.app.two');
  });

  test('APP_UNFOCUSED clears focus', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'APP_UNFOCUSED', timestamp: ts(), platform: 'macos', app },
    ]);
    expect(state.apps[0].isFocused).toBe(false);
    expect(state.focusedAppIdentifier).toBeNull();
    expect(state.focusedAppPid).toBeNull();
  });
});

// --- Window lifecycle ---

describe('Window lifecycle', () => {
  test('WINDOW_CREATED adds window to app', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow() },
    ]);
    expect(state.apps[0].windows).toHaveLength(1);
    expect(state.apps[0].windows[0].id).toBe('1');
    expect(state.apps[0].windows[0].isFocused).toBe(false);
    expect(state.apps[0].windows[0].isRepositioning).toBe(false);
  });

  test('WINDOW_EXISTING adds window to app', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_EXISTING', timestamp: ts(), platform: 'macos', app, window: makeWindow() },
    ]);
    expect(state.apps[0].windows).toHaveLength(1);
  });

  test('WINDOW_DESTROYED removes window', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app, window: { id: '1', title: null, documentPath: null, bounds: null } },
    ]);
    expect(state.apps[0].windows).toHaveLength(0);
  });

  test('WINDOW_DESTROYED clears focusedWindowId if focused', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app, window: { id: '1', title: null, documentPath: null, bounds: null } },
    ]);
    expect(state.apps[0].focusedWindowId).toBeNull();
  });

  test('WINDOW_DESTROYED is no-op for unknown window ID', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app, window: { id: '999', title: null, documentPath: null, bounds: null } },
    ]);
    expect(state.apps[0].windows).toHaveLength(0);
  });

  test('WINDOW_DESTROYED is no-op for unknown app', () => {
    const app = makeApp();
    const initial = createInitialState();
    const state = reduceWindowMonitorEvent(initial, {
      event: 'WINDOW_DESTROYED',
      timestamp: TS,
      platform: 'macos',
      app,
      window: { id: '1', title: null, documentPath: null, bounds: null },
    });
    expect(state.apps).toHaveLength(0);
  });

  test('WINDOW_FOCUSED sets focus and updates window info', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', title: 'Old Title' }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '2', title: 'Window 2' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', title: 'New Title' }) },
    ]);
    expect(state.apps[0].focusedWindowId).toBe('1');
    expect(state.apps[0].windows.find((w) => w.id === '1')!.isFocused).toBe(true);
    expect(state.apps[0].windows.find((w) => w.id === '1')!.title).toBe('New Title');
    expect(state.apps[0].windows.find((w) => w.id === '2')!.isFocused).toBe(false);
  });
});

// --- Repositioning ---

describe('Repositioning', () => {
  test('WINDOW_REPOSITIONING sets isRepositioning and updates bounds', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 20, width: 800, height: 600 } }) },
    ]);
    const win = state.apps[0].windows[0];
    expect(win.isRepositioning).toBe(true);
    expect(win.bounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });

  test('WINDOW_REPOSITIONED clears isRepositioning and updates bounds', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 20, width: 800, height: 600 } }) },
      { event: 'WINDOW_REPOSITIONED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 50, y: 60, width: 800, height: 600 } }) },
    ]);
    const win = state.apps[0].windows[0];
    expect(win.isRepositioning).toBe(false);
    expect(win.bounds).toEqual({ x: 50, y: 60, width: 800, height: 600 });
  });

  test('orphaned REPOSITIONING leaves isRepositioning true', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 20, width: 800, height: 600 } }) },
    ]);
    expect(state.apps[0].windows[0].isRepositioning).toBe(true);
  });
});

// --- Document path ---

describe('Document path', () => {
  test('WINDOW_DOCUMENT_PATH_CHANGED updates path, title, and bounds', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', title: 'Untitled', documentPath: null }) },
      {
        event: 'WINDOW_DOCUMENT_PATH_CHANGED',
        timestamp: ts(),
        platform: 'macos',
        app,
        window: makeWindow({ id: '1', title: 'MyDoc.txt', documentPath: '/Users/test/MyDoc.txt', bounds: { x: 0, y: 0, width: 900, height: 700 } }),
      },
    ]);
    const win = state.apps[0].windows[0];
    expect(win.documentPath).toBe('/Users/test/MyDoc.txt');
    expect(win.title).toBe('MyDoc.txt');
    expect(win.bounds).toEqual({ x: 0, y: 0, width: 900, height: 700 });
  });
});

// --- Multi-app ---

describe('Multi-app', () => {
  test('separate apps do not interfere', () => {
    const app1 = makeApp({ pid: 100, identifier: 'com.app.one', name: 'AppOne' });
    const app2 = makeApp({ pid: 200, identifier: 'com.app.two', name: 'AppTwo' });
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: app1 },
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: app2 },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: app1, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: app2, window: makeWindow({ id: '2' }) },
    ]);
    expect(state.apps).toHaveLength(2);
    expect(state.apps.find((a) => a.identifier === 'com.app.one')!.windows).toHaveLength(1);
    expect(state.apps.find((a) => a.identifier === 'com.app.two')!.windows).toHaveLength(1);
  });

  test('same bundle ID with different PIDs are separate apps', () => {
    const app1 = makeApp({ pid: 100, identifier: 'com.same.app' });
    const app2 = makeApp({ pid: 200, identifier: 'com.same.app' });
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: app1 },
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: app2 },
    ]);
    expect(state.apps).toHaveLength(2);
  });
});

// --- Edge cases ---

describe('Edge cases', () => {
  test('WINDOW_CREATED for existing ID updates (fullscreen re-creation)', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', title: 'Original', bounds: { x: 0, y: 0, width: 800, height: 600 } }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', title: 'Fullscreen', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    ]);
    expect(state.apps[0].windows).toHaveLength(1);
    expect(state.apps[0].windows[0].title).toBe('Fullscreen');
    expect(state.apps[0].windows[0].bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  test('window events auto-create the app', () => {
    const app = makeApp();
    const state = reduceWindowMonitorEvent(createInitialState(), {
      event: 'WINDOW_CREATED',
      timestamp: TS,
      platform: 'macos',
      app,
      window: makeWindow({ id: '1' }),
    });
    expect(state.apps).toHaveLength(1);
    expect(state.apps[0].identifier).toBe('com.test.app');
    expect(state.apps[0].windows).toHaveLength(1);
  });

  test('WINDOW_FOCUSED auto-creates the window if not present', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '5', title: 'New Window' }) },
    ]);
    expect(state.apps[0].windows).toHaveLength(1);
    expect(state.apps[0].windows[0].id).toBe('5');
    expect(state.apps[0].windows[0].isFocused).toBe(true);
    expect(state.apps[0].focusedWindowId).toBe('5');
  });

  test('lastEventTimestamp updates on every event', () => {
    const app = makeApp();
    const t1 = '2024-01-01T00:00:01.000Z';
    const t2 = '2024-01-01T00:00:02.000Z';
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: t1, platform: 'macos', app },
      { event: 'APP_FOCUSED', timestamp: t2, platform: 'macos', app },
    ]);
    expect(state.lastEventTimestamp).toBe(t2);
  });

  test('createInitialState returns clean state', () => {
    const state = createInitialState();
    expect(state.apps).toHaveLength(0);
    expect(state.focusedAppIdentifier).toBeNull();
    expect(state.focusedAppPid).toBeNull();
    expect(state.lastEventTimestamp).toBeNull();
  });
});

// --- Selection bounds ---

describe('Selection bounds', () => {
  test('WINDOW_TEXT_SELECTED sets selectionBounds from event', () => {
    const app = makeApp();
    const selBounds = { x: 100, y: 200, width: 300, height: 20 };
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      {
        event: 'WINDOW_TEXT_SELECTED', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
        selection: { filePath: '/tmp/test.docx', length: 10, bounds: selBounds },
      },
    ]);
    expect(state.apps[0].windows[0].selectionBounds).toEqual(selBounds);
  });

  test('WINDOW_TEXT_SELECTED without bounds sets selectionBounds to null', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      {
        event: 'WINDOW_TEXT_SELECTED', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
        selection: { filePath: '/tmp/test.docx', length: 10 },
      },
    ]);
    expect(state.apps[0].windows[0].selectionBounds).toBeNull();
  });

  test('WINDOW_TEXT_SELECTION_CLEARED clears selectionBounds', () => {
    const app = makeApp();
    const selBounds = { x: 100, y: 200, width: 300, height: 20 };
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      {
        event: 'WINDOW_TEXT_SELECTED', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
        selection: { filePath: '/tmp/test.docx', length: 10, bounds: selBounds },
      },
      {
        event: 'WINDOW_TEXT_SELECTION_CLEARED', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
      },
    ]);
    expect(state.apps[0].windows[0].selectionBounds).toBeNull();
  });

  test('WINDOW_TEXT_SELECTION_REPOSITIONING updates selectionBounds', () => {
    const app = makeApp();
    const initialBounds = { x: 100, y: 200, width: 300, height: 20 };
    const newBounds = { x: 110, y: 210, width: 300, height: 20 };
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      {
        event: 'WINDOW_TEXT_SELECTED', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
        selection: { filePath: '/tmp/test.docx', length: 10, bounds: initialBounds },
      },
      {
        event: 'WINDOW_TEXT_SELECTION_REPOSITIONING', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
        selection: { bounds: newBounds },
      },
    ]);
    expect(state.apps[0].windows[0].selectionBounds).toEqual(newBounds);
  });

  test('WINDOW_TEXT_SELECTION_REPOSITIONED updates selectionBounds', () => {
    const app = makeApp();
    const initialBounds = { x: 100, y: 200, width: 300, height: 20 };
    const finalBounds = { x: 120, y: 220, width: 300, height: 20 };
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      {
        event: 'WINDOW_TEXT_SELECTED', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
        selection: { filePath: '/tmp/test.docx', length: 10, bounds: initialBounds },
      },
      {
        event: 'WINDOW_TEXT_SELECTION_REPOSITIONED', timestamp: ts(), platform: 'macos', app,
        window: makeWindow({ id: '1' }),
        selection: { bounds: finalBounds },
      },
    ]);
    expect(state.apps[0].windows[0].selectionBounds).toEqual(finalBounds);
  });

  test('newWindowState initializes selectionBounds to null', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    expect(state.apps[0].windows[0].selectionBounds).toBeNull();
  });
});

// --- Realistic event sequence ---

describe('Realistic event sequence', () => {
  test('app launch → window creation → focus → reposition → save → close', () => {
    const app = makeApp({ pid: 1234, name: 'TextEdit', identifier: 'com.apple.TextEdit' });
    const win = (overrides: Partial<WindowInfoWithBounds> = {}): WindowInfoWithBounds =>
      makeWindow({ id: '42', title: 'Untitled', ...overrides });

    let state = createInitialState();

    // App launches
    state = reduceWindowMonitorEvent(state, {
      event: 'APP_LAUNCHED', timestamp: ts(), platform: 'macos', app,
    });
    expect(state.apps).toHaveLength(1);

    // Window appears
    state = reduceWindowMonitorEvent(state, {
      event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app,
      window: win({ bounds: { x: 100, y: 100, width: 600, height: 400 } }),
    });
    expect(state.apps[0].windows).toHaveLength(1);

    // App gets focused
    state = reduceWindowMonitorEvent(state, {
      event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app,
    });
    expect(state.focusedAppIdentifier).toBe('com.apple.TextEdit');

    // Window gets focused
    state = reduceWindowMonitorEvent(state, {
      event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app,
      window: win({ bounds: { x: 100, y: 100, width: 600, height: 400 } }),
    });
    expect(state.apps[0].focusedWindowId).toBe('42');
    expect(state.apps[0].windows[0].isFocused).toBe(true);

    // User moves window
    state = reduceWindowMonitorEvent(state, {
      event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app,
      window: win({ bounds: { x: 200, y: 200, width: 600, height: 400 } }),
    });
    expect(state.apps[0].windows[0].isRepositioning).toBe(true);

    state = reduceWindowMonitorEvent(state, {
      event: 'WINDOW_REPOSITIONED', timestamp: ts(), platform: 'macos', app,
      window: win({ bounds: { x: 300, y: 300, width: 600, height: 400 } }),
    });
    expect(state.apps[0].windows[0].isRepositioning).toBe(false);
    expect(state.apps[0].windows[0].bounds).toEqual({ x: 300, y: 300, width: 600, height: 400 });

    // User saves
    state = reduceWindowMonitorEvent(state, {
      event: 'WINDOW_DOCUMENT_PATH_CHANGED', timestamp: ts(), platform: 'macos', app,
      window: win({ title: 'MyDoc.txt', documentPath: '/Users/test/MyDoc.txt', bounds: { x: 300, y: 300, width: 600, height: 400 } }),
    });
    expect(state.apps[0].windows[0].documentPath).toBe('/Users/test/MyDoc.txt');
    expect(state.apps[0].windows[0].title).toBe('MyDoc.txt');

    // Window closes
    state = reduceWindowMonitorEvent(state, {
      event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app,
      window: { id: '42', title: null, documentPath: null, bounds: null },
    });
    expect(state.apps[0].windows).toHaveLength(0);
    expect(state.apps[0].focusedWindowId).toBeNull();

    // App terminates
    state = reduceWindowMonitorEvent(state, {
      event: 'APP_TERMINATED', timestamp: ts(), platform: 'macos', app,
    });
    expect(state.apps).toHaveLength(0);
    expect(state.focusedAppIdentifier).toBeNull();
  });

  test('multi-app focus switching', () => {
    const finder = makeApp({ pid: 1, name: 'Finder', identifier: 'com.apple.finder' });
    const safari = makeApp({ pid: 2, name: 'Safari', identifier: 'com.apple.Safari' });

    let state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: finder },
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: safari },
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: finder },
    ]);
    expect(state.focusedAppIdentifier).toBe('com.apple.finder');

    // Switch to Safari
    state = reduce(state, [
      { event: 'APP_UNFOCUSED', timestamp: ts(), platform: 'macos', app: finder },
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: safari },
    ]);
    expect(state.focusedAppIdentifier).toBe('com.apple.Safari');
    expect(state.apps.find((a) => a.identifier === 'com.apple.finder')!.isFocused).toBe(false);
    expect(state.apps.find((a) => a.identifier === 'com.apple.Safari')!.isFocused).toBe(true);
  });
});
