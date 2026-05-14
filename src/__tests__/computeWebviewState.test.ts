import { createInitialState } from '../windowMonitor/initialState';
import { reduceWindowMonitorEvent } from '../windowMonitor/reducer';
import {
  computeWebviewStateV4,
  getFocusedWindowInfo,
  applyFocusLossCarryForward,
  WebviewTypeConfig,
  DesiredWebviewState,
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
  forApp: WORD_BUNDLE_ID,
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

const POPUP_WIDTH = 370;
const POPUP_HEIGHT = 280;
const POPUP_GAP_ABOVE_BUTTON = 10;

const popupConfig: WebviewTypeConfig = {
  keyPrefix: 'popup-v2',
  pathSuffix: '/ui/popup/academiaNotificationsV2/',
  forApp: WORD_BUNDLE_ID,
  computeFrame: (bounds: WindowBounds, screenHeight: number) => {
    const cocoaBottomOfWindow = screenHeight - (bounds.y + bounds.height);
    const buttonTopEdge = cocoaBottomOfWindow + 12 + 50;
    return {
      x: bounds.x + 50,
      y: buttonTopEdge + POPUP_GAP_ABOVE_BUTTON,
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
    };
  },
};

const configs: WebviewTypeConfig[] = [buttonConfig];
const configsWithPopup: WebviewTypeConfig[] = [buttonConfig, popupConfig];

beforeEach(() => {
  tsCounter = 0;
});

describe('computeWebviewStateV4', () => {
  test('empty state returns empty map', () => {
    const result = computeWebviewStateV4(createInitialState(), configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result).toEqual({});
  });

  test('unfocused app returns empty map', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewStateV4(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result).toEqual({});
  });

  test('focused window produces entry with global key (no windowId suffix)', () => {
    const app = makeApp();
    const bounds = { x: 100, y: 100, width: 800, height: 600 };
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds }) },
    ]);
    const result = computeWebviewStateV4(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);

    expect(result['button-v2']).toBeDefined();
    expect(result['button-v2'].visible).toBe(true);
    expect(result['button-v2'].frame).toEqual({ x: 150, y: 392, width: 150, height: 50 });
    // No per-window key
    expect(result['button-v2-42']).toBeUndefined();
  });

  test('URL uses mode=v4 instead of pid/wid', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewStateV4(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);

    expect(result['button-v2'].url).toBe(
      'http://localhost:3000/ui/popup/academiaNotificationsButtonV2/?mode=v4&token=test-token'
    );
    // Should NOT contain pid or wid
    expect(result['button-v2'].url).not.toContain('pid=');
    expect(result['button-v2'].url).not.toContain('wid=');
  });

  test('only focused window produces entries (not all windows)', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '2', bounds: { x: 100, y: 100, width: 900, height: 700 } }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewStateV4(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);

    // Only one entry — the focused window's
    expect(Object.keys(result)).toEqual(['button-v2']);
    expect(result['button-v2'].visible).toBe(true);
  });

  test('multiple configs produce one entry each (global keys)', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = computeWebviewStateV4(state, configsWithPopup, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);

    expect(result['button-v2']).toBeDefined();
    expect(result['popup-v2']).toBeDefined();
    expect(Object.keys(result)).toEqual(['button-v2', 'popup-v2']);
  });

  test('stable buttons stay visible during repositioning', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 10, width: 800, height: 600 } }) },
    ]);
    const result = computeWebviewStateV4(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result['button-v2'].visible).toBe(true);
  });

  test('non-Word apps produce no entries with forApp filter', () => {
    const safari = makeApp({ identifier: 'com.apple.Safari', name: 'Safari' });
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: safari },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: safari, window: makeWindow() },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app: safari, window: makeWindow() },
    ]);
    const result = computeWebviewStateV4(state, configs, BASE_URL, AUTH_TOKEN, SCREEN_HEIGHT);
    expect(result).toEqual({});
  });
});

describe('getFocusedWindowInfo', () => {
  test('returns null for empty state', () => {
    expect(getFocusedWindowInfo(createInitialState())).toBeNull();
  });

  test('returns null when no app is focused', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    expect(getFocusedWindowInfo(state)).toBeNull();
  });

  test('returns focused app and window', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42' }) },
    ]);
    const info = getFocusedWindowInfo(state);
    expect(info).not.toBeNull();
    expect(info!.app.identifier).toBe(WORD_BUNDLE_ID);
    expect(info!.window.id).toBe('42');
  });
});

