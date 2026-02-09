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
}

export type DesiredWebviewState = Record<string, WebviewEntryState>;

export interface WebviewTypeConfig {
  keyPrefix: string;
  pathSuffix: string;
  computeFrame: (bounds: WindowBounds, screenHeight: number) => WebviewFrame;
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

      const visible = app.isFocused && window.isFocused && !window.isRepositioning;

      for (const config of configs) {
        const key = `${config.keyPrefix}-${window.id}`;
        const url = `${baseUrl}${config.pathSuffix}?pid=${app.pid}&wid=${window.id}&token=${authToken}`;
        const frame = config.computeFrame(window.bounds, screenHeight);

        result[key] = { url, visible, frame };
      }
    }
  }

  return result;
}
