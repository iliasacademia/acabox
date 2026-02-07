import { createInitialState } from '../windowMonitor/initialState';
import { reduceWindowMonitorEvent } from '../windowMonitor/reducer';
import {
  computeWebviewState,
  WebviewTypeConfig,
  WORD_BUNDLE_ID,
} from '../windowMonitor/computeWebviewState';
import { SystemState, WindowMonitorEvent, AppInfo, WindowInfoWithBounds, WindowBounds } from '../windowMonitor/types';

// --- Test helpers ---

let tsCounter = 0;
function ts(): string {
  tsCounter++;
  return `2024-01-01T00:00:${String(tsCounter).padStart(2, '0')}.000Z`;
}

function makeApp(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    pid: 100,
    name: 'Microsoft Word',
    identifier: WORD_BUNDLE_ID,
    identifierType: 'bundleId',
    ...overrides,
  };
}

function makeWindow(overrides: Partial<WindowInfoWithBounds> = {}): WindowInfoWithBounds {
  return {
    id: '1',
    title: 'Document1.docx',
    documentPath: null,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    ...overrides,
  };
}

function reduce(state: SystemState, events: WindowMonitorEvent[]): SystemState {
  return events.reduce(reduceWindowMonitorEvent, state);
}

const SCREEN_HEIGHT = 1080;
const BASE_URL = 'http://localhost:3000';
const AUTH_TOKEN = 'test-token';

const buttonConfig: WebviewTypeConfig = {
  keyPrefix: 'button-v2',
  pathSuffix: '/ui/popup/academiaNotificationsButtonV2/',
  computeFrame: (bounds: WindowBounds, screenHeight: number) => {
    const cocoaBottomOfWindow = screenHeight - (bounds.y + bounds.height);
    return {
      x: bounds.x + 50,
      y: cocoaBottomOfWindow + 12,
      width: 150,
      height: 50,
    };
  },
};

const configs: WebviewTypeConfig[] = [buttonConfig];

beforeEach(() => {
  tsCounter = 0;
});

// --- Empty / no Word ---

describe('Empty and non-Word states', () => {
  test('empty state returns empty map', () => {
    const result = computeWebviewState(createInitialState(), configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result).toEqual({});
  });

  test('non-Word apps produce no entries', () => {
    const safari = makeApp({ identifier: 'com.apple.Safari', name: 'Safari' });
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: safari },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: safari, window: makeWindow() },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app: safari, window: makeWindow() },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result).toEqual({});
  });
});

// --- Visibility ---

describe('Visibility', () => {
  test('focused Word window → visible: true with correct frame and URL', () => {
    const app = makeApp();
    const bounds = { x: 100, y: 100, width: 800, height: 600 };
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds }) },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);

    expect(result['button-v2-42']).toBeDefined();
    expect(result['button-v2-42'].visible).toBe(true);
    expect(result['button-v2-42'].url).toBe(
      'http://localhost:3000/ui/popup/academiaNotificationsButtonV2/?pid=100&wid=42&token=test-token'
    );
    // Frame: x = 100+50=150, cocoaBottom = 1080-(100+600)=380, y = 380+12=392
    expect(result['button-v2-42'].frame).toEqual({ x: 150, y: 392, width: 150, height: 50 });
  });

  test('unfocused app → visible: false', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2-1'].visible).toBe(false);
  });

  test('unfocused window → visible: false', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2-1'].visible).toBe(false);
  });

  test('repositioning → visible: false', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 10, width: 800, height: 600 } }) },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2-1'].visible).toBe(false);
  });
});

// --- Null bounds ---

describe('Null bounds', () => {
  test('window with null bounds produces no entry', () => {
    const app = makeApp();
    // Create state with a window, then simulate bounds becoming null
    // Since WindowInfoWithBounds always has bounds, we test via a destroyed+recreated scenario
    // The state's WindowState has bounds: WindowBounds | null
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app, window: { id: '1', title: null, documentPath: null, bounds: null } },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2-1']).toBeUndefined();
  });
});

// --- Multiple windows ---

describe('Multiple windows', () => {
  test('each window gets its own entry', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '2', bounds: { x: 100, y: 100, width: 900, height: 700 } }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2-1']).toBeDefined();
    expect(result['button-v2-2']).toBeDefined();
    expect(result['button-v2-1'].visible).toBe(true);
    expect(result['button-v2-2'].visible).toBe(false);
  });

  test('multiple Word PIDs each get entries', () => {
    const word1 = makeApp({ pid: 100 });
    const word2 = makeApp({ pid: 200 });
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: word1 },
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: word2 },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: word1, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: word2, window: makeWindow({ id: '2' }) },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2-1']).toBeDefined();
    expect(result['button-v2-2']).toBeDefined();
    expect(result['button-v2-1'].url).toContain('pid=100');
    expect(result['button-v2-2'].url).toContain('pid=200');
  });
});

// --- Multiple webview type configs ---

describe('Multiple webview type configs', () => {
  test('each config produces a separate entry per window', () => {
    const sidebarConfig: WebviewTypeConfig = {
      keyPrefix: 'sidebar-v1',
      pathSuffix: '/ui/popup/sidebar/',
      computeFrame: (bounds: WindowBounds, screenHeight: number) => ({
        x: bounds.x + bounds.width - 300,
        y: screenHeight - (bounds.y + bounds.height),
        width: 300,
        height: bounds.height,
      }),
    };

    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);

    const result = computeWebviewState(state, [buttonConfig, sidebarConfig], BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2-1']).toBeDefined();
    expect(result['sidebar-v1-1']).toBeDefined();
    expect(result['button-v2-1'].url).toContain('academiaNotificationsButtonV2');
    expect(result['sidebar-v1-1'].url).toContain('sidebar');
  });
});

// --- Frame computation ---

describe('Frame computation', () => {
  test('button frame is computed correctly from window bounds', () => {
    const app = makeApp();
    const bounds = { x: 200, y: 50, width: 1000, height: 800 };
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds }) },
    ]);
    const result = computeWebviewState(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);

    // x = 200 + 50 = 250
    // cocoaBottom = 1080 - (50 + 800) = 230
    // y = 230 + 12 = 242
    expect(result['button-v2-1'].frame).toEqual({ x: 250, y: 242, width: 150, height: 50 });
  });
});

// --- Empty configs ---

describe('Empty configs', () => {
  test('no configs → no entries even with Word windows', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewState(state, [], BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result).toEqual({});
  });
});
