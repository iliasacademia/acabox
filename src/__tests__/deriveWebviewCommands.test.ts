import { createInitialState } from '../windowMonitor/initialState';
import { reduceWindowMonitorEvent } from '../windowMonitor/reducer';
import {
  boundsEqual,
  getWordWindowDesiredStates,
  deriveWebviewCommands,
  WebviewCommand,
  WORD_BUNDLE_ID,
} from '../windowMonitor/deriveWebviewCommands';
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

beforeEach(() => {
  tsCounter = 0;
});

// --- boundsEqual ---

describe('boundsEqual', () => {
  test('both null returns true', () => {
    expect(boundsEqual(null, null)).toBe(true);
  });

  test('first null, second non-null returns false', () => {
    expect(boundsEqual(null, { x: 0, y: 0, width: 100, height: 100 })).toBe(false);
  });

  test('first non-null, second null returns false', () => {
    expect(boundsEqual({ x: 0, y: 0, width: 100, height: 100 }, null)).toBe(false);
  });

  test('same values returns true', () => {
    const a: WindowBounds = { x: 10, y: 20, width: 800, height: 600 };
    const b: WindowBounds = { x: 10, y: 20, width: 800, height: 600 };
    expect(boundsEqual(a, b)).toBe(true);
  });

  test('different x returns false', () => {
    expect(boundsEqual(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 1, y: 0, width: 100, height: 100 },
    )).toBe(false);
  });

  test('different y returns false', () => {
    expect(boundsEqual(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 1, width: 100, height: 100 },
    )).toBe(false);
  });

  test('different width returns false', () => {
    expect(boundsEqual(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 200, height: 100 },
    )).toBe(false);
  });

  test('different height returns false', () => {
    expect(boundsEqual(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 100, height: 200 },
    )).toBe(false);
  });

  test('same reference returns true', () => {
    const a: WindowBounds = { x: 0, y: 0, width: 100, height: 100 };
    expect(boundsEqual(a, a)).toBe(true);
  });
});

// --- getWordWindowDesiredStates ---

describe('getWordWindowDesiredStates', () => {
  test('empty state returns empty map', () => {
    const result = getWordWindowDesiredStates(createInitialState());
    expect(result.size).toBe(0);
  });

  test('non-Word apps are ignored', () => {
    const safari = makeApp({ identifier: 'com.apple.Safari', name: 'Safari' });
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: safari },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: safari, window: makeWindow() },
    ]);
    const result = getWordWindowDesiredStates(state);
    expect(result.size).toBe(0);
  });

  test('Word window visible when app focused, window focused, not repositioning', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = getWordWindowDesiredStates(state);
    expect(result.get('1')!.visible).toBe(true);
  });

  test('Word window hidden when app not focused', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = getWordWindowDesiredStates(state);
    expect(result.get('1')!.visible).toBe(false);
  });

  test('Word window hidden when window not focused', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const result = getWordWindowDesiredStates(state);
    expect(result.get('1')!.visible).toBe(false);
  });

  test('Word window hidden when repositioning', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 10, width: 800, height: 600 } }) },
    ]);
    const result = getWordWindowDesiredStates(state);
    expect(result.get('1')!.visible).toBe(false);
  });

  test('bounds are passed through', () => {
    const app = makeApp();
    const bounds = { x: 50, y: 60, width: 900, height: 700 };
    const state = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds }) },
    ]);
    const result = getWordWindowDesiredStates(state);
    expect(result.get('1')!.bounds).toEqual(bounds);
  });
});

// --- New window ---

