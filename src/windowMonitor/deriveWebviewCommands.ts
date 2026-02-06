import { SystemState, WindowBounds } from './types';

export const WORD_BUNDLE_ID = 'com.microsoft.Word';

export interface DesiredWebviewState {
  windowId: string;
  visible: boolean;
  bounds: WindowBounds | null;
}

export interface CreateCommand { action: 'CREATE'; windowId: string; bounds: WindowBounds | null; }
export interface ShowCommand { action: 'SHOW'; windowId: string; }
export interface HideCommand { action: 'HIDE'; windowId: string; }
export interface RepositionCommand { action: 'REPOSITION'; windowId: string; bounds: WindowBounds; }
export interface DestroyCommand { action: 'DESTROY'; windowId: string; }

export type WebviewCommand =
  | CreateCommand
  | ShowCommand
  | HideCommand
  | RepositionCommand
  | DestroyCommand;

export function boundsEqual(a: WindowBounds | null, b: WindowBounds | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function getWordWindowDesiredStates(state: SystemState): Map<string, DesiredWebviewState> {
  const result = new Map<string, DesiredWebviewState>();

  for (const app of state.apps) {
    if (app.identifier !== WORD_BUNDLE_ID) continue;

    for (const window of app.windows) {
      const visible = app.isFocused && window.isFocused && !window.isRepositioning;
      result.set(window.id, {
        windowId: window.id,
        visible,
        bounds: window.bounds,
      });
    }
  }

  return result;
}

export function deriveWebviewCommands(
  prevState: SystemState,
  newState: SystemState,
): WebviewCommand[] {
  const prevDesired = getWordWindowDesiredStates(prevState);
  const newDesired = getWordWindowDesiredStates(newState);
  const commands: WebviewCommand[] = [];

  // Handle new and updated windows
  for (const [windowId, newEntry] of newDesired) {
    const prevEntry = prevDesired.get(windowId);

    if (!prevEntry) {
      // Window is new
      commands.push({ action: 'CREATE', windowId, bounds: newEntry.bounds });
      if (newEntry.visible) {
        commands.push({ action: 'SHOW', windowId });
      }
      continue;
    }

    // Window existed before
    const boundsChanged = !boundsEqual(prevEntry.bounds, newEntry.bounds);

    if (prevEntry.visible && newEntry.visible) {
      // Was visible, still visible
      if (boundsChanged && newEntry.bounds !== null) {
        commands.push({ action: 'REPOSITION', windowId, bounds: newEntry.bounds });
      }
    } else if (prevEntry.visible && !newEntry.visible) {
      // Was visible, now hidden
      commands.push({ action: 'HIDE', windowId });
    } else if (!prevEntry.visible && newEntry.visible) {
      // Was hidden, now visible
      if (boundsChanged && newEntry.bounds !== null) {
        commands.push({ action: 'REPOSITION', windowId, bounds: newEntry.bounds });
      }
      commands.push({ action: 'SHOW', windowId });
    }
    // hidden → hidden: nothing
  }

  // Handle removed windows
  for (const [windowId] of prevDesired) {
    if (!newDesired.has(windowId)) {
      commands.push({ action: 'DESTROY', windowId });
    }
  }

  return commands;
}
