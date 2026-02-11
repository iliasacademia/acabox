import { SystemState, WindowBounds } from './types';

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
}

export type DesiredWebviewState = Record<string, WebviewEntryState>;

export interface WebviewTypeConfig {
  keyPrefix: string;
  pathSuffix: string;
  ignoresMouseEvents?: boolean;
  computeFrame: (bounds: WindowBounds, screenHeight: number, contentBounds: WindowBounds | null, selectionBounds: WindowBounds | null) => WebviewFrame | null;
}

export function computeWebviewState(
  state: SystemState,
  configs: WebviewTypeConfig[],
  baseUrl: string,
  authToken: string,
  screenHeight: number,
): DesiredWebviewState {
  const result: DesiredWebviewState = {};

  for (const app of state.apps) {
    if (app.identifier !== WORD_BUNDLE_ID) continue;

    for (const window of app.windows) {
      if (window.bounds === null) continue;

      const visible = app.isFocused && window.isFocused && !window.isRepositioning && !window.isSelectionRepositioning;

      for (const config of configs) {
        const frame = config.computeFrame(window.bounds, screenHeight, window.contentBounds, window.selectionBounds);
        if (frame === null) continue;

        const key = `${config.keyPrefix}-${window.id}`;
        const separator = config.pathSuffix.includes('?') ? '&' : '?';
        const url = `${baseUrl}${config.pathSuffix}${separator}pid=${app.pid}&wid=${window.id}&token=${authToken}`;

        const entry: WebviewEntryState = { url, visible, frame };
        if (config.ignoresMouseEvents) {
          entry.ignoresMouseEvents = true;
        }
        result[key] = entry;
      }
    }
  }

  return result;
}