describe('New window', () => {
  test('CREATE only when new window is hidden', () => {
    const app = makeApp();
    const prev = createInitialState();
    const next = reduce(prev, [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'CREATE', windowId: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    ]);
  });

  test('CREATE + SHOW when new window is visible', () => {
    const app = makeApp();
    const prev = createInitialState();
    const next = reduce(prev, [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'CREATE', windowId: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { action: 'SHOW', windowId: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    ]);
  });
});

// --- Removed window ---

describe('Removed window', () => {
  test('DESTROY when window disappears', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const next = reduce(prev, [
      { event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app, window: { id: '1', title: null, documentPath: null, bounds: null } },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'DESTROY', windowId: '1' },
    ]);
  });

  test('DESTROY when Word app terminates', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '2' }) },
    ]);
    const next = reduce(prev, [
      { event: 'APP_TERMINATED', timestamp: ts(), platform: 'macos', app },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'DESTROY', windowId: '1' },
      { action: 'DESTROY', windowId: '2' },
    ]);
  });
});

// --- Visibility transitions ---

describe('Visibility transitions', () => {
  test('SHOW when hidden window becomes visible', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    // Window is created but not focused → hidden
    const next = reduce(prev, [
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'SHOW', windowId: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    ]);
  });

  test('HIDE when visible window becomes hidden', () => {
    const app = makeApp();
    const otherApp = makeApp({ pid: 200, identifier: 'com.apple.Safari', name: 'Safari' });
    const prev = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    // Another app gets focused → Word unfocused
    const next = reduce(prev, [
      { event: 'APP_UNFOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: otherApp },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'HIDE', windowId: '1' },
    ]);
  });

  test('focus switching between Word windows: HIDE old, SHOW new', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '2' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    // Focus switches to window 2
    const next = reduce(prev, [
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '2' }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toContainEqual({ action: 'HIDE', windowId: '1' });
    expect(commands).toContainEqual({ action: 'SHOW', windowId: '2', bounds: { x: 0, y: 0, width: 800, height: 600 } });
  });
});

// --- Repositioning ---

describe('Repositioning', () => {
  test('HIDE when repositioning starts on visible window', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const next = reduce(prev, [
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 10, width: 800, height: 600 } }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'HIDE', windowId: '1' },
    ]);
  });

  test('REPOSITION + SHOW when repositioning ends on focused window', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 10, y: 10, width: 800, height: 600 } }) },
    ]);
    const next = reduce(prev, [
      { event: 'WINDOW_REPOSITIONED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 50, y: 50, width: 800, height: 600 } }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    // REPOSITION before SHOW to prevent flicker
    expect(commands).toEqual([
      { action: 'REPOSITION', windowId: '1', bounds: { x: 50, y: 50, width: 800, height: 600 } },
      { action: 'SHOW', windowId: '1', bounds: { x: 50, y: 50, width: 800, height: 600 } },
    ]);
  });

  test('REPOSITION emitted when visible window bounds change without repositioning flag', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } }) },
    ]);
    // Simulate bounds change via WINDOW_FOCUSED with new bounds (e.g. fullscreen toggle)
    const next = reduce(prev, [
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'REPOSITION', windowId: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);
  });
});

// --- No-ops ---

describe('No-ops', () => {
  test('hidden → hidden emits nothing', () => {
    const app = makeApp();
    const prev = reduce(createInitialState(), [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    // Some non-visibility-affecting event
    const next = reduce(prev, [
      { event: 'WINDOW_DOCUMENT_PATH_CHANGED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', documentPath: '/path/to/doc.docx' }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([]);
  });

  test('visible → visible same bounds emits nothing', () => {
    const app = makeApp();
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    const prev = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds }) },
    ]);
    // Re-focus same window with same bounds
    const next = reduce(prev, [
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1', bounds }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([]);
  });

  test('non-Word events produce no commands', () => {
    const safari = makeApp({ pid: 200, identifier: 'com.apple.Safari', name: 'Safari' });
    const prev = createInitialState();
    const next = reduce(prev, [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: safari },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: safari, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app: safari, window: makeWindow({ id: '1' }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([]);
  });
});

// --- Edge cases ---

describe('Edge cases', () => {
  test('multiple Word PIDs each get their own commands', () => {
    const word1 = makeApp({ pid: 100 });
    const word2 = makeApp({ pid: 200 });
    const prev = createInitialState();
    const next = reduce(prev, [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: word1 },
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app: word2 },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: word1, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app: word2, window: makeWindow({ id: '2' }) },
    ]);
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toContainEqual({ action: 'CREATE', windowId: '1', bounds: { x: 0, y: 0, width: 800, height: 600 } });
    expect(commands).toContainEqual({ action: 'CREATE', windowId: '2', bounds: { x: 0, y: 0, width: 800, height: 600 } });
    expect(commands).toHaveLength(2);
  });

  test('identical prev and next state emit no commands', () => {
    const app = makeApp();
    const state = reduce(createInitialState(), [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const commands = deriveWebviewCommands(state, state);
    expect(commands).toEqual([]);
  });

  test('rapid state changes: create then immediately destroy', () => {
    const app = makeApp();
    const prev = createInitialState();
    // Build intermediate state with window, then destroy it
    const intermediate = reduce(prev, [
      { event: 'APP_EXISTING', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '1' }) },
    ]);
    const next = reduce(intermediate, [
      { event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app, window: { id: '1', title: null, documentPath: null, bounds: null } },
    ]);
    // From prev (no windows) to next (no windows) — nothing to do
    const commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([]);
  });
});

