import { SystemState, WindowBounds } from './types';

export const WORD_BUNDLE_ID = 'com.microsoft.Word';

export interface DesiredWebviewState {
  windowId: string;
  pid: number;
  visible: boolean;
  bounds: WindowBounds | null;
}

export interface CreateCommand { action: 'CREATE'; windowId: string; pid: number; bounds: WindowBounds | null; }
export interface ShowCommand { action: 'SHOW'; windowId: string; pid: number; bounds: WindowBounds | null; }
export interface HideCommand { action: 'HIDE'; windowId: string; pid: number; }
export interface RepositionCommand { action: 'REPOSITION'; windowId: string; pid: number; bounds: WindowBounds; }
export interface DestroyCommand { action: 'DESTROY'; windowId: string; pid: number; }

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
        pid: app.pid,
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
      commands.push({ action: 'CREATE', windowId, pid: newEntry.pid, bounds: newEntry.bounds });
      if (newEntry.visible) {
        commands.push({ action: 'SHOW', windowId, pid: newEntry.pid, bounds: newEntry.bounds });
      }
      continue;
    }

    // Window existed before
    const boundsChanged = !boundsEqual(prevEntry.bounds, newEntry.bounds);

    if (prevEntry.visible && newEntry.visible) {
      // Was visible, still visible
      if (boundsChanged && newEntry.bounds !== null) {
        commands.push({ action: 'REPOSITION', windowId, pid: newEntry.pid, bounds: newEntry.bounds });
      }
    } else if (prevEntry.visible && !newEntry.visible) {
      // Was visible, now hidden
      commands.push({ action: 'HIDE', windowId, pid: newEntry.pid });
    } else if (!prevEntry.visible && newEntry.visible) {
      // Was hidden, now visible
      if (boundsChanged && newEntry.bounds !== null) {
        commands.push({ action: 'REPOSITION', windowId, pid: newEntry.pid, bounds: newEntry.bounds });
      }
      commands.push({ action: 'SHOW', windowId, pid: newEntry.pid, bounds: newEntry.bounds });
    }
    // hidden → hidden: nothing
  }

  // Handle removed windows
  for (const [windowId, prevEntry] of prevDesired) {
    if (!newDesired.has(windowId)) {
      commands.push({ action: 'DESTROY', windowId, pid: prevEntry.pid });
    }
  }

  return commands;
}

export type PopupWebviewCommand = WebviewCommand & { url: string };

export function expandCommandsForPopups(
  commands: WebviewCommand[],
  popupPaths: string[],
  baseUrl: string,
): PopupWebviewCommand[] {
  const result: PopupWebviewCommand[] = [];
  for (const cmd of commands) {
    for (const path of popupPaths) {
      result.push({
        ...cmd,
        url: `${baseUrl}${path}?pid=${cmd.pid}&wid=${cmd.windowId}`,
      });
    }
  }
  return result;
}
