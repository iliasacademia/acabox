import { ChildProcess, spawn } from 'child_process';
import { app, screen } from 'electron';
import * as path from 'path';
import * as readline from 'readline';
import { defaultLogger as logger } from './utils/logger';
import { SystemState, WindowMonitorEvent, WindowBounds } from './windowMonitor/types';
import { createInitialState } from './windowMonitor/initialState';
import { reduceWindowMonitorEvent } from './windowMonitor/reducer';
import {
  computeWebviewState,
  WebviewTypeConfig,
} from './windowMonitor/computeWebviewState';

const BUTTON_WIDTH = 150;
const BUTTON_HEIGHT = 50;
const BUTTON_LEFT_MARGIN = 50;
const BUTTON_BOTTOM_MARGIN = 30;

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

export class WindowMonitorService {
  private windowMonitorProcess: ChildProcess | null = null;
  private webviewManagerProcess: ChildProcess | null = null;
  private state: SystemState = createInitialState();

  start(baseUrl: string, authToken: string): void {
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

      logger.info('[WindowMonitorService] State:', newState);

      const screenHeight = screen.getPrimaryDisplay().bounds.height;
      const desiredState = computeWebviewState(newState, webviewConfigs, baseUrl, authToken, screenHeight);

      logger.info('[WindowMonitorService] Desired state:', desiredState);

      if (this.webviewManagerProcess?.stdin?.writable) {
        this.webviewManagerProcess.stdin.write(JSON.stringify(desiredState) + '\n');
      }

      this.state = newState;
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
  }
}

export const windowMonitorService = new WindowMonitorService();
