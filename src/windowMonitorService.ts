import { ChildProcess, spawn } from 'child_process';
import { app, screen } from 'electron';
import * as path from 'path';
import * as readline from 'readline';
import { defaultLogger as logger } from './utils/logger';
import { SystemState, WindowMonitorEvent, WindowBounds } from './windowMonitor/types';
import { wordPollEventBus } from './server/events/wordPollEventBus';
import { createInitialState } from './windowMonitor/initialState';
import { reduceWindowMonitorEvent } from './windowMonitor/reducer';
import {
  computeWebviewState,
  WebviewTypeConfig,
} from './windowMonitor/computeWebviewState';

const BUTTON_WIDTH = 170;
const BUTTON_HEIGHT = 50;
const BUTTON_LEFT_MARGIN = 50;
const BUTTON_BOTTOM_MARGIN = 30;

const POPUP_WIDTH = 370;
const POPUP_HEIGHT = 280;
const POPUP_GAP_ABOVE_BUTTON = 10;

const webviewConfigs: WebviewTypeConfig[] = [
  {
    keyPrefix: 'button-v2',
    pathSuffix: '/ui/popup/academiaNotificationsButtonV2/',
    computeFrame: (bounds: WindowBounds, screenHeight: number) => {
      const cocoaBottomOfWindow = screenHeight - (bounds.y + bounds.height);
      return {
        x: bounds.x + BUTTON_LEFT_MARGIN,
        y: cocoaBottomOfWindow + BUTTON_BOTTOM_MARGIN,
        width: BUTTON_WIDTH,
        height: BUTTON_HEIGHT,
      };
    },
  },
  {
    keyPrefix: 'popup-v2',
    pathSuffix: '/ui/popup/academiaNotificationsV2/',
    computeFrame: (bounds: WindowBounds, screenHeight: number) => {
      const cocoaBottomOfWindow = screenHeight - (bounds.y + bounds.height);
      const buttonTopEdge = cocoaBottomOfWindow + BUTTON_BOTTOM_MARGIN + BUTTON_HEIGHT;
      return {
        x: bounds.x + BUTTON_LEFT_MARGIN,
        y: buttonTopEdge + POPUP_GAP_ABOVE_BUTTON,
        width: POPUP_WIDTH,
        height: POPUP_HEIGHT,
      };
    },
  },
];

function getWindowMonitorBinPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'window-monitor');
  }
  return path.join(app.getAppPath(), 'window-monitor', 'rust', 'target', 'release', 'window-monitor');
}

function getWebviewManagerBinPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'webview-manager');
  }
  return path.join(app.getAppPath(), 'webview-manager', 'rust', 'target', 'release', 'webview-manager');
}

function getWindowDocumentPathMap(state: SystemState): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const app of state.apps) {
    for (const window of app.windows) {
      map.set(window.id, window.documentPath);
    }
  }
  return map;
}

export class WindowMonitorService {
  private windowMonitorProcess: ChildProcess | null = null;
  private webviewManagerProcess: ChildProcess | null = null;
  private state: SystemState = createInitialState();
  private popupToggledOpen: Set<string> = new Set();
  private popupHeightOverrides: Map<string, number> = new Map();
  private buttonDragOffsets: Map<string, { dx: number; dy: number }> = new Map();
  private popupSizeOverrides: Map<string, { width: number; height: number }> = new Map();
  private baseUrl: string | null = null;
  private authToken: string | null = null;