describe('applyFocusLossCarryForward', () => {
  const lastDesiredState: DesiredWebviewState = {
    'button-v2': {
      url: 'http://localhost:3000/button',
      visible: true,
      frame: { x: 100, y: 200, width: 150, height: 50 },
    },
    'popup-v2': {
      url: 'http://localhost:3000/popup',
      visible: true,
      frame: { x: 100, y: 260, width: 370, height: 280 },
      makeKey: true,
    },
  };

  test('carries forward last state with visible:false when app loses focus', () => {
    const desiredState: DesiredWebviewState = {};
    const result = applyFocusLossCarryForward(desiredState, lastDesiredState, null, '42');

    expect(result.windowId).toBe('42');
    expect(result.desiredState['button-v2'].visible).toBe(false);
    expect(result.desiredState['popup-v2'].visible).toBe(false);
    expect(result.desiredState['button-v2'].url).toBe('http://localhost:3000/button');
    expect(result.desiredState['popup-v2'].url).toBe('http://localhost:3000/popup');
  });

  test('preserves frames from last state', () => {
    const result = applyFocusLossCarryForward({}, lastDesiredState, null, '42');

    expect(result.desiredState['button-v2'].frame).toEqual({ x: 100, y: 200, width: 150, height: 50 });
    expect(result.desiredState['popup-v2'].frame).toEqual({ x: 100, y: 260, width: 370, height: 280 });
  });

  test('does not modify original desiredState entries', () => {
    const result = applyFocusLossCarryForward({}, lastDesiredState, null, '42');

    expect(lastDesiredState['button-v2'].visible).toBe(true);
    expect(lastDesiredState['popup-v2'].visible).toBe(true);
    expect(result.desiredState['button-v2'].visible).toBe(false);
  });

  test('returns original state when app is focused (windowId present)', () => {
    const desiredState: DesiredWebviewState = {
      'button-v2': {
        url: 'http://localhost:3000/button',
        visible: true,
        frame: { x: 50, y: 100, width: 150, height: 50 },
      },
    };
    const result = applyFocusLossCarryForward(desiredState, lastDesiredState, '42', '42');

    expect(result.windowId).toBe('42');
    expect(result.desiredState).toBe(desiredState);
    expect(result.desiredState['button-v2'].visible).toBe(true);
  });

  test('returns original state when no lastWindowId', () => {
    const desiredState: DesiredWebviewState = {};
    const result = applyFocusLossCarryForward(desiredState, lastDesiredState, null, null);

    expect(result.windowId).toBeNull();
    expect(result.desiredState).toEqual({});
  });

  test('returns original state when lastDesiredState is empty', () => {
    const desiredState: DesiredWebviewState = {};
    const result = applyFocusLossCarryForward(desiredState, {}, null, '42');

    expect(result.windowId).toBeNull();
    expect(result.desiredState).toEqual({});
  });

  test('returns original state when desiredState already has entries', () => {
    const desiredState: DesiredWebviewState = {
      'button-v2': {
        url: 'http://localhost:3000/button',
        visible: true,
        frame: { x: 50, y: 100, width: 150, height: 50 },
      },
    };
    const result = applyFocusLossCarryForward(desiredState, lastDesiredState, null, '42');

    expect(result.desiredState).toBe(desiredState);
    expect(result.windowId).toBeNull();
  });

  test('carries forward all entry types including review panels', () => {
    const lastState: DesiredWebviewState = {
      'button-v2': { url: 'http://localhost/btn', visible: true, frame: { x: 0, y: 0, width: 100, height: 40 } },
      'popup-v2': { url: 'http://localhost/popup', visible: true, frame: { x: 0, y: 50, width: 370, height: 280 } },
      'review-panel-v3': { url: 'http://localhost/review', visible: true, frame: { x: 400, y: 0, width: 300, height: 600 } },
    };
    const result = applyFocusLossCarryForward({}, lastState, null, '10');

    expect(Object.keys(result.desiredState)).toEqual(['button-v2', 'popup-v2', 'review-panel-v3']);
    expect(result.desiredState['button-v2'].visible).toBe(false);
    expect(result.desiredState['popup-v2'].visible).toBe(false);
    expect(result.desiredState['review-panel-v3'].visible).toBe(false);
  });
});
