import {
  AppInfo,
  AppState,
  SystemState,
  WindowMonitorEvent,
  WindowState,
  WindowInfoWithBounds,
} from './types';

function findApp(state: SystemState, identifier: string, pid: number): AppState | undefined {
  return state.apps.find((a) => a.identifier === identifier && a.pid === pid);
}

function createAppFromInfo(info: AppInfo): AppState {
  return {
    pid: info.pid,
    name: info.name,
    identifier: info.identifier,
    identifierType: info.identifierType,
    isFocused: false,
    focusedWindowId: null,
    windows: [],
  };
}

function ensureApp(state: SystemState, info: AppInfo): SystemState {
  if (findApp(state, info.identifier, info.pid)) {
    return state;
  }
  return { ...state, apps: [...state.apps, createAppFromInfo(info)] };
}

function upsertWindow(app: AppState, win: WindowInfoWithBounds): AppState {
  const existing = app.windows.find((w) => w.id === win.id);
  if (existing) {
    return {
      ...app,
      windows: app.windows.map((w) =>
        w.id === win.id
          ? { ...w, title: win.title, documentPath: win.documentPath, bounds: win.bounds, contentBounds: win.contentBounds ?? null }
          : w,
      ),
    };
  }
  const newWindow: WindowState = {
    id: win.id,
    title: win.title,
    documentPath: win.documentPath,
    bounds: win.bounds,
    contentBounds: win.contentBounds ?? null,
    selectionBounds: null,
    isFocused: false,
    isRepositioning: false,
    isSelectionRepositioning: false,
    selectedText: null,
    documentText: null,
  };
  return { ...app, windows: [...app.windows, newWindow] };
}

function updateApp(
  state: SystemState,
  identifier: string,
  pid: number,
  updater: (app: AppState) => AppState,
): SystemState {
  return {
    ...state,
    apps: state.apps.map((a) =>
      a.identifier === identifier && a.pid === pid ? updater(a) : a,
    ),
  };
}

function newWindowState(win: WindowInfoWithBounds): WindowState {
  return {
    id: win.id,
    title: win.title,
    documentPath: win.documentPath,
    bounds: win.bounds,
    contentBounds: win.contentBounds ?? null,
    selectionBounds: null,
    isFocused: false,
    isRepositioning: false,
    isSelectionRepositioning: false,
    selectedText: null,
    documentText: null,
  };
}

