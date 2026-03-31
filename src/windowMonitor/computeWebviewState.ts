import { SystemState, AppState, WindowState, WindowBounds } from './types';

export const WORD_BUNDLE_ID = 'com.microsoft.Word';

export interface WebviewFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebviewEntryState {
  url: string;
  visible: boolean;
  frame: WebviewFrame;
  ignoresMouseEvents?: boolean;
  makeKey?: boolean;
}

export type DesiredWebviewState = Record<string, WebviewEntryState>;

export interface WebviewTypeConfig {
  keyPrefix: string;
  pathSuffix: string;
  ignoresMouseEvents?: boolean;
  makeKey?: boolean;
  forApp?: string | ((identifier: string) => boolean);
  computeFrame: (bounds: WindowBounds, screenHeight: number, contentBounds: WindowBounds | null, selectionBounds: WindowBounds | null, windowId?: string) => WebviewFrame | null;
}

/**
 * Find the focused app and its focused window from the system state.
 * Returns null if no app or window is focused.
 */
export function getFocusedWindowInfo(state: SystemState): { app: AppState; window: WindowState } | null {
  const focusedApp = state.apps.find(a => a.isFocused);
  if (!focusedApp) return null;
  const focusedWindow = focusedApp.windows.find(w => w.isFocused);
  if (!focusedWindow) return null;
  return { app: focusedApp, window: focusedWindow };
}

/**
 * V4: Compute webview state for a single global set of webviews.
 * Only emits entries for the focused window, using config.keyPrefix as the key
 * (no windowId suffix). URLs use mode=v4 instead of pid/wid to keep them stable
 * across focus switches, avoiding webview destroy+recreate in the Rust manager.
 */
export function computeWebviewStateV4(
  state: SystemState,
  configs: WebviewTypeConfig[],
  baseUrl: string,
  authToken: string,
  screenHeight: number,
): DesiredWebviewState {
  const result: DesiredWebviewState = {};

  const focused = getFocusedWindowInfo(state);
  if (!focused) return result;

  const { app, window } = focused;
  const bounds = window.bounds;
  if (bounds === null) return result;

  const visible = !window.isRepositioning && !window.isSelectionRepositioning;

  for (const config of configs) {
    if (config.forApp) {
      const matches = typeof config.forApp === 'string'
        ? app.identifier === config.forApp
        : config.forApp(app.identifier);
      if (!matches) continue;
    }
    const frame = config.computeFrame(bounds, screenHeight, window.contentBounds, window.selectionBounds, window.id);

    const key = config.keyPrefix;
    const separator = config.pathSuffix.includes('?') ? '&' : '?';
    const url = `${baseUrl}${config.pathSuffix}${separator}mode=v4&token=${authToken}`;

    const isStableButton = config.keyPrefix === 'button-v2' || config.keyPrefix === 'review-button' || config.keyPrefix === 'review-status-overlay' || config.keyPrefix === 'review-button-v3';
    const isVisible = isStableButton ? true : visible;

    const entry: WebviewEntryState = frame !== null
      ? { url, visible: isVisible, frame }
      : { url, visible: false, frame: { x: -10000, y: -10000, width: 1, height: 1 } };

    if (config.ignoresMouseEvents) {
      entry.ignoresMouseEvents = true;
    }
    if (config.makeKey) {
      entry.makeKey = true;
    }
    result[key] = entry;
  }

  return result;
}
