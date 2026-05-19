import { ChildProcess, execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { app, screen } from 'electron';
import { readFileSync, existsSync, watch, FSWatcher } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { defaultLogger as logger } from './utils/logger';
import { processCpuMonitor } from './utils/processCpuMonitor';
import { SystemState, WindowMonitorEvent, WindowBounds, TextSelectionInfo, DocumentTextInfo } from './windowMonitor/types';
import { wordPollEventBus } from './server/events/wordPollEventBus';
import { createInitialState } from './windowMonitor/initialState';
import { reduceWindowMonitorEvent } from './windowMonitor/reducer';
import { sessionsTracker } from './sessionsTracker';
import { wordIntegrationDataStoreV2 } from './wordIntegrationDataStoreV2';
import { FEATURES } from './shared/types';
import {
  computeWebviewStateV4,
  getFocusedWindowInfo,
  applyFocusLossCarryForward,
  DesiredWebviewState,
  WebviewTypeConfig,
} from './windowMonitor/computeWebviewState';
import { remoteFeatureFlags, REMOTE_FLAGS } from './remoteFeatureFlags';
import { logToWindowMonitorDb } from './windowMonitorDb';
import { getRegisteredHostApps, findHostAppByBundleId } from './cobuilding/main/hostApps';

const BUTTON_WIDTH = 330;
const BUTTON_HEIGHT = 50;
const BUTTON_LEFT_MARGIN = 50;
const BUTTON_BOTTOM_MARGIN = 30;

const POPUP_WIDTH = 370;
const POPUP_HEIGHT = 460;
const POPUP_GAP_ABOVE_BUTTON = 10;


const REVIEW_BUTTON_WIDTH = 120;
const REVIEW_BUTTON_HEIGHT = 46;
const REVIEW_BUTTON_GAP = 10;
const REVIEW_BUTTON_LINE_OFFSET = 42;

const REVIEW_PANEL_WIDTH = 480;
const REVIEW_PANEL_HEIGHT = 650;
const REVIEW_V3_LEFT_MARGIN = 30;
const REVIEW_V3_BOTTOM_MARGIN = 30;

const MIN_DOCKED_WIDTH = 320; // Minimum useful panel width when docked to the right of Word
const REVIEWING_BUTTON_V2_WIDTH = 320;
const ENABLE_FEEDBACK_BUTTON_WIDTH = 220;
const BUTTON_WITH_REVIEW_WIDTH = 700;

const DEBUG_CONTENT_BOUNDS_OVERLAY = process.env.DEBUG_CONTENT_BOUNDS_OVERLAY === '1';
const DEBUG_SELECTION_BOUNDS_OVERLAY = process.env.DEBUG_SELECTION_BOUNDS_OVERLAY === '1';

function getWebviewConfigs(service: WindowMonitorService): WebviewTypeConfig[] {
  // The button + popup overlay should appear over any host app that's
  // registered (today: Word and Obsidian). Compute the bundle-id set once.
  const hostBundleIds = new Set(getRegisteredHostApps().map((h) => h.bundleId));
  const isHostApp = (id: string) => hostBundleIds.has(id);
  // One-shot diagnostic so the log shows which hosts are participating.
  if (!(getWebviewConfigs as any).__loggedHosts) {
    logger.info('[WindowMonitorService] Overlay registered for host bundle ids:', Array.from(hostBundleIds));
    (getWebviewConfigs as any).__loggedHosts = true;
  }
  const configs: WebviewTypeConfig[] = [
    {
      keyPrefix: 'button-v2',
      pathSuffix: '/ui/popup/academiaNotificationsButtonV2/',
      forApp: isHostApp,
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
      forApp: isHostApp,
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
    {
      keyPrefix: 'review-button',
      pathSuffix: '/ui/popup/reviewButton/',
      forApp: 'com.microsoft.Word',
      computeFrame: (_bounds: WindowBounds, screenHeight: number, _contentBounds, selectionBounds, windowId?: string) => {
        if (!_contentBounds) return null;

        // In cobuilding mode, selection goes to the composer pill — no review button needed
        if (service.getActiveWorkspaceDirectories().length > 0) return null;

        // Hide review button when review input is open
        if (windowId && service['reviewInputOpen'].has(windowId)) return null;

        if (!selectionBounds) return null;

        // Clamp selection bounds to visible content area so button appears
        // next to the visible portion of the selection, not off-screen.
        const visibleX = Math.max(selectionBounds.x, _contentBounds.x);
        const visibleY = Math.max(selectionBounds.y, _contentBounds.y);
        const visibleRight = Math.min(
          selectionBounds.x + selectionBounds.width,
          _contentBounds.x + _contentBounds.width
        );
        const visibleBottom = Math.min(
          selectionBounds.y + selectionBounds.height,
          _contentBounds.y + _contentBounds.height
        );
        const visibleWidth = visibleRight - visibleX;
        const visibleHeight = visibleBottom - visibleY;

        if (visibleWidth <= 0 || visibleHeight <= 0) return null;

        // Right of selection with gap, bottom-aligned.
        // If the button doesn't fit to the right of the selection (e.g. full-width
        // multi-page selections), fall back to the right edge of the content area.
        const contentRight = _contentBounds.x + _contentBounds.width;
        let x = visibleRight + REVIEW_BUTTON_GAP;
        if (x + REVIEW_BUTTON_WIDTH > contentRight) {
          x = contentRight - REVIEW_BUTTON_WIDTH;
        }
        const cocoaY = screenHeight - (visibleBottom + REVIEW_BUTTON_LINE_OFFSET);

        // Clamp to window bounds
        const cocoaWindowBottom = screenHeight - (_bounds.y + _bounds.height);
        const cocoaWindowTop = cocoaWindowBottom + _bounds.height;
        const clampedX = Math.max(_bounds.x, Math.min(x, _bounds.x + _bounds.width - REVIEW_BUTTON_WIDTH));
        const clampedY = Math.max(cocoaWindowBottom, Math.min(cocoaY, cocoaWindowTop - REVIEW_BUTTON_HEIGHT));

        // Clamp to content bounds (prefer clamping over hiding so the button stays visible)
        const contentLeft = _contentBounds.x;
        const contentRightEdge = _contentBounds.x + _contentBounds.width;
        const contentCocoaBottom = screenHeight - (_contentBounds.y + _contentBounds.height);
        const contentCocoaTop = contentCocoaBottom + _contentBounds.height;

        let finalX = Math.max(contentLeft, Math.min(clampedX, contentRightEdge - REVIEW_BUTTON_WIDTH));
        let finalY = Math.max(contentCocoaBottom, Math.min(clampedY, contentCocoaTop - REVIEW_BUTTON_HEIGHT));

        // Only hide if the button truly can't fit within content bounds at all
        if (finalX + REVIEW_BUTTON_WIDTH > contentRightEdge || finalX < contentLeft ||
            finalY + REVIEW_BUTTON_HEIGHT > contentCocoaTop || finalY < contentCocoaBottom) {
          return null;
        }

        return { x: finalX, y: finalY, width: REVIEW_BUTTON_WIDTH, height: REVIEW_BUTTON_HEIGHT };
      },
    },
  ];

  if (service.allAppsEnabled) {
    configs.push({
      keyPrefix: 'review-button-v3',
      pathSuffix: '/ui/popup/reviewButtonV3/',
      forApp: (id: string) => id !== 'com.microsoft.Word',
      computeFrame: (_bounds: WindowBounds, screenHeight: number, _contentBounds, selectionBounds, windowId?: string) => {
        // Hide button when panel is open
        if (windowId && service['reviewPanelV3Open'].has(windowId)) return null;
        if (!selectionBounds) return null;

        const cocoaBottomOfWindow = screenHeight - (_bounds.y + _bounds.height);
        const x = _bounds.x + REVIEW_V3_LEFT_MARGIN;
        const y = cocoaBottomOfWindow + REVIEW_V3_BOTTOM_MARGIN;

        return { x, y, width: REVIEW_BUTTON_WIDTH, height: REVIEW_BUTTON_HEIGHT };
      },
    });

    configs.push({
      keyPrefix: 'review-panel-v3',
      pathSuffix: '/ui/popup/reviewPanelV3/',
      makeKey: true,
      forApp: (id: string) => id !== 'com.microsoft.Word',
      computeFrame: (_bounds: WindowBounds, screenHeight: number, _contentBounds, _selectionBounds, windowId?: string) => {
        if (!windowId || !service['reviewPanelV3Open'].has(windowId)) return null;

        const cocoaBottomOfWindow = screenHeight - (_bounds.y + _bounds.height);
        const x = _bounds.x + REVIEW_V3_LEFT_MARGIN;
        const y = cocoaBottomOfWindow + REVIEW_V3_BOTTOM_MARGIN;

        return { x, y, width: REVIEW_PANEL_WIDTH, height: REVIEW_PANEL_HEIGHT };
      },
    });
  }

  if (DEBUG_CONTENT_BOUNDS_OVERLAY) {
    configs.push({
      keyPrefix: 'debug-content-bounds',
      pathSuffix: '/ui/popup/debuggingRedBorderContainer/',
      ignoresMouseEvents: true,
      computeFrame: (_bounds: WindowBounds, screenHeight: number, contentBounds) => {
        if (!contentBounds) return null;
        return {
          x: contentBounds.x,
          y: screenHeight - (contentBounds.y + contentBounds.height),
          width: contentBounds.width,
          height: contentBounds.height,
        };
      },
    });
  }

  if (DEBUG_SELECTION_BOUNDS_OVERLAY) {
    configs.push({
      keyPrefix: 'debug-selection-bounds',
      pathSuffix: '/ui/popup/debuggingRedBorderContainer/?borderColor=blue',
      ignoresMouseEvents: true,
      computeFrame: (_bounds: WindowBounds, screenHeight: number, _contentBounds, selectionBounds) => {
        if (!selectionBounds) return null;
        return {
          x: selectionBounds.x,
          y: screenHeight - (selectionBounds.y + selectionBounds.height),
          width: selectionBounds.width,
          height: selectionBounds.height,
        };
      },
    });
  }

  return configs;
}


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
  // Keyed by host-app id (e.g. 'word', 'obsidian') or the literal 'all-apps'
  // when allAppsEnabled mode is active. One window-monitor process per entry.
  private windowMonitorProcesses: Map<string, ChildProcess> = new Map();
  private webviewManagerProcess: ChildProcess | null = null;

  // ── Process supervision state ──────────────────────────────────────
  private stopped = true;
  private readonly MAX_RAPID_CRASHES = 5;
  private readonly BACKOFF_RESET_MS = 30_000;
  private readonly MAX_BACKOFF_MS = 10_000;
  private readonly WATCHDOG_TIMEOUT_MS = 300_000;
  // Respawn backoff state per process key (includes 'webview-manager')
  private respawnAttempts = new Map<string, number>();
  private respawnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processStartTimes = new Map<string, number>();
  // Watchdog timers per window-monitor process key
  private watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Tracks which process key produced each readline interface so
  // handleWindowMonitorLine can reset the correct watchdog.
  private windowMonitorProcessKeys = new Map<ChildProcess, string>();
  // Stores spawn args so we can respawn window-monitor processes.
  private windowMonitorSpawnArgs = new Map<string, { wmBin: string; wmArgs: string[] }>();
  // Exit promise resolvers for waitForProcessExit()
  private processExitResolvers: Array<() => void> = [];
  private state: SystemState = createInitialState();
  private popupToggledOpen: Set<string> = new Set();
  private reviewInputOpen: Set<string> = new Set();
  private popupHeightOverrides: Map<string, number> = new Map();
  private buttonDragOffsets: Map<string, { dx: number; dy: number }> = new Map();
  private popupSizeOverrides: Map<string, { width: number; height: number }> = new Map();
  private buttonV2WidthOverrides: Map<string, number> = new Map();
  private selectedTextReviewState = new Map<string, {
    projectId: number;
    projectFileId: number;
    startedAt: number;
    reviewType: 'full-paper' | 'selected-text' | 'review-changes';
    selectedText?: string;
  }>();
  private documentTextContentCache = new Map<string, string>();
  private selectedTextContentCache = new Map<string, string>();
  private selectionClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private documentTextCacheCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reviewErrorMessages = new Map<string, string>();
  private reviewPanelV3Open: Set<string> = new Set();
  private dockedRightWindows: Set<string> = new Set();
  private reviewPanelV3SelectedText = new Map<string, string>();
  private lastSelectedText: string | null = null;
  private lastDesiredState: DesiredWebviewState = {};
  private lastV4FocusedWindowId: string | null = null;
  allAppsEnabled: boolean = false;
  private baseUrl: string | null = null;
  private authToken: string | null = null;
  // File paths for which the popup should auto-open when the window is first detected
  private pendingAutoOpenPaths: Set<string> = new Set();
  // File paths that should auto-dock (66/33 split) when the window is first detected
  private pendingDockPaths: Set<string> = new Set();
  // Cobuilding workspace directories — when non-empty, documents within any of
  // these directories are treated as workspace files and the overlay shows
  // workspace sessions. Supports multi-directory workspaces.
  private workspaceDirectories: string[] = [];
  // Watchers for `.obsidian/workspace.json` in each workspace directory that
  // is an Obsidian vault. Obsidian doesn't expose active-document changes
  // through AX, so we observe its layout file directly.
  private obsidianWorkspaceWatchers: FSWatcher[] = [];
  private obsidianWorkspaceWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  // Cache of the currently active Apple Note's synthetic path. Apple Notes
  // doesn't expose AXDocument and the lookup requires an AppleScript round
  // trip, so we refresh the cache async on focus events and surface the
  // cached value synchronously to consumers (poll-response builder, etc.).
  private lastAppleNotesPath: string | null = null;
  private appleNotesRefreshInflight = false;
  // Cache of the currently active Google Doc's synthetic path + display title +
  // selection. Chrome doesn't expose tab URL or in-doc selection through AX, so
  // we ask the connected browser extension on every poll-driven refresh and
  // surface the cached values synchronously. Same pattern as Apple Notes.
  private lastGoogleDocsPath: string | null = null;
  private lastGoogleDocsTitle: string | null = null;
  private lastGoogleDocsSelectedText: string | null = null;
  private googleDocsRefreshInflight = false;
  private sessionsProvider: ((opts: { documentPath?: string; documentPathLike?: string }) => Array<{ id: string; title: string; created_at: string; is_running?: boolean }>) | null = null;
  // When true, WINDOW_TEXT_SELECTED events are ignored (used to suppress
  // programmatic selections from MCP tools like find_and_replace/select_text).
  private selectionEventsSuppressed = false;

  isRunning(): boolean {
    return !this.stopped;
  }

  start(baseUrl: string, authToken: string, allAppsEnabled: boolean = false): void {
    if (process.platform !== 'darwin') {
      logger.info('[WindowMonitorService] Not available on this platform, skipping');
      return;
    }
    this.stopped = false;
    this.baseUrl = baseUrl;
    this.authToken = authToken;
    this.allAppsEnabled = allAppsEnabled;
    const wmBin = getWindowMonitorBinPath();
    const wvBin = getWebviewManagerBinPath();

    logger.info('[WindowMonitorService] Starting webview-manager:', wvBin);

    // Spawn webview-manager (single instance, shared across all monitors)
    this.webviewManagerProcess = spawn(wvBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.processStartTimes.set('webview-manager', Date.now());
    if (this.webviewManagerProcess.pid) processCpuMonitor.register('windowMonitor:webviewManager', this.webviewManagerProcess.pid);

    // Spawn one window-monitor per registered host app (or a single all-apps
    // monitor when in review-button-v3 mode). When only Word is registered,
    // this is byte-identical to the prior single-process behavior.
    if (allAppsEnabled) {
      this.spawnWindowMonitor('all-apps', wmBin, ['--track-text-selection', '--track-document-text']);
    } else {
      const hosts = getRegisteredHostApps();
      if (hosts.length === 0) {
        logger.warn('[WindowMonitorService] No host apps registered — overlay will not appear over any app');
      }
      for (const host of hosts) {
        this.spawnWindowMonitor(host.id, wmBin, host.windowMonitorArgs());
      }
    }

    // Handle webview-manager stdout — act on error responses
    if (this.webviewManagerProcess.stdout) {
      const wvRl = readline.createInterface({ input: this.webviewManagerProcess.stdout });
      wvRl.on('line', (line) => {
        try {
          const resp = JSON.parse(line);
          if (resp.status === 'ERROR') {
            logger.warn('[WindowMonitorService] webview-manager error response:', resp);
            this.pushWebviewState();
          } else {
            logger.info('[WindowMonitorService] webview-manager response:', line);
          }
        } catch {
          logger.info('[WindowMonitorService] webview-manager non-JSON:', line);
        }
      });
    }

    // Handle webview-manager stderr
    this.webviewManagerProcess.stderr?.on('data', (data: Buffer) => {
      logger.warn('[WindowMonitorService] webview-manager stderr:', data.toString().trimEnd());
    });

    this.webviewManagerProcess.on('error', (err) => {
      logger.error('[WindowMonitorService] webview-manager error:', err.message);
    });

    this.webviewManagerProcess.on('exit', (code, signal) => {
      logger.info('[WindowMonitorService] webview-manager exited', { code, signal });
      this.webviewManagerProcess = null;
      this.notifyProcessExit();
      if (!this.stopped) {
        this.scheduleRespawn('webview-manager', () => {
          const bin = getWebviewManagerBinPath();
          this.webviewManagerProcess = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
          this.processStartTimes.set('webview-manager', Date.now());
          if (this.webviewManagerProcess.pid) processCpuMonitor.register('windowMonitor:webviewManager', this.webviewManagerProcess.pid);
          this.setupWebviewManagerHandlers();
          // Re-send last known state so overlay is restored
          this.pushWebviewState();
          logger.info('[WindowMonitorService] webview-manager respawned successfully');
        });
      }
    });
  }

  private setupWebviewManagerHandlers(): void {
    if (!this.webviewManagerProcess) return;

    if (this.webviewManagerProcess.stdout) {
      const wvRl = readline.createInterface({ input: this.webviewManagerProcess.stdout });
      wvRl.on('line', (line) => {
        try {
          const resp = JSON.parse(line);
          if (resp.status === 'ERROR') {
            logger.warn('[WindowMonitorService] webview-manager error response:', resp);
            this.pushWebviewState();
          } else {
            logger.info('[WindowMonitorService] webview-manager response:', line);
          }
        } catch {
          logger.info('[WindowMonitorService] webview-manager non-JSON:', line);
        }
      });
    }

    this.webviewManagerProcess.stderr?.on('data', (data: Buffer) => {
      logger.warn('[WindowMonitorService] webview-manager stderr:', data.toString().trimEnd());
    });

    this.webviewManagerProcess.on('error', (err) => {
      logger.error('[WindowMonitorService] webview-manager error:', err.message);
    });

    this.webviewManagerProcess.on('exit', (code, signal) => {
      logger.info('[WindowMonitorService] webview-manager exited', { code, signal });
      this.webviewManagerProcess = null;
      this.notifyProcessExit();
      if (!this.stopped) {
        this.scheduleRespawn('webview-manager', () => {
          const bin = getWebviewManagerBinPath();
          this.webviewManagerProcess = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
          this.processStartTimes.set('webview-manager', Date.now());
          if (this.webviewManagerProcess.pid) processCpuMonitor.register('windowMonitor:webviewManager', this.webviewManagerProcess.pid);
          this.setupWebviewManagerHandlers();
          this.pushWebviewState();
          logger.info('[WindowMonitorService] webview-manager respawned successfully');
        });
      }
    });
  }

  private spawnWindowMonitor(processKey: string, wmBin: string, wmArgs: string[]): void {
    logger.info(`[WindowMonitorService] Starting window-monitor for ${processKey}:`, wmBin);
    logger.info(`[WindowMonitorService] Spawn args (${processKey}):`, wmArgs);
    this.windowMonitorSpawnArgs.set(processKey, { wmBin, wmArgs });
    const proc = spawn(wmBin, wmArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.windowMonitorProcesses.set(processKey, proc);
    this.windowMonitorProcessKeys.set(proc, processKey);
    if (proc.pid) processCpuMonitor.register(`windowMonitor:${processKey}`, proc.pid);
    this.processStartTimes.set(`wm:${processKey}`, Date.now());

    // Handle window-monitor stdout: line-delimited JSON events
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      this.resetWatchdog(processKey);
      this.handleWindowMonitorLine(line);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      logger.warn(`[WindowMonitorService] window-monitor (${processKey}) stderr:`, data.toString().trimEnd());
    });

    proc.on('error', (err) => {
      logger.error(`[WindowMonitorService] window-monitor (${processKey}) error:`, err.message);
    });

    proc.on('exit', (code, signal) => {
      logger.info(`[WindowMonitorService] window-monitor (${processKey}) exited`, { code, signal });
      this.windowMonitorProcesses.delete(processKey);
      this.windowMonitorProcessKeys.delete(proc);
      this.clearWatchdog(processKey);
      this.notifyProcessExit();
      if (!this.stopped) {
        this.scheduleRespawn(`wm:${processKey}`, () => {
          const args = this.windowMonitorSpawnArgs.get(processKey);
          if (args) {
            this.spawnWindowMonitor(processKey, args.wmBin, args.wmArgs);
            logger.info(`[WindowMonitorService] window-monitor (${processKey}) respawned successfully`);
          }
        });
      }
    });

    // Start watchdog for this process
    this.resetWatchdog(processKey);
  }

  private handleWindowMonitorLine(line: string): void {
    let event: WindowMonitorEvent;
      try {
        event = JSON.parse(line);
      } catch {
        logger.warn('[WindowMonitorService] Malformed JSON from window-monitor:', line);
        return;
      }

      logToWindowMonitorDb('window_monitor_event', event);

      if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
        logger.info('[VERBOSE] [WindowMonitorService] Event:', event);
      }

      // Debounce WINDOW_TEXT_SELECTION_CLEARED: delay processing by 1s so the
      // review button stays visible long enough for a click to register.
      if (event.event === 'WINDOW_TEXT_SELECTION_CLEARED' && event.window) {
        const windowId = event.window.id;
        logger.info(`[WindowMonitor] WINDOW_TEXT_SELECTION_CLEARED wid=${windowId} (debouncing 500ms)`);
        // Cancel any existing debounce timer for this window
        const existingTimer = this.selectionClearTimers.get(windowId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          this.selectionClearTimers.delete(windowId);
          this.selectedTextContentCache.delete(windowId);
          // Now apply the deferred clear
          const deferredState = reduceWindowMonitorEvent(this.state, event);
          this.state = deferredState;
          if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
            logger.info('[VERBOSE] [WindowMonitorService] State:', deferredState);
          }
          this.pushWebviewState();
          wordPollEventBus.emit('change', 'selected-text-cleared');
        }, 500);
        this.selectionClearTimers.set(windowId, timer);
        return; // Skip immediate processing
      }

      const newState = reduceWindowMonitorEvent(this.state, event);

      // Detect window→documentPath mapping changes and notify poll subscribers
      const oldMap = getWindowDocumentPathMap(this.state);
      const newMap = getWindowDocumentPathMap(newState);
      let documentPathMappingChanged = false;
      const pendingDockWindows: string[] = [];
      for (const [wid, docPath] of newMap) {
        if (oldMap.get(wid) !== docPath) {
          documentPathMappingChanged = true;
          if (docPath) {
            const normalizedDocPath = docPath.startsWith('file://')
              ? decodeURIComponent(docPath.slice(7))
              : docPath;
            // Auto-open popup if this window's document was scheduled for auto-open
            if (this.pendingAutoOpenPaths.has(normalizedDocPath)) {
              this.pendingAutoOpenPaths.delete(normalizedDocPath);
              logger.info(`[WindowMonitor] Auto-opening popup for new window ${wid} (path match)`);
              this.popupToggledOpen.add(wid);
            }
            if (this.pendingDockPaths.has(normalizedDocPath)) {
              this.pendingDockPaths.delete(normalizedDocPath);
              pendingDockWindows.push(wid);
            }
          }
        }
      }
      this.state = newState;

      for (const wid of pendingDockWindows) {
        logger.info(`[WindowMonitor] Auto-docking for new window ${wid} (path match)`);
        this.setDockRight(wid, true);
      }
      logToWindowMonitorDb('window_monitor_state', newState);

      // Track activity sessions
      if (FEATURES.SESSION_CAPTURE_ENABLED) {
        sessionsTracker.processEvent(event);
      }

      // Cache selection bounds when text is selected (only for real selections, not cursor positions)
      if (event.event === 'WINDOW_TEXT_SELECTED' && event.window && event.selection.length > 0) {
        // Cancel any pending selection-clear debounce (new selection supersedes it)
        const pendingTimer = this.selectionClearTimers.get(event.window.id);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          this.selectionClearTimers.delete(event.window.id);
        }
      }

      // Cache selected text content in memory when it changes (same pattern as documentTextContentCache).
      // Skip when suppressed — programmatic selections (from MCP tools) should not appear as user pills.
      if (event.event === 'WINDOW_TEXT_SELECTED' && event.window && event.selection.length > 0 && !this.selectionEventsSuppressed) {
        logger.info(`[WindowMonitor] WINDOW_TEXT_SELECTED wid=${event.window.id} filePath=${event.selection.filePath} selectionLength=${event.selection.length}`);
        try {
          const content = readFileSync(event.selection.filePath, 'utf-8');
          logger.info(`[WindowMonitor] selectedTextContentCache set wid=${event.window.id} contentLength=${content.length}`);
          if (content.length > 0) {
            this.selectedTextContentCache.set(event.window.id, content);
            this.lastSelectedText = content;
            wordPollEventBus.emit('change', 'selected-text-changed');
          }
        } catch (err) {
          logger.error(`[WindowMonitorService] Failed to cache selected text for window ${event.window.id}:`, err);
        }
      }

      if (documentPathMappingChanged) {
        wordPollEventBus.emit('change', 'window-document-path-changed');
      }

      // Cache document text content in memory when it changes.
      // At this moment the Rust side just wrote the file, so the content is fresh.
      if (event.event === 'WINDOW_DOCUMENT_TEXT_CHANGED' && event.document) {
        const { filePath } = event.document;
        const windowId = event.window.id;
        try {
          const content = readFileSync(filePath, 'utf-8');
          if (content.length > 1) {
            this.documentTextContentCache.set(windowId, content);
            // Cancel any pending delayed cleanup for this window (from a prior WINDOW_DESTROYED)
            const pendingCleanup = this.documentTextCacheCleanupTimers.get(windowId);
            if (pendingCleanup) {
              clearTimeout(pendingCleanup);
              this.documentTextCacheCleanupTimers.delete(windowId);
            }
            logger.info(`[WindowMonitorService] Cached document text for window ${windowId}: ${content.length} bytes`);
            if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
              logger.info('[VERBOSE] [WindowMonitorService] Document text cache set', {
                windowId,
                filePath,
                contentLength: content.length,
                cacheSize: this.documentTextContentCache.size,
                allCachedWindows: Array.from(this.documentTextContentCache.keys()),
              });
            }
          } else {
            logger.warn(`[WindowMonitorService] Ignoring trivially small document text for window ${windowId}: ${content.length} bytes`);
          }
        } catch (err) {
          logger.error(`[WindowMonitorService] Failed to cache document text for window ${windowId}:`, err);
        }
      }

      if (event.event === 'WINDOW_DESTROYED' && event.window) {
        if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
          logger.info('[VERBOSE] [WindowMonitorService] WINDOW_DESTROYED cleanup', {
            windowId: event.window.id,
            hadDocumentTextCache: this.documentTextContentCache.has(event.window.id),
            hadSelectedTextCache: this.selectedTextContentCache.has(event.window.id),
          });
        }
        this.popupToggledOpen.delete(event.window.id);
        this.reviewInputOpen.delete(event.window.id);
        this.popupHeightOverrides.delete(event.window.id);
        this.buttonDragOffsets.delete(event.window.id);
        this.popupSizeOverrides.delete(event.window.id);
        this.buttonV2WidthOverrides.delete(event.window.id);
        this.selectedTextReviewState.delete(event.window.id);
        this.reviewPanelV3Open.delete(event.window.id);
        this.reviewPanelV3SelectedText.delete(event.window.id);
        // Delay documentTextContentCache cleanup by 24h so the cache survives
        // window destroy/recreate cycles (the review button needs it).
        const cleanupTimer = setTimeout(() => {
          this.documentTextContentCache.delete(event.window.id);
          this.documentTextCacheCleanupTimers.delete(event.window.id);
        }, 24 * 60 * 60 * 1000);
        this.documentTextCacheCleanupTimers.set(event.window.id, cleanupTimer);
        this.selectedTextContentCache.delete(event.window.id);
        const destroyTimer = this.selectionClearTimers.get(event.window.id);
        if (destroyTimer) {
          clearTimeout(destroyTimer);
          this.selectionClearTimers.delete(event.window.id);
        }
      }

      if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
        logger.info('[VERBOSE] [WindowMonitorService] State:', newState);
      }

      this.pushWebviewState();
  }

  private pushWebviewState(): void {
    if (!this.baseUrl || !this.authToken) return;

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().bounds;
    const desiredState = computeWebviewStateV4(this.state, getWebviewConfigs(this), this.baseUrl, this.authToken, screenHeight);

    const focused = getFocusedWindowInfo(this.state);
    let windowId = focused?.window.id ?? null;

    // If no focused window but we explicitly docked one, use it — handles
    // cold start where the focus event hasn't arrived yet.
    if (!windowId && this.dockedRightWindows.size > 0) {
      windowId = [...this.dockedRightWindows][0];
    }

    const hostAppFocused = this.state.focusedAppIdentifier !== null;
    const carryForward = applyFocusLossCarryForward(desiredState, this.lastDesiredState, hostAppFocused, this.lastV4FocusedWindowId);
    Object.assign(desiredState, carryForward.desiredState);
    if (carryForward.windowId) windowId = carryForward.windowId;

    // Apply per-window overrides only when the host app is focused —
    // skip when carrying forward hidden state during focus loss.
    if (desiredState['popup-v2'] && windowId && hostAppFocused) {
      const isToggledOpen = this.popupToggledOpen.has(windowId);
      desiredState['popup-v2'].visible = isToggledOpen;
      if (isToggledOpen) {
        logger.info(`[WindowMonitor] Popup popup-v2: showing (toggled=true, wid=${windowId})`);
      }

      const heightOverride = this.popupHeightOverrides.get(windowId);
      if (heightOverride !== undefined) {
        desiredState['popup-v2'].frame.height = heightOverride;
      }
      const sizeOverride = this.popupSizeOverrides.get(windowId);
      if (sizeOverride) {
        desiredState['popup-v2'].frame.width = Math.max(desiredState['popup-v2'].frame.width, sizeOverride.width);
        desiredState['popup-v2'].frame.height = Math.max(desiredState['popup-v2'].frame.height, sizeOverride.height);
      }
    }

    if (desiredState['review-panel-v3'] && windowId && hostAppFocused) {
      const isPanelOpen = this.reviewPanelV3Open.has(windowId);
      desiredState['review-panel-v3'].visible = isPanelOpen;
    }

    if (desiredState['button-v2'] && windowId && hostAppFocused) {
      const buttonWidthOverride = this.buttonV2WidthOverrides.get(windowId);
      if (buttonWidthOverride !== undefined) {
        desiredState['button-v2'].frame.width = buttonWidthOverride;
      } else if (this.workspaceDirectories.length === 0) {
        // Only shrink to ENABLE_FEEDBACK_BUTTON_WIDTH in writing agent mode
        const docPath = this.getDocumentPathForWindow(windowId);
        if (!docPath || !wordIntegrationDataStoreV2.getProjectFileForPath(docPath)) {
          desiredState['button-v2'].frame.width = ENABLE_FEEDBACK_BUTTON_WIDTH;
        }
      }
      // Widen for "Review Selection" when text is selected (not in cobuilding mode)
      if (this.workspaceDirectories.length === 0) {
        const selectedText = this.getSelectedTextForWindow(windowId);
        if (selectedText && selectedText.length > 0) {
          desiredState['button-v2'].frame.width = Math.max(desiredState['button-v2'].frame.width, BUTTON_WITH_REVIEW_WIDTH);
        }
      }
    }

    // Apply drag offset for the focused window
    if (windowId && hostAppFocused && this.buttonDragOffsets.has(windowId) && desiredState['button-v2']) {
      const offset = this.buttonDragOffsets.get(windowId)!;
      const buttonKey = 'button-v2';
      const popupKey = 'popup-v2';
      let windowBounds: WindowBounds | null = focused?.window.bounds ?? null;

      if (windowBounds) {
        const cocoaWindowBottom = screenHeight - (windowBounds.y + windowBounds.height);
        const cocoaWindowLeft = windowBounds.x;
        const cocoaWindowRight = windowBounds.x + windowBounds.width;
        const cocoaWindowTop = cocoaWindowBottom + windowBounds.height;

        const buttonFrame = desiredState[buttonKey].frame;
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

        // Don't move the popup with the button when docked — docked override handles position
        if (desiredState[popupKey] && !this.dockedRightWindows.has(windowId)) {
          desiredState[popupKey].frame.x += clampedDx;
          desiredState[popupKey].frame.y += clampedDy;
        }
      } else {
        desiredState[buttonKey].frame.x += offset.dx;
        desiredState[buttonKey].frame.y += offset.dy;
        // Don't move the popup with the button when docked — docked override handles position
        if (desiredState[popupKey] && !this.dockedRightWindows.has(windowId)) {
          desiredState[popupKey].frame.x += offset.dx;
          desiredState[popupKey].frame.y += offset.dy;
        }
      }
    }

    // Apply docked-right override — snaps popup-v2 to right edge of Word window, full height.
    // When Word is maximized and there is insufficient space to the right, skip the docked
    // override so the panel falls back to the regular floating overlay behavior.
    // Look up bounds by windowId directly — clicking the overlay causes Word to lose focus,
    // so focused?.window.bounds may be null.
    if (windowId && hostAppFocused && this.dockedRightWindows.has(windowId) && desiredState['popup-v2']) {
      let dockedWindowBounds: WindowBounds | null = focused?.window.bounds ?? null;
      if (!dockedWindowBounds) {
        for (const app of this.state.apps) {
          for (const win of app.windows) {
            if (win.id === windowId) { dockedWindowBounds = win.bounds; break; }
          }
          if (dockedWindowBounds) break;
        }
      }
      if (dockedWindowBounds) {
        const dockedX = dockedWindowBounds.x + dockedWindowBounds.width;
        const remainingWidth = screenWidth - dockedX;
        if (remainingWidth >= MIN_DOCKED_WIDTH) {
          desiredState['popup-v2'].frame.x = dockedX;
          desiredState['popup-v2'].frame.y = screenHeight - (dockedWindowBounds.y + dockedWindowBounds.height);
          desiredState['popup-v2'].frame.width = Math.min(remainingWidth, dockedWindowBounds.width);
          desiredState['popup-v2'].frame.height = dockedWindowBounds.height;
          desiredState['popup-v2'].visible = true;
          // Hide the floating button — the panel is always visible when docked
          if (desiredState['button-v2']) desiredState['button-v2'].visible = false;
        }
        // else: Word is too wide — fall through to regular floating overlay
      }
    }

    if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
      logger.info('[VERBOSE] [WindowMonitorService] V4 desired state:', desiredState);
    }

    // Diff visibility — v4 uses global keys directly
    const V4_VISIBILITY_KEYS = ['button-v2', 'popup-v2', 'review-button', 'review-panel-v3', 'review-button-v3'];
    let visibilityChanged = false;
    for (const key of V4_VISIBILITY_KEYS) {
      const newVisible = desiredState[key]?.visible ?? false;
      const oldVisible = this.lastDesiredState[key]?.visible ?? false;
      if (newVisible !== oldVisible) {
        visibilityChanged = true;
        break;
      }
    }
    if (!visibilityChanged) {
      for (const key of V4_VISIBILITY_KEYS) {
        if (this.lastDesiredState[key]?.visible && !desiredState[key]) {
          visibilityChanged = true;
          break;
        }
      }
    }

    // Detect focused window change — even if visibility didn't change,
    // the poll data is different so WebSocket clients need a refresh.
    const focusedWindowChanged = windowId !== this.lastV4FocusedWindowId;
    this.lastV4FocusedWindowId = windowId;

    this.lastDesiredState = desiredState;
    logToWindowMonitorDb('webview_manager_state', desiredState);
    if (visibilityChanged || focusedWindowChanged) {
      wordPollEventBus.emit('change', 'webview-visibility-changed');
    }

    if (visibilityChanged) {
      const visibleKeys = V4_VISIBILITY_KEYS.filter(k => desiredState[k]?.visible);
      if (visibleKeys.length > 0) {
        logger.info(`[WindowMonitorService] Overlay showing: ${visibleKeys.join(', ')} (wid=${windowId})`);
      } else {
        logger.info(`[WindowMonitorService] Overlay hidden (wid=${windowId})`);
      }
    }

    if (this.webviewManagerProcess?.stdin?.writable) {
      this.webviewManagerProcess.stdin.write(JSON.stringify(desiredState) + '\n');
    } else {
      logger.error('[WindowMonitorService] Cannot send state to webview-manager: stdin not writable');
    }
  }

  /**
   * Get the currently focused window ID, or null if no window is focused.
   */
  getFocusedWindowId(): string | null {
    const focused = getFocusedWindowInfo(this.state);
    return focused?.window.id ?? null;
  }

  getLastFocusedWindowId(): string | null {
    return this.lastV4FocusedWindowId;
  }

  /**
   * Find the tracked window ID for a given document path.
   * Normalizes file:// URLs to plain paths for matching.
   */
  getWindowIdForDocumentPath(documentPath: string): string | null {
    for (const app of this.state.apps) {
      for (const win of app.windows) {
        const raw = win.documentPath;
        if (raw) {
          const normalized = raw.startsWith('file://')
            ? decodeURIComponent(raw.slice(7))
            : raw;
          if (normalized === documentPath) {
            return win.id;
          }
        }
      }
    }
    return null;
  }

  togglePopupForWindow(windowId: string): void {
    const wasOpen = this.popupToggledOpen.has(windowId);
    if (wasOpen) {
      this.popupToggledOpen.delete(windowId);
      this.popupHeightOverrides.delete(windowId);
      this.popupSizeOverrides.delete(windowId);
      logger.info(`[WindowMonitor] Popup closed for window ${windowId}`);
    } else {
      this.popupToggledOpen.add(windowId);
      logger.info(`[WindowMonitor] Popup opened for window ${windowId}`);
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

  getButtonDragOffset(windowId: string): { dx: number; dy: number } {
    return this.buttonDragOffsets.get(windowId) ?? { dx: 0, dy: 0 };
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

  setSelectedTextReviewState(
    windowId: string,
    projectId: number,
    projectFileId: number,
    reviewType: 'full-paper' | 'selected-text' | 'review-changes' = 'selected-text',
    selectedText?: string
  ): void {
    this.selectedTextReviewState.set(windowId, { projectId, projectFileId, startedAt: Date.now(), reviewType, selectedText });
    this.buttonV2WidthOverrides.set(windowId, REVIEWING_BUTTON_V2_WIDTH);
    this.pushWebviewState();
  }

  clearSelectedTextReviewState(windowId: string): void {
    this.selectedTextReviewState.delete(windowId);
    this.buttonV2WidthOverrides.delete(windowId);
    this.pushWebviewState();
  }

  getSelectedTextReviewState(windowId: string): {
    projectId: number;
    projectFileId: number;
    startedAt: number;
    reviewType: 'full-paper' | 'selected-text' | 'review-changes';
    selectedText?: string;
  } | null {
    return this.selectedTextReviewState.get(windowId) ?? null;
  }

  getAllSelectedTextReviewStates(): Map<string, { projectId: number; projectFileId: number; startedAt: number; reviewType: 'full-paper' | 'selected-text' | 'review-changes'; selectedText?: string }> {
    return this.selectedTextReviewState;
  }

  setReviewErrorMessage(windowId: string, message: string): void {
    this.reviewErrorMessages.set(windowId, message);
    wordPollEventBus.emit('change', 'review-error-changed');
  }

  getReviewErrorMessage(windowId: string): string | null {
    return this.reviewErrorMessages.get(windowId) ?? null;
  }

  clearReviewErrorMessage(windowId: string): void {
    if (this.reviewErrorMessages.delete(windowId)) {
      wordPollEventBus.emit('change', 'review-error-changed');
    }
  }

  scheduleAutoOpenForPath(filePath: string): void {
    // Check if a window tracking this document is already known
    for (const trackedApp of this.state.apps) {
      for (const win of trackedApp.windows) {
        if (win.documentPath) {
          const normalized = win.documentPath.startsWith('file://')
            ? decodeURIComponent(win.documentPath.slice(7))
            : win.documentPath;
          if (normalized === filePath) {
            logger.info(`[WindowMonitor] Immediately opening popup for existing window ${win.id}`);
            this.popupToggledOpen.add(win.id);
            this.pushWebviewState();
            return;
          }
        }
      }
    }
    // Window not yet tracked — open popup when it first appears
    logger.info(`[WindowMonitor] Scheduling popup auto-open for path: ${filePath}`);
    this.pendingAutoOpenPaths.add(filePath);
  }

  openPopupForWindow(windowId: string): void {
    logger.info(`[WindowMonitor] Opening popup for window ${windowId}, already open: ${this.popupToggledOpen.has(windowId)}`);
    this.popupToggledOpen.add(windowId);
    this.pushWebviewState();
  }

  closePopupForWindow(windowId: string, clearReviewState: boolean = true): void {
    logger.info(`[WindowMonitor] Closing popup for window ${windowId}, clearReviewState=${clearReviewState}`);
    this.dockedRightWindows.delete(windowId);
    if (this.popupToggledOpen.delete(windowId)) {
      this.popupHeightOverrides.delete(windowId);
      this.popupSizeOverrides.delete(windowId);
      if (clearReviewState) {
        this.clearSelectedTextReviewState(windowId);
        this.closeReviewInput(windowId);
      }
      this.reviewErrorMessages.delete(windowId);
      this.pushWebviewState();
    } else {
      logger.info(`[WindowMonitor] Popup for window ${windowId} was not open`);
    }
  }

  getDesiredWebviewVisibility(keyPrefix: string, _windowId: string): boolean {
    return this.lastDesiredState[keyPrefix]?.visible ?? false;
  }

  getDocumentPathForWindow(windowId: string): string | null {
    for (const app of this.state.apps) {
      for (const window of app.windows) {
        if (window.id === windowId) {
          // Route through the host app that owns this window's bundle id, if any.
          // Word: returns window.documentPath as-is (today's behavior).
          // Obsidian: reads .obsidian/workspace.json against the workspace dir.
          // Apple Notes: returns the async-refreshed cache from this service.
          const host = findHostAppByBundleId(app.identifier);
          if (host) {
            if (host.id === 'apple-notes') {
              // Kick off an async refresh so the next poll sees the latest
              // selection, then return whatever the cache currently holds.
              void this.refreshAppleNotesPath();
              return this.lastAppleNotesPath;
            }
            if (host.id === 'google-docs') {
              // Same pattern as Apple Notes — Chrome's tab URL only comes from
              // the browser extension, so we refresh async and surface the
              // cached `gdocs://<id>` path synchronously.
              void this.refreshGoogleDocsPath();
              return this.lastGoogleDocsPath;
            }
            const resolved = host.resolveDocumentPath(window, this.workspaceDirectories);
            if (resolved?.startsWith('file://')) {
              return decodeURIComponent(resolved.slice(7));
            }
            return resolved;
          }
          // No host registered for this app — fall back to legacy behavior.
          if (window.documentPath?.startsWith('file://')) {
            return decodeURIComponent(window.documentPath.slice(7));
          }
          return window.documentPath;
        }
      }
    }
    return null;
  }

  /**
   * Async refresh of the cached Apple-Notes active-note path. Idempotent /
   * de-duped via the inflight flag — multiple back-to-back calls during a
   * burst of poll requests collapse into one AppleScript round-trip.
   * On change, emits a poll event so the popup re-fetches.
   */
  private async refreshAppleNotesPath(): Promise<void> {
    if (this.appleNotesRefreshInflight) return;
    this.appleNotesRefreshInflight = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { resolveActiveAppleNotePath } = require('./cobuilding/main/hostApps/appleNotesHostApp');
      const next: string | null = await resolveActiveAppleNotePath();
      if (next !== this.lastAppleNotesPath) {
        this.lastAppleNotesPath = next;
        wordPollEventBus.emit('change', 'window-document-path-changed');
      }
    } catch {
      // ignore — Apple Events errors fall through; cache stays stale.
    } finally {
      this.appleNotesRefreshInflight = false;
    }
  }

  /**
   * Async refresh of the cached Google Docs active-tab path. Mirrors
   * `refreshAppleNotesPath` — dedupe via inflight flag, emit a poll event on
   * change. Source of truth is the connected browser extension; when the
   * extension is disconnected or the active tab is not a Google Doc, the
   * cached value is null and the overlay falls back to the
   * `sessionDocumentPathLikePattern` listing.
   */
  private async refreshGoogleDocsPath(): Promise<void> {
    if (this.googleDocsRefreshInflight) return;
    this.googleDocsRefreshInflight = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { resolveActiveGoogleDocInfo } = require('./cobuilding/main/hostApps/googleDocsHostApp');
      const info: { documentPath: string; title: string | null; selectedText: string | null } | null = await resolveActiveGoogleDocInfo();
      const nextPath = info?.documentPath ?? null;
      const nextTitle = info?.title ?? null;
      const nextSelection = info?.selectedText ?? null;
      const pathChanged = nextPath !== this.lastGoogleDocsPath;
      const titleChanged = nextTitle !== this.lastGoogleDocsTitle;
      const selectionChanged = nextSelection !== this.lastGoogleDocsSelectedText;
      this.lastGoogleDocsPath = nextPath;
      this.lastGoogleDocsTitle = nextTitle;
      this.lastGoogleDocsSelectedText = nextSelection;
      if (pathChanged || titleChanged) {
        wordPollEventBus.emit('change', 'window-document-path-changed');
      }
      if (selectionChanged) {
        wordPollEventBus.emit('change', 'selected-text-changed');
      }
    } catch {
      // ignore — extension may be disconnected / mid-handshake; cache stays stale.
    } finally {
      this.googleDocsRefreshInflight = false;
    }
  }

  /** Latest cached display title for the active Google Doc, or null when unknown. */
  getGoogleDocsTitle(): string | null {
    return this.lastGoogleDocsTitle;
  }

  /** Latest cached selected text inside the active Google Doc, or null when nothing is selected. */
  getGoogleDocsSelectedText(): string | null {
    return this.lastGoogleDocsSelectedText;
  }

  /** Return the HostApp id that owns the given window's bundle, or null. */
  getHostAppIdForWindow(windowId: string): string | null {
    for (const app of this.state.apps) {
      for (const window of app.windows) {
        if (window.id === windowId) {
          return findHostAppByBundleId(app.identifier)?.id ?? null;
        }
      }
    }
    return null;
  }

  /** Activate the host app that owns the given window, bringing it to front. */
  activateHostAppForWindow(windowId: string): void {
    for (const a of this.state.apps) {
      for (const w of a.windows) {
        if (w.id === windowId) {
          const bundleId = a.identifier;
          execFile('osascript', ['-e', `tell application id "${bundleId}" to activate`], (err) => {
            if (err) logger.warn(`[WindowMonitorService] Failed to activate ${bundleId}:`, err.message);
          });
          return;
        }
      }
    }
  }

  getSelectedTextForWindow(windowId: string): TextSelectionInfo | null {
    for (const app of this.state.apps) {
      for (const window of app.windows) {
        if (window.id === windowId) {
          return window.selectedText;
        }
      }
    }
    return null;
  }

  getDocumentTextContent(windowId: string): string | null {
    return this.documentTextContentCache.get(windowId) ?? null;
  }

  getSelectedTextContent(windowId: string): string | null {
    return this.selectedTextContentCache.get(windowId) ?? null;
  }

  getLastSelectedText(): string | null {
    return this.lastSelectedText;
  }

  getDocumentTextForWindow(windowId: string): DocumentTextInfo | null {
    for (const app of this.state.apps) {
      for (const window of app.windows) {
        if (window.id === windowId) {
          return window.documentText;
        }
      }
    }
    return null;
  }

  openReviewInput(windowId: string): void {
    this.reviewInputOpen.add(windowId);
    logger.info(`[WindowMonitor] Review input opened for window ${windowId}`);
    this.pushWebviewState();
  }

  closeReviewInput(windowId: string): void {
    this.reviewInputOpen.delete(windowId);
    logger.info(`[WindowMonitor] Review input closed for window ${windowId}`);
    this.pushWebviewState();
  }

  isReviewInputOpen(windowId: string): boolean {
    return this.reviewInputOpen.has(windowId);
  }

  openReviewPanelV3(windowId: string): void {
    // Snapshot selected text: try per-window cache first, fall back to global last selection
    const selectedText = this.selectedTextContentCache.get(windowId) ?? this.lastSelectedText;
    logger.info(`[WindowMonitor] openReviewPanelV3 wid=${windowId} cachedSelectedText=${selectedText ? `"${selectedText.substring(0, 80)}..."` : 'null'} cacheKeys=[${[...this.selectedTextContentCache.keys()].join(',')}]`);
    if (selectedText) {
      this.reviewPanelV3SelectedText.set(windowId, selectedText);
    }
    this.reviewPanelV3Open.add(windowId);
    logger.info(`[WindowMonitor] Review panel V3 opened for window ${windowId}`);
    this.pushWebviewState();
  }

  closeReviewPanelV3(windowId: string): void {
    this.reviewPanelV3Open.delete(windowId);
    this.reviewPanelV3SelectedText.delete(windowId);
    logger.info(`[WindowMonitor] Review panel V3 closed for window ${windowId}`);
    this.pushWebviewState();
  }

  isReviewPanelV3Open(windowId: string): boolean {
    return this.reviewPanelV3Open.has(windowId);
  }

  getDockedWindowId(): string | null {
    return this.dockedRightWindows.size > 0 ? [...this.dockedRightWindows][0] : null;
  }

  /**
   * Returns true when the window is registered as docked AND there is currently
   * enough screen space to the right of the Word window to show the panel.
   * Returns false when Word is maximized (or very wide) and the panel has fallen
   * back to the floating overlay position.
   */
  isDockedActive(windowId: string): boolean {
    if (!this.dockedRightWindows.has(windowId)) return false;
    // Find the window bounds by ID (the window may not be focused)
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
    if (!windowBounds) return false;
    const { width: screenWidth } = screen.getPrimaryDisplay().bounds;
    const remainingWidth = screenWidth - (windowBounds.x + windowBounds.width);
    return remainingWidth >= MIN_DOCKED_WIDTH;
  }

  setDockRight(windowId: string, docked: boolean): void {
    if (docked) {
      this.dockedRightWindows.add(windowId);
      this.popupToggledOpen.add(windowId);
      this.lastV4FocusedWindowId = windowId;
      logger.info(`[WindowMonitor] setDockRight: docked wid=${windowId}`);

      // If Word is too wide to fit the panel beside it (e.g. maximized), resize Word to
      // 66.5% of the work area so the overlay can occupy the remaining 33.5%.
      // Look up bounds by windowId directly — clicking the overlay causes Word to lose
      // focus, so getFocusedWindowInfo() may return null.
      let windowBounds: WindowBounds | null = null;
      for (const app of this.state.apps) {
        for (const win of app.windows) {
          if (win.id === windowId) { windowBounds = win.bounds; break; }
        }
        if (windowBounds) break;
      }
      const { width: screenWidth } = screen.getPrimaryDisplay().bounds;
      if (windowBounds && (screenWidth - (windowBounds.x + windowBounds.width)) < MIN_DOCKED_WIDTH) {
        this.resizeWordForDocking();
      }
    } else {
      this.dockedRightWindows.delete(windowId);
      logger.info(`[WindowMonitor] setDockRight: undocked wid=${windowId}`);
    }
    this.pushWebviewState();
  }

  private resizeWordForDocking(): void {
    const workArea = screen.getPrimaryDisplay().workArea;
    const wordWidth = Math.floor(workArea.width * 0.665);
    const wordLeft = workArea.x;
    const wordRight = workArea.x + wordWidth;
    const top = workArea.y;
    const bottom = workArea.y + workArea.height;

    execFile('osascript', [
      '-e', 'tell application "Microsoft Word"',
      '-e', 'if (count of windows) > 0 then',
      '-e', `set bounds of window 1 to {${wordLeft}, ${top}, ${wordRight}, ${bottom}}`,
      '-e', 'end if',
      '-e', 'end tell',
    ], (error) => {
      if (error) {
        logger.warn('[WindowMonitor] Failed to resize Word for docking:', error.message);
      }
      // Re-push state after Word has been resized so the overlay snaps into position
      setTimeout(() => this.pushWebviewState(), 300);
    });
  }

  /**
   * Single pending "kickoff" prompt. The next in-workspace pollData picks it
   * up — no document-path matching, no key collisions, no normalization
   * surprises. Set by desktop surfaces that want the overlay to start a
   * fresh chat with a prefilled message already sent.
   */
  private pendingKickoff: { prompt: string | null; kickoffId: string; createdMs: number } | null = null;

  setPendingKickoffForDocument(_documentPath: string, prompt: string): void {
    // Each call gets a fresh kickoffId so the popup creates a new chat even
    // when the prompt text is identical to a previous click.
    const kickoffId = randomUUID();
    this.pendingKickoff = { prompt, kickoffId, createdMs: Date.now() };
    logger.info(`[WindowMonitor] Stored pending kickoff ${kickoffId} (${prompt.length} chars)`);
    // Trigger a broadcast so any already-connected popup picks this up
    // immediately, instead of waiting for the next focus/doc change.
    wordPollEventBus.emit('change', 'webview-visibility-changed');
  }

  /**
   * Like setPendingKickoffForDocument but with no auto-sent prompt: the popup
   * opens a fresh empty chat. Used by surfaces that want to start a new
   * conversation in the overlay without dictating the first message (e.g.
   * Tools-page Peer Review Assistant tile after the user picks a manuscript).
   */
  requestNewOverlayChatForDocument(_documentPath: string): void {
    const kickoffId = randomUUID();
    this.pendingKickoff = { prompt: null, kickoffId, createdMs: Date.now() };
    logger.info(`[WindowMonitor] Stored pending new-chat request ${kickoffId}`);
    wordPollEventBus.emit('change', 'webview-visibility-changed');
  }

  consumePendingKickoffForDocument(_documentPath: string): { prompt: string | null; kickoffId: string } | null {
    // Note: NOT actually consumed server-side. The popup connects to the WS
    // *after* the kickoff is set, so a server-side consume would race the
    // initial broadcast and be lost. The popup tracks the last kickoffId it
    // acted on via a client-side ref and dedups itself. Cleared only by
    // TTL or by a subsequent setPendingKickoff overwriting it.
    if (!this.pendingKickoff) return null;
    const TTL_MS = 30 * 60_000;
    if (Date.now() - this.pendingKickoff.createdMs > TTL_MS) {
      this.pendingKickoff = null;
      return null;
    }
    return { prompt: this.pendingKickoff.prompt, kickoffId: this.pendingKickoff.kickoffId };
  }

  clearPendingKickoff(kickoffId: string): void {
    if (this.pendingKickoff && this.pendingKickoff.kickoffId === kickoffId) {
      this.pendingKickoff = null;
      logger.info(`[WindowMonitor] Cleared pending kickoff ${kickoffId}`);
    }
  }

  private pendingNavigateSession: { sessionId: string; nonce: string; createdMs: number } | null = null;

  setPendingNavigateSession(sessionId: string): void {
    const nonce = randomUUID();
    this.pendingNavigateSession = { sessionId, nonce, createdMs: Date.now() };
    logger.info(`[WindowMonitor] Stored pending navigate to session ${sessionId} (nonce=${nonce})`);
    wordPollEventBus.emit('change', 'webview-visibility-changed');
  }

  consumePendingNavigateSession(): { sessionId: string; nonce: string } | null {
    if (!this.pendingNavigateSession) return null;
    const TTL_MS = 30_000;
    if (Date.now() - this.pendingNavigateSession.createdMs > TTL_MS) {
      this.pendingNavigateSession = null;
      return null;
    }
    return { sessionId: this.pendingNavigateSession.sessionId, nonce: this.pendingNavigateSession.nonce };
  }

  clearPendingNavigateSession(nonce: string): void {
    if (this.pendingNavigateSession && this.pendingNavigateSession.nonce === nonce) {
      this.pendingNavigateSession = null;
    }
  }

  /**
   * Docks the overlay to the right of the window showing the given document.
   * If the window is already tracked, docks immediately. Otherwise registers
   * the path so docking happens the instant the window monitor detects it —
   * no polling delay.
   */
  setDockRightForDocument(documentPath: string, docked: boolean): void {
    const wid = this.getWindowIdForDocumentPath(documentPath);
    if (wid) {
      this.setDockRight(wid, docked);
      return;
    }
    if (docked) {
      this.pendingDockPaths.add(documentPath);
      logger.info(`[WindowMonitor] Scheduling auto-dock for path: ${documentPath}`);
    }
  }

  toggleDockRight(windowId: string): void {
    if (this.dockedRightWindows.has(windowId)) {
      this.dockedRightWindows.delete(windowId);
      logger.info(`[WindowMonitor] Undocked popup for window ${windowId}`);
    } else {
      this.dockedRightWindows.add(windowId);
      this.popupToggledOpen.add(windowId); // Ensure popup is visible when docking
      logger.info(`[WindowMonitor] Docked popup to right for window ${windowId}`);
    }
    this.pushWebviewState();
  }

  getReviewPanelV3SelectedText(windowId: string): string | null {
    return this.reviewPanelV3SelectedText.get(windowId) ?? this.lastSelectedText;
  }

  /**
   * Sets the user directories of the *active* workspace. A workspace may have
   * multiple user directories; documents within any of them are treated as
   * workspace files by the overlay.
   */
  setActiveWorkspaceDirectories(directories: string[]): void {
    this.workspaceDirectories = directories;
    this.refreshObsidianWorkspaceWatchers();
  }

  /**
   * Start (or restart) watchers on `.obsidian/workspace.json` for every
   * workspace directory that is an Obsidian vault.
   */
  private refreshObsidianWorkspaceWatchers(): void {
    for (const w of this.obsidianWorkspaceWatchers) w.close();
    this.obsidianWorkspaceWatchers = [];
    if (this.obsidianWorkspaceWatchDebounce) {
      clearTimeout(this.obsidianWorkspaceWatchDebounce);
      this.obsidianWorkspaceWatchDebounce = null;
    }
    for (const dir of this.workspaceDirectories) {
      const wsPath = path.join(dir, '.obsidian', 'workspace.json');
      if (!existsSync(wsPath)) continue;
      try {
        const watcher = watch(wsPath, () => {
          if (this.obsidianWorkspaceWatchDebounce) {
            clearTimeout(this.obsidianWorkspaceWatchDebounce);
          }
          this.obsidianWorkspaceWatchDebounce = setTimeout(() => {
            this.obsidianWorkspaceWatchDebounce = null;
            logger.info('[WindowMonitorService] Obsidian workspace.json changed — refreshing overlay state');
            this.pushWebviewState();
            wordPollEventBus.emit('change', 'obsidian-active-note-changed');
          }, 150);
        });
        this.obsidianWorkspaceWatchers.push(watcher);
        logger.info(`[WindowMonitorService] Watching Obsidian workspace.json at ${wsPath}`);
      } catch (err) {
        logger.warn(`[WindowMonitorService] Failed to watch ${wsPath}: ${(err as Error).message}`);
      }
    }
  }

  /** Returns the user directories of the active workspace (empty when no workspace is active). */
  getActiveWorkspaceDirectories(): string[] {
    return this.workspaceDirectories;
  }

  setSessionsProvider(provider: ((opts: { documentPath?: string; documentPathLike?: string }) => Array<{ id: string; title: string; created_at: string; is_running?: boolean }>) | null): void {
    this.sessionsProvider = provider;
  }

  getWorkspaceSessions(documentPath?: string): Array<{ id: string; title: string; created_at: string; is_running?: boolean }> {
    return this.sessionsProvider?.({ documentPath }) ?? [];
  }

  getWorkspaceSessionsByDocPathLike(documentPathLike: string): Array<{ id: string; title: string; created_at: string; is_running?: boolean }> {
    return this.sessionsProvider?.({ documentPathLike }) ?? [];
  }

  /**
   * Suppress selection events from being cached and broadcast to the popup.
   * Call with `true` before programmatic Word operations (find/replace, select_text)
   * and `false` after they complete, so tool-driven selections don't appear as user pills.
   */
  suppressSelectionEvents(suppress: boolean): void {
    this.selectionEventsSuppressed = suppress;
  }

  // ── Process supervision methods ──────────────────────────────────────

  private scheduleRespawn(processKey: string, respawnFn: () => void): void {
    const startTime = this.processStartTimes.get(processKey) ?? 0;
    const uptime = Date.now() - startTime;
    // Reset backoff if the process ran long enough (not a rapid crash)
    if (uptime > this.BACKOFF_RESET_MS) {
      this.respawnAttempts.set(processKey, 0);
    }
    const attempts = (this.respawnAttempts.get(processKey) ?? 0) + 1;
    this.respawnAttempts.set(processKey, attempts);

    if (attempts > this.MAX_RAPID_CRASHES) {
      logger.error(`[WindowMonitorService] ${processKey} crashed ${attempts} times rapidly — giving up respawn`);
      return;
    }

    const delay = Math.min(500 * Math.pow(2, attempts - 1), this.MAX_BACKOFF_MS);
    logger.info(`[WindowMonitorService] Scheduling ${processKey} respawn in ${delay}ms (attempt ${attempts}/${this.MAX_RAPID_CRASHES})`);

    const timer = setTimeout(() => {
      this.respawnTimers.delete(processKey);
      if (!this.stopped) {
        respawnFn();
      }
    }, delay);
    this.respawnTimers.set(processKey, timer);
  }

  private resetWatchdog(processKey: string): void {
    this.clearWatchdog(processKey);
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.watchdogTimers.delete(processKey);
      const proc = this.windowMonitorProcesses.get(processKey);
      if (proc && !this.stopped) {
        logger.warn(`[WindowMonitorService] window-monitor (${processKey}) watchdog timeout — killing for respawn`);
        proc.kill();
      }
    }, this.WATCHDOG_TIMEOUT_MS);
    this.watchdogTimers.set(processKey, timer);
  }

  private clearWatchdog(processKey: string): void {
    const existing = this.watchdogTimers.get(processKey);
    if (existing) {
      clearTimeout(existing);
      this.watchdogTimers.delete(processKey);
    }
  }

  private notifyProcessExit(): void {
    for (const resolve of this.processExitResolvers) {
      resolve();
    }
    this.processExitResolvers = [];
  }

  private waitForProcessExit(timeoutMs: number): Promise<void> {
    const hasRunning =
      this.webviewManagerProcess !== null ||
      this.windowMonitorProcesses.size > 0;
    if (!hasRunning) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.processExitResolvers.push(resolve);
      setTimeout(resolve, timeoutMs);
    });
  }

  stop(): void {
    this.stopped = true;
    // Cancel pending respawn timers
    for (const timer of this.respawnTimers.values()) clearTimeout(timer);
    this.respawnTimers.clear();
    this.respawnAttempts.clear();
    // Cancel watchdog timers
    for (const timer of this.watchdogTimers.values()) clearTimeout(timer);
    this.watchdogTimers.clear();

    for (const [key, proc] of this.windowMonitorProcesses) {
      logger.info(`[WindowMonitorService] Stopping window-monitor (${key})`);
      processCpuMonitor.unregister(`windowMonitor:${key}`);
      proc.kill();
    }
    this.windowMonitorProcesses.clear();
    this.windowMonitorProcessKeys.clear();
    if (this.webviewManagerProcess) {
      logger.info('[WindowMonitorService] Stopping webview-manager');
      processCpuMonitor.unregister('windowMonitor:webviewManager');
      this.webviewManagerProcess.kill();
      this.webviewManagerProcess = null;
    }
    this.state = createInitialState();
    this.popupToggledOpen.clear();
    this.popupHeightOverrides.clear();
    this.buttonDragOffsets.clear();
    this.popupSizeOverrides.clear();
    this.buttonV2WidthOverrides.clear();
    this.selectedTextReviewState.clear();
    this.reviewPanelV3Open.clear();
    this.reviewPanelV3SelectedText.clear();
    this.lastSelectedText = null;
    this.lastDesiredState = {};
    this.lastV4FocusedWindowId = null;
    this.documentTextContentCache.clear();
    this.selectedTextContentCache.clear();
    for (const timer of this.selectionClearTimers.values()) clearTimeout(timer);
    this.selectionClearTimers.clear();
    for (const timer of this.documentTextCacheCleanupTimers.values()) clearTimeout(timer);
    this.documentTextCacheCleanupTimers.clear();
    this.reviewInputOpen.clear();
    this.reviewErrorMessages.clear();
    this.pendingAutoOpenPaths.clear();
    this.pendingDockPaths.clear();
    this.lastAppleNotesPath = null;
    this.lastGoogleDocsPath = null;
    this.lastGoogleDocsTitle = null;
    this.lastGoogleDocsSelectedText = null;
    for (const w of this.obsidianWorkspaceWatchers) w.close();
    this.obsidianWorkspaceWatchers = [];
    if (this.obsidianWorkspaceWatchDebounce) {
      clearTimeout(this.obsidianWorkspaceWatchDebounce);
      this.obsidianWorkspaceWatchDebounce = null;
    }
  }

  async restart(): Promise<void> {
    logger.info('[WindowMonitorService] Restarting...');
    if (!this.baseUrl || !this.authToken) {
      logger.warn('[WindowMonitorService] Cannot restart: service was never started');
      return;
    }
    const baseUrl = this.baseUrl;
    const authToken = this.authToken;
    const allAppsEnabled = this.allAppsEnabled;
    this.stop();
    await this.waitForProcessExit(2000);
    this.start(baseUrl, authToken, allAppsEnabled);
    logger.info('[WindowMonitorService] Restart complete');
  }
}

export const windowMonitorService = new WindowMonitorService();