export function reduceWindowMonitorEvent(
  state: SystemState,
  event: WindowMonitorEvent,
): SystemState {
  let next: SystemState = { ...state, lastEventTimestamp: event.timestamp };
  const { identifier, pid } = event.app;

  switch (event.event) {
    case 'APP_EXISTING':
    case 'APP_LAUNCHED': {
      next = ensureApp(next, event.app);
      return next;
    }

    case 'APP_TERMINATED': {
      const wasFocused = next.focusedAppIdentifier === identifier && next.focusedAppPid === pid;
      next = { ...next, apps: next.apps.filter((a) => !(a.identifier === identifier && a.pid === pid)) };
      if (wasFocused) {
        next = { ...next, focusedAppIdentifier: null, focusedAppPid: null };
      }
      return next;
    }

    case 'APP_FOCUSED': {
      next = ensureApp(next, event.app);
      next = {
        ...next,
        focusedAppIdentifier: identifier,
        focusedAppPid: pid,
        apps: next.apps.map((a) => ({
          ...a,
          isFocused: a.identifier === identifier && a.pid === pid,
        })),
      };
      return next;
    }

    case 'APP_UNFOCUSED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => ({ ...a, isFocused: false }));
      if (next.focusedAppIdentifier === identifier && next.focusedAppPid === pid) {
        next = { ...next, focusedAppIdentifier: null, focusedAppPid: null };
      }
      return next;
    }

    case 'WINDOW_EXISTING':
    case 'WINDOW_CREATED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => upsertWindow(a, event.window));
      return next;
    }

    case 'WINDOW_DESTROYED': {
      const app = findApp(next, identifier, pid);
      if (!app) return next;
      const windowExists = app.windows.some((w) => w.id === event.window.id);
      if (!windowExists) return next;
      next = updateApp(next, identifier, pid, (a) => {
        const updated = { ...a, windows: a.windows.filter((w) => w.id !== event.window.id) };
        if (updated.focusedWindowId === event.window.id) {
          updated.focusedWindowId = null;
        }
        return updated;
      });
      return next;
    }

    case 'WINDOW_FOCUSED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        const windows = a.windows.some((w) => w.id === event.window.id)
          ? a.windows
          : [...a.windows, newWindowState(event.window)];
        return {
          ...a,
          focusedWindowId: event.window.id,
          windows: windows.map((w) =>
            w.id === event.window.id
              ? {
                  ...w,
                  isFocused: true,
                  title: event.window.title,
                  documentPath: event.window.documentPath,
                  bounds: event.window.bounds,
                  contentBounds: event.window.contentBounds ?? null,
                }
              : { ...w, isFocused: false },
          ),
        };
      });
      return next;
    }

    case 'WINDOW_REPOSITIONING': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return {
            ...a,
            windows: [...a.windows, { ...newWindowState(event.window), isRepositioning: true }],
          };
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? { ...w, isRepositioning: true, bounds: event.window.bounds, contentBounds: event.window.contentBounds ?? null }
              : w,
          ),
        };
      });
      return next;
    }

    case 'WINDOW_REPOSITIONED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return {
            ...a,
            windows: [...a.windows, newWindowState(event.window)],
          };
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? { ...w, isRepositioning: false, bounds: event.window.bounds, contentBounds: event.window.contentBounds ?? null }
              : w,
          ),
        };
      });
      return next;
    }

    case 'WINDOW_DOCUMENT_PATH_CHANGED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return {
            ...a,
            windows: [...a.windows, newWindowState(event.window)],
          };
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? {
                  ...w,
                  documentPath: event.window.documentPath,
                  title: event.window.title,
                  bounds: event.window.bounds,
                  contentBounds: event.window.contentBounds ?? null,
                }
              : w,
          ),
        };
      });
      return next;
    }

    case 'WINDOW_TEXT_SELECTED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        const selectionBounds = event.selection.bounds ?? null;
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return {
            ...a,
            windows: [...a.windows, { ...newWindowState(event.window), selectedText: event.selection, selectionBounds }],
          };
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? { ...w, selectedText: event.selection, selectionBounds }
              : w,
          ),
        };
      });
      return next;
    }

    case 'WINDOW_TEXT_SELECTION_CLEARED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return a;
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? { ...w, selectedText: null, selectionBounds: null }
              : w,
          ),
        };
      });
      return next;
    }

    case 'WINDOW_TEXT_SELECTION_REPOSITIONING': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return {
            ...a,
            windows: [...a.windows, { ...newWindowState(event.window), selectionBounds: event.selection.bounds, isSelectionRepositioning: true }],
          };
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? { ...w, selectionBounds: event.selection.bounds, isSelectionRepositioning: true }
              : w,
          ),
        };
      });
      return next;
    }

    case 'WINDOW_TEXT_SELECTION_REPOSITIONED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return {
            ...a,
            windows: [...a.windows, { ...newWindowState(event.window), selectionBounds: event.selection.bounds }],
          };
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? { ...w, selectionBounds: event.selection.bounds, isSelectionRepositioning: false }
              : w,
          ),
        };
      });
      return next;
    }

    case 'WINDOW_DOCUMENT_TEXT_CHANGED': {
      next = ensureApp(next, event.app);
      next = updateApp(next, identifier, pid, (a) => {
        if (!a.windows.some((w) => w.id === event.window.id)) {
          return {
            ...a,
            windows: [...a.windows, { ...newWindowState(event.window), documentText: event.document }],
          };
        }
        return {
          ...a,
          windows: a.windows.map((w) =>
            w.id === event.window.id
              ? { ...w, documentText: event.document }
              : w,
          ),
        };
      });
      return next;
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