// --- Realistic sequence ---

describe('Realistic sequence', () => {
  test('full lifecycle: launch → focus → reposition → unfocus → destroy', () => {
    const app = makeApp({ pid: 1234 });
    const bounds1 = { x: 100, y: 100, width: 800, height: 600 };
    const bounds2 = { x: 200, y: 200, width: 800, height: 600 };
    const otherApp = makeApp({ pid: 5678, identifier: 'com.apple.Safari', name: 'Safari' });

    let prev = createInitialState();
    let next: SystemState;
    let commands: WebviewCommand[];

    // Step 1: Word launches with a window
    next = reduce(prev, [
      { event: 'APP_LAUNCHED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_CREATED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds: bounds1 }) },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'CREATE', windowId: '42', bounds: bounds1 },
    ]);

    // Step 2: Word gets focused, window gets focused
    prev = next;
    next = reduce(prev, [
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'WINDOW_FOCUSED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds: bounds1 }) },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'SHOW', windowId: '42', bounds: bounds1 },
    ]);

    // Step 3: User starts dragging window
    prev = next;
    next = reduce(prev, [
      { event: 'WINDOW_REPOSITIONING', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds: { x: 150, y: 150, width: 800, height: 600 } }) },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'HIDE', windowId: '42' },
    ]);

    // Step 4: User finishes dragging
    prev = next;
    next = reduce(prev, [
      { event: 'WINDOW_REPOSITIONED', timestamp: ts(), platform: 'macos', app, window: makeWindow({ id: '42', bounds: bounds2 }) },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'REPOSITION', windowId: '42', bounds: bounds2 },
      { action: 'SHOW', windowId: '42', bounds: bounds2 },
    ]);

    // Step 5: User switches to Safari
    prev = next;
    next = reduce(prev, [
      { event: 'APP_UNFOCUSED', timestamp: ts(), platform: 'macos', app },
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app: otherApp },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'HIDE', windowId: '42' },
    ]);

    // Step 6: User switches back to Word (same window, same bounds)
    prev = next;
    next = reduce(prev, [
      { event: 'APP_UNFOCUSED', timestamp: ts(), platform: 'macos', app: otherApp },
      { event: 'APP_FOCUSED', timestamp: ts(), platform: 'macos', app },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'SHOW', windowId: '42', bounds: bounds2 },
    ]);

    // Step 7: Window destroyed
    prev = next;
    next = reduce(prev, [
      { event: 'WINDOW_DESTROYED', timestamp: ts(), platform: 'macos', app, window: { id: '42', title: null, documentPath: null, bounds: null } },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([
      { action: 'DESTROY', windowId: '42' },
    ]);

    // Step 8: App terminates (no more Word windows, so no commands)
    prev = next;
    next = reduce(prev, [
      { event: 'APP_TERMINATED', timestamp: ts(), platform: 'macos', app },
    ]);
    commands = deriveWebviewCommands(prev, next);
    expect(commands).toEqual([]);
  });
});