  start(baseUrl: string, authToken: string): void {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
    const wmBin = getWindowMonitorBinPath();
    const wvBin = getWebviewManagerBinPath();

    logger.info('[WindowMonitorService] Starting window-monitor:', wmBin);
    logger.info('[WindowMonitorService] Starting webview-manager:', wvBin);

    // Spawn window-monitor
    this.windowMonitorProcess = spawn(wmBin, ['--bundle-id', 'com.microsoft.Word'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Spawn webview-manager
    this.webviewManagerProcess = spawn(wvBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle window-monitor stdout: line-delimited JSON events
    const rl = readline.createInterface({ input: this.windowMonitorProcess.stdout! });
    rl.on('line', (line) => {
      let event: WindowMonitorEvent;
      try {
        event = JSON.parse(line);
      } catch {
        logger.warn('[WindowMonitorService] Malformed JSON from window-monitor:', line);
        return;
      }

      logger.info('[WindowMonitorService] Event:', event);

      const newState = reduceWindowMonitorEvent(this.state, event);

      // Detect window→documentPath mapping changes and notify poll subscribers
      const oldMap = getWindowDocumentPathMap(this.state);
      const newMap = getWindowDocumentPathMap(newState);
      let documentPathMappingChanged = false;
      for (const [wid, docPath] of newMap) {
        if (oldMap.get(wid) !== docPath) {
          documentPathMappingChanged = true;
          break;
        }
      }
      this.state = newState;

      if (documentPathMappingChanged) {
        wordPollEventBus.emit('change', 'window-document-path-changed');
      }

      if (event.event === 'WINDOW_DESTROYED' && event.window) {
        this.popupToggledOpen.delete(event.window.id);
        this.popupHeightOverrides.delete(event.window.id);
        this.buttonDragOffsets.delete(event.window.id);
        this.popupSizeOverrides.delete(event.window.id);
      }

      logger.info('[WindowMonitorService] State:', newState);

      this.pushWebviewState();
    });

    // Handle window-monitor stderr
    this.windowMonitorProcess.stderr?.on('data', (data: Buffer) => {
      logger.error('[WindowMonitorService] window-monitor stderr:', data.toString().trimEnd());
    });

    // Handle webview-manager stdout (responses)
    if (this.webviewManagerProcess.stdout) {
      const wvRl = readline.createInterface({ input: this.webviewManagerProcess.stdout });
      wvRl.on('line', (line) => {
        logger.debug('[WindowMonitorService] webview-manager response:', line);
      });
    }

    // Handle webview-manager stderr
    this.webviewManagerProcess.stderr?.on('data', (data: Buffer) => {
      logger.error('[WindowMonitorService] webview-manager stderr:', data.toString().trimEnd());
    });

    // Handle process exit events
    this.windowMonitorProcess.on('error', (err) => {
      logger.error('[WindowMonitorService] window-monitor error:', err.message);
    });

    this.windowMonitorProcess.on('exit', (code, signal) => {
      logger.info('[WindowMonitorService] window-monitor exited', { code, signal });
      this.windowMonitorProcess = null;
    });

    this.webviewManagerProcess.on('error', (err) => {
      logger.error('[WindowMonitorService] webview-manager error:', err.message);
    });

    this.webviewManagerProcess.on('exit', (code, signal) => {
      logger.info('[WindowMonitorService] webview-manager exited', { code, signal });
      this.webviewManagerProcess = null;
    });
  }

  private pushWebviewState(): void {
    if (!this.baseUrl || !this.authToken) return;

    const screenHeight = screen.getPrimaryDisplay().bounds.height;
    const desiredState = computeWebviewState(this.state, webviewConfigs, this.baseUrl, this.authToken, screenHeight);

    for (const key of Object.keys(desiredState)) {
      if (key.startsWith('popup-v2-')) {
        const windowId = key.slice('popup-v2-'.length);
        if (!this.popupToggledOpen.has(windowId)) {
          desiredState[key].visible = false;
        }
        const heightOverride = this.popupHeightOverrides.get(windowId);
        if (heightOverride !== undefined) {
          desiredState[key].frame.height = heightOverride;
        }
        const sizeOverride = this.popupSizeOverrides.get(windowId);
        if (sizeOverride) {
          desiredState[key].frame.width = Math.max(desiredState[key].frame.width, sizeOverride.width);
          desiredState[key].frame.height = Math.max(desiredState[key].frame.height, sizeOverride.height);
        }
      }
    }

    // Apply drag offsets to both button and popup frames, clamped to window bounds
    for (const [windowId, offset] of this.buttonDragOffsets) {
      const buttonKey = `button-v2-${windowId}`;
      const popupKey = `popup-v2-${windowId}`;
      if (!desiredState[buttonKey]) continue;

      // Find window bounds for clamping
      let windowBounds: WindowBounds | null = null;
      for (const app of this.state.apps) {
        for (const window of app.windows) {
          if (window.id === windowId) {
            windowBounds = window.bounds;
            break;
          }
        }
        if (windowBounds) break;
      }

      if (windowBounds) {
        // Cocoa coords: origin is bottom-left of screen, Y increases upward
        const cocoaWindowBottom = screenHeight - (windowBounds.y + windowBounds.height);
        const cocoaWindowLeft = windowBounds.x;
        const cocoaWindowRight = windowBounds.x + windowBounds.width;
        const cocoaWindowTop = cocoaWindowBottom + windowBounds.height;

        const buttonFrame = desiredState[buttonKey].frame;
        // Clamp so button stays within window bounds
        const clampedDx = Math.max(
          cocoaWindowLeft - buttonFrame.x,
          Math.min(offset.dx, cocoaWindowRight - buttonFrame.x - buttonFrame.width)
        );
        const clampedDy = Math.max(
          cocoaWindowBottom - buttonFrame.y,
          Math.min(offset.dy, cocoaWindowTop - buttonFrame.y - buttonFrame.height)
        );

        desiredState[buttonKey].frame.x += clampedDx;
        desiredState[buttonKey].frame.y += clampedDy;

        if (desiredState[popupKey]) {
          desiredState[popupKey].frame.x += clampedDx;
          desiredState[popupKey].frame.y += clampedDy;
        }
      } else {
        // No bounds info, apply offset without clamping
        desiredState[buttonKey].frame.x += offset.dx;
        desiredState[buttonKey].frame.y += offset.dy;
        if (desiredState[popupKey]) {
          desiredState[popupKey].frame.x += offset.dx;
          desiredState[popupKey].frame.y += offset.dy;
        }
      }
    }

    logger.info('[WindowMonitorService] Desired state:', desiredState);

    if (this.webviewManagerProcess?.stdin?.writable) {
      this.webviewManagerProcess.stdin.write(JSON.stringify(desiredState) + '\n');
    }
  }

  togglePopupForWindow(windowId: string): void {
    if (this.popupToggledOpen.has(windowId)) {
      this.popupToggledOpen.delete(windowId);
    } else {
      this.popupToggledOpen.add(windowId);
    }
    this.pushWebviewState();
  }

  setPopupHeight(windowId: string, height: number): void {
    this.popupHeightOverrides.set(windowId, height);
    this.pushWebviewState();
  }

  setButtonDragOffset(windowId: string, dx: number, dy: number): void {
    this.buttonDragOffsets.set(windowId, { dx, dy });
    this.pushWebviewState();
  }

  setPopupSize(windowId: string, width: number, height: number): void {
    this.popupSizeOverrides.set(windowId, { width, height });
    this.pushWebviewState();
  }

  clearPopupSize(windowId: string): void {
    if (this.popupSizeOverrides.delete(windowId)) {
      this.pushWebviewState();
    }
  }

  closePopupForWindow(windowId: string): void {
    if (this.popupToggledOpen.delete(windowId)) {
      this.pushWebviewState();
    }
  }

  getDocumentPathForWindow(windowId: string): string | null {
    for (const app of this.state.apps) {
      for (const window of app.windows) {
        if (window.id === windowId) {
          if (window.documentPath?.startsWith('file://')) {
            return decodeURIComponent(window.documentPath.slice(7));
          }
          return window.documentPath;
        }
      }
    }
    return null;
  }

  stop(): void {
    if (this.windowMonitorProcess) {
      logger.info('[WindowMonitorService] Stopping window-monitor');
      this.windowMonitorProcess.kill();
      this.windowMonitorProcess = null;
    }
    if (this.webviewManagerProcess) {
      logger.info('[WindowMonitorService] Stopping webview-manager');
      this.webviewManagerProcess.kill();
      this.webviewManagerProcess = null;
    }
    this.state = createInitialState();
    this.popupToggledOpen.clear();
    this.popupHeightOverrides.clear();
    this.buttonDragOffsets.clear();
    this.popupSizeOverrides.clear();
  }
}

export const windowMonitorService = new WindowMonitorService();
