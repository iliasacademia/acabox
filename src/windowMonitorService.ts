import { ChildProcess, execFile, spawn } from 'child_process';
import { app, screen } from 'electron';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { defaultLogger as logger } from './utils/logger';
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
  DesiredWebviewState,
  WebviewTypeConfig,
} from './windowMonitor/computeWebviewState';
import { remoteFeatureFlags, REMOTE_FLAGS } from './remoteFeatureFlags';
import { logToWindowMonitorDb } from './windowMonitorDb';

const BUTTON_WIDTH = 330;
const BUTTON_HEIGHT = 50;
const BUTTON_LEFT_MARGIN = 50;
const BUTTON_BOTTOM_MARGIN = 30;

const POPUP_WIDTH = 370;
const POPUP_HEIGHT = 400;
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
  const configs: WebviewTypeConfig[] = [
    {
      keyPrefix: 'button-v2',
      pathSuffix: '/ui/popup/academiaNotificationsButtonV2/',
      forApp: 'com.microsoft.Word',
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
      forApp: 'com.microsoft.Word',
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
        if (service.getWorkspaceDirectory()) return null;

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
  private windowMonitorProcess: ChildProcess | null = null;
  private webviewManagerProcess: ChildProcess | null = null;
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
  // Cobuilding workspace directory — when set, documents within this directory
  // are treated as workspace files and the overlay shows workspace sessions.
  private workspaceDirectory: string | null = null;
  private sessionsProvider: (() => Array<{ id: string; title: string; created_at: string }>) | null = null;
  // When true, WINDOW_TEXT_SELECTED events are ignored (used to suppress
  // programmatic selections from MCP tools like find_and_replace/select_text).
  private selectionEventsSuppressed = false;

  start(baseUrl: string, authToken: string, allAppsEnabled: boolean = false): void {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
    this.allAppsEnabled = allAppsEnabled;
    const wmBin = getWindowMonitorBinPath();
    const wvBin = getWebviewManagerBinPath();

    logger.info('[WindowMonitorService] Starting window-monitor:', wmBin);
    logger.info('[WindowMonitorService] Starting webview-manager:', wvBin);

    // Spawn window-monitor
    const wmArgs = allAppsEnabled
      ? ['--track-text-selection', '--track-document-text']
      : ['--bundle-id', 'com.microsoft.Word', '--track-text-selection', '--track-document-text', '--content-area-role', 'AXSplitGroup'];
    logger.info('[WindowMonitorService] Spawn args:', wmArgs);
    this.windowMonitorProcess = spawn(wmBin, wmArgs, {
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
      for (const [wid, docPath] of newMap) {
        if (oldMap.get(wid) !== docPath) {
          documentPathMappingChanged = true;
          // Auto-open popup if this window's document was scheduled for auto-open
          if (docPath && this.pendingAutoOpenPaths.size > 0) {
            const normalizedDocPath = docPath.startsWith('file://')
              ? decodeURIComponent(docPath.slice(7))
              : docPath;
            if (this.pendingAutoOpenPaths.has(normalizedDocPath)) {
              this.pendingAutoOpenPaths.delete(normalizedDocPath);
              logger.info(`[WindowMonitor] Auto-opening popup for new window ${wid} (path match)`);
              this.popupToggledOpen.add(wid);
            }
          }
        }
      }
      this.state = newState;
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

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().bounds;
    const desiredState = computeWebviewStateV4(this.state, getWebviewConfigs(this), this.baseUrl, this.authToken, screenHeight);

    const focused = getFocusedWindowInfo(this.state);
    let windowId = focused?.window.id ?? null;

    // In cobuilding mode, keep the overlay visible when Word loses focus
    // by reusing the last desired state. The overlay drops to normal window level
    // (background: true) so it sits behind the active app's windows.
    if (this.workspaceDirectory && !windowId && this.lastV4FocusedWindowId) {
      const hasOverlay = Object.keys(desiredState).length > 0;
      if (!hasOverlay && Object.keys(this.lastDesiredState).length > 0) {
        windowId = this.lastV4FocusedWindowId;
        for (const [key, value] of Object.entries(this.lastDesiredState)) {
          desiredState[key] = { ...value, background: true };
        }
      }
    }

    // Apply per-window overrides using global keys
    if (desiredState['popup-v2'] && windowId) {
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

    if (desiredState['review-panel-v3'] && windowId) {
      const isPanelOpen = this.reviewPanelV3Open.has(windowId);
      desiredState['review-panel-v3'].visible = isPanelOpen;
    }

    if (desiredState['button-v2'] && windowId) {
      const buttonWidthOverride = this.buttonV2WidthOverrides.get(windowId);
      if (buttonWidthOverride !== undefined) {
        desiredState['button-v2'].frame.width = buttonWidthOverride;
      } else if (!this.workspaceDirectory) {
        // Only shrink to ENABLE_FEEDBACK_BUTTON_WIDTH in writing agent mode
        const docPath = this.getDocumentPathForWindow(windowId);
        if (!docPath || !wordIntegrationDataStoreV2.getProjectFileForPath(docPath)) {
          desiredState['button-v2'].frame.width = ENABLE_FEEDBACK_BUTTON_WIDTH;
        }
      }
      // Widen for "Review Selection" when text is selected (not in cobuilding mode)
      if (!this.workspaceDirectory) {
        const selectedText = this.getSelectedTextForWindow(windowId);
        if (selectedText && selectedText.length > 0) {
          desiredState['button-v2'].frame.width = Math.max(desiredState['button-v2'].frame.width, BUTTON_WITH_REVIEW_WIDTH);
        }
      }
    }

    // Apply drag offset for the focused window
    if (windowId && this.buttonDragOffsets.has(windowId) && desiredState['button-v2']) {
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
    if (windowId && this.dockedRightWindows.has(windowId) && desiredState['popup-v2']) {
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

    if (this.webviewManagerProcess?.stdin?.writable) {
      this.webviewManagerProcess.stdin.write(JSON.stringify(desiredState) + '\n');
    } else {
      logger.info('[WindowMonitorService] Cannot send state to webview-manager: stdin not writable');
    }
  }

  /**
   * Get the currently focused window ID, or null if no window is focused.
   */
  getFocusedWindowId(): string | null {
    const focused = getFocusedWindowInfo(this.state);
    return focused?.window.id ?? null;
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
          if (window.documentPath?.startsWith('file://')) {
            return decodeURIComponent(window.documentPath.slice(7));
          }
          return window.documentPath;
        }
      }
    }
    return null;
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

  setWorkspaceDirectory(directory: string | null): void {
    this.workspaceDirectory = directory;
  }

  getWorkspaceDirectory(): string | null {
    return this.workspaceDirectory;
  }

  setSessionsProvider(provider: (() => Array<{ id: string; title: string; created_at: string }>) | null): void {
    this.sessionsProvider = provider;
  }

  getWorkspaceSessions(): Array<{ id: string; title: string; created_at: string }> {
    return this.sessionsProvider?.() ?? [];
  }

  /**
   * Suppress selection events from being cached and broadcast to the popup.
   * Call with `true` before programmatic Word operations (find/replace, select_text)
   * and `false` after they complete, so tool-driven selections don't appear as user pills.
   */
  suppressSelectionEvents(suppress: boolean): void {
    this.selectionEventsSuppressed = suppress;
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
  }

  restart(): void {
    logger.info('[WindowMonitorService] Restarting...');
    if (!this.baseUrl || !this.authToken) {
      logger.warn('[WindowMonitorService] Cannot restart: service was never started');
      return;
    }
    const baseUrl = this.baseUrl;
    const authToken = this.authToken;
    const allAppsEnabled = this.allAppsEnabled;
    this.stop();
    setTimeout(() => {
      this.start(baseUrl, authToken, allAppsEnabled);
      logger.info('[WindowMonitorService] Restart complete');
    }, 3000);
  }
}

export const windowMonitorService = new WindowMonitorService();
