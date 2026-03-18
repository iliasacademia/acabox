import { ChildProcess, spawn } from 'child_process';
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
  computeWebviewState,
  DesiredWebviewState,
  WebviewTypeConfig,
} from './windowMonitor/computeWebviewState';
import { remoteFeatureFlags, REMOTE_FLAGS } from './remoteFeatureFlags';

const BUTTON_WIDTH = 210;
const BUTTON_HEIGHT = 50;
const BUTTON_LEFT_MARGIN = 50;
const BUTTON_BOTTOM_MARGIN = 30;

const POPUP_WIDTH = 370;
const POPUP_HEIGHT = 400;
const POPUP_GAP_ABOVE_BUTTON = 10;

const REVIEW_STATUS_OVERLAY_HEIGHT = 250;
const REVIEW_STATUS_OVERLAY_GAP = 4;

const REVIEW_BUTTON_WIDTH = 120;
const REVIEW_BUTTON_HEIGHT = 46;
const REVIEW_BUTTON_GAP = 10;

const REVIEWING_BUTTON_V2_WIDTH = 320;
const ENABLE_FEEDBACK_BUTTON_WIDTH = 220;

const DEBUG_CONTENT_BOUNDS_OVERLAY = process.env.DEBUG_CONTENT_BOUNDS_OVERLAY === '1';
const DEBUG_SELECTION_BOUNDS_OVERLAY = process.env.DEBUG_SELECTION_BOUNDS_OVERLAY === '1';

function getWebviewConfigs(service: WindowMonitorService): WebviewTypeConfig[] {
  const configs: WebviewTypeConfig[] = [
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
      keyPrefix: 'review-status-overlay',
      pathSuffix: '/ui/popup/reviewStatusOverlay/',
      computeFrame: (bounds: WindowBounds, screenHeight: number, _contentBounds, _selectionBounds, windowId?: string) => {
        // Don't show if popup is open (they overlap)
        if (windowId && service['popupToggledOpen'].has(windowId)) {
          return null;
        }

        // Only show if there's an active review for this window
        if (!windowId || !service['selectedTextReviewState'].has(windowId)) {
          return null;
        }

        const cocoaBottomOfWindow = screenHeight - (bounds.y + bounds.height);
        const buttonTopEdge = cocoaBottomOfWindow + BUTTON_BOTTOM_MARGIN + BUTTON_HEIGHT;

        return {
          x: bounds.x + BUTTON_LEFT_MARGIN,
          y: buttonTopEdge + REVIEW_STATUS_OVERLAY_GAP,
          width: POPUP_WIDTH,
          height: REVIEW_STATUS_OVERLAY_HEIGHT,
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
    {
      keyPrefix: 'review-button',
      pathSuffix: '/ui/popup/reviewButton/',
      computeFrame: (_bounds: WindowBounds, screenHeight: number, _contentBounds, selectionBounds, windowId?: string) => {
        if (!_contentBounds) return null;

        // Use cached selection bounds if there's an active review and current selection is null
        let effectiveBounds = selectionBounds;
        if (!effectiveBounds && windowId && service['selectedTextReviewState'].has(windowId)) {
          effectiveBounds = service['lastSelectionBounds'].get(windowId) || null;
        }

        if (!effectiveBounds) return null;

        // Clamp selection bounds to visible content area so button appears
        // next to the visible portion of the selection, not off-screen.
        const visibleX = Math.max(effectiveBounds.x, _contentBounds.x);
        const visibleY = Math.max(effectiveBounds.y, _contentBounds.y);
        const visibleRight = Math.min(
          effectiveBounds.x + effectiveBounds.width,
          _contentBounds.x + _contentBounds.width
        );
        const visibleBottom = Math.min(
          effectiveBounds.y + effectiveBounds.height,
          _contentBounds.y + _contentBounds.height
        );
        const visibleWidth = visibleRight - visibleX;
        const visibleHeight = visibleBottom - visibleY;

        if (visibleWidth <= 0 || visibleHeight <= 0) return null;

        // Right of selection with gap, bottom-aligned
        const x = visibleRight + REVIEW_BUTTON_GAP;
        const cocoaY = screenHeight - visibleBottom;

        // Clamp to window bounds
        const cocoaWindowBottom = screenHeight - (_bounds.y + _bounds.height);
        const cocoaWindowTop = cocoaWindowBottom + _bounds.height;
        const clampedX = Math.max(_bounds.x, Math.min(x, _bounds.x + _bounds.width - REVIEW_BUTTON_WIDTH));
        const clampedY = Math.max(cocoaWindowBottom, Math.min(cocoaY, cocoaWindowTop - REVIEW_BUTTON_HEIGHT));

        // Hide if button falls outside content bounds
        if (_contentBounds) {
          const contentLeft = _contentBounds.x;
          const contentRight = _contentBounds.x + _contentBounds.width;
          const contentBottom = screenHeight - (_contentBounds.y + _contentBounds.height);
          const contentTop = contentBottom + _contentBounds.height;

          if (
            clampedX < contentLeft ||
            clampedX + REVIEW_BUTTON_WIDTH > contentRight ||
            clampedY < contentBottom ||
            clampedY + REVIEW_BUTTON_HEIGHT > contentTop
          ) {
            return null;
          }
        }

        return { x: clampedX, y: clampedY, width: REVIEW_BUTTON_WIDTH, height: REVIEW_BUTTON_HEIGHT };
      },
    },
  ];

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
  private lastSelectionBounds = new Map<string, WindowBounds>();
  private documentTextContentCache = new Map<string, string>();
  private selectedTextContentCache = new Map<string, string>();
  private selectionClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private documentTextCacheCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reviewErrorMessages = new Map<string, string>();
  private lastDesiredState: DesiredWebviewState = {};
  private baseUrl: string | null = null;
  private authToken: string | null = null;
  // File paths for which the popup should auto-open when the window is first detected
  private pendingAutoOpenPaths: Set<string> = new Set();

  start(baseUrl: string, authToken: string): void {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
    const wmBin = getWindowMonitorBinPath();
    const wvBin = getWebviewManagerBinPath();

    logger.info('[WindowMonitorService] Starting window-monitor:', wmBin);
    logger.info('[WindowMonitorService] Starting webview-manager:', wvBin);

    // Spawn window-monitor
    this.windowMonitorProcess = spawn(wmBin, ['--bundle-id', 'com.microsoft.Word', '--track-text-selection', '--track-document-text', '--content-area-role', 'AXSplitGroup'], {
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

      if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
        logger.info('[VERBOSE] [WindowMonitorService] Event:', event);
      }

      // Debounce WINDOW_TEXT_SELECTION_CLEARED: delay processing by 1s so the
      // review button stays visible long enough for a click to register.
      if (event.event === 'WINDOW_TEXT_SELECTION_CLEARED' && event.window) {
        const windowId = event.window.id;
        // Cancel any existing debounce timer for this window
        const existingTimer = this.selectionClearTimers.get(windowId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          this.selectionClearTimers.delete(windowId);
          // Now apply the deferred clear
          const deferredState = reduceWindowMonitorEvent(this.state, event);
          this.state = deferredState;
          if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
            logger.info('[VERBOSE] [WindowMonitorService] State:', deferredState);
          }
          if (!this.selectedTextReviewState.has(windowId)) {
            this.lastSelectionBounds.delete(windowId);
          }
          this.pushWebviewState();
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

      // Track activity sessions
      if (FEATURES.SESSION_CAPTURE_ENABLED) {
        sessionsTracker.processEvent(event);
      }

      // Cache selection bounds when text is selected (only for real selections, not cursor positions)
      if (event.event === 'WINDOW_TEXT_SELECTED' && event.window && event.selection.bounds) {
        if (event.selection.length > 0) {
          this.lastSelectionBounds.set(event.window.id, event.selection.bounds);
          // Cancel any pending selection-clear debounce (new selection supersedes it)
          const pendingTimer = this.selectionClearTimers.get(event.window.id);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.selectionClearTimers.delete(event.window.id);
          }
        }
      }

      // Cache selected text content in memory when it changes (same pattern as documentTextContentCache).
      if (event.event === 'WINDOW_TEXT_SELECTED' && event.window && event.selection.length > 0) {
        try {
          const content = readFileSync(event.selection.filePath, 'utf-8');
          if (content.length > 0) {
            this.selectedTextContentCache.set(event.window.id, content);
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
        this.popupHeightOverrides.delete(event.window.id);
        this.buttonDragOffsets.delete(event.window.id);
        this.popupSizeOverrides.delete(event.window.id);
        this.buttonV2WidthOverrides.delete(event.window.id);
        this.selectedTextReviewState.delete(event.window.id);
        this.lastSelectionBounds.delete(event.window.id);
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

    const screenHeight = screen.getPrimaryDisplay().bounds.height;
    const desiredState = computeWebviewState(this.state, getWebviewConfigs(this), this.baseUrl, this.authToken, screenHeight);

    // Auto-close popups when Word loses focus
    const wordApp = this.state.apps.find(app => app.identifier === 'com.microsoft.Word');
    const wordIsFocused = wordApp?.isFocused ?? false;

    for (const key of Object.keys(desiredState)) {
      if (key.startsWith('popup-v2-')) {
        const windowId = key.slice('popup-v2-'.length);
        const isToggledOpen = this.popupToggledOpen.has(windowId);

        // Auto-close popup if Word loses focus
        if (isToggledOpen && !wordIsFocused) {
          this.popupToggledOpen.delete(windowId);
          desiredState[key].visible = false;
          logger.info(`[WindowMonitor] Popup ${key}: auto-closed (Word unfocused)`);
        } else {
          // If toggled open and Word is focused, show. Otherwise hide.
          desiredState[key].visible = isToggledOpen;
          if (isToggledOpen) {
            logger.info(`[WindowMonitor] Popup ${key}: showing (toggled=true, wordFocused=${wordIsFocused})`);
          }
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
      if (key.startsWith('button-v2-')) {
        const windowId = key.slice('button-v2-'.length);
        const buttonWidthOverride = this.buttonV2WidthOverrides.get(windowId);
        if (buttonWidthOverride !== undefined) {
          desiredState[key].frame.width = buttonWidthOverride;
        } else {
          // Widen for "Enable feedback" if document is unsaved or has no project
          const docPath = this.getDocumentPathForWindow(windowId);
          if (!docPath || !wordIntegrationDataStoreV2.getProjectFileForPath(docPath)) {
            desiredState[key].frame.width = ENABLE_FEEDBACK_BUTTON_WIDTH;
          }
        }
      }
    }

    // Apply drag offsets to button, popup, and review status overlay frames, clamped to window bounds
    for (const [windowId, offset] of this.buttonDragOffsets) {
      const buttonKey = `button-v2-${windowId}`;
      const popupKey = `popup-v2-${windowId}`;
      const reviewStatusKey = `review-status-overlay-${windowId}`;
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

        if (desiredState[reviewStatusKey]) {
          desiredState[reviewStatusKey].frame.x += clampedDx;
          desiredState[reviewStatusKey].frame.y += clampedDy;
        }
      } else {
        // No bounds info, apply offset without clamping
        desiredState[buttonKey].frame.x += offset.dx;
        desiredState[buttonKey].frame.y += offset.dy;
        if (desiredState[popupKey]) {
          desiredState[popupKey].frame.x += offset.dx;
          desiredState[popupKey].frame.y += offset.dy;
        }
        if (desiredState[reviewStatusKey]) {
          desiredState[reviewStatusKey].frame.x += offset.dx;
          desiredState[reviewStatusKey].frame.y += offset.dy;
        }
      }
    }

    if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
      logger.info('[VERBOSE] [WindowMonitorService] Desired state:', desiredState);
    }

    // Diff visibility for button-v2 and popup-v2 entries; emit if any changed
    let visibilityChanged = false;
    for (const key of Object.keys(desiredState)) {
      if (key.startsWith('button-v2-') || key.startsWith('popup-v2-') || key.startsWith('review-button-') || key.startsWith('review-status-overlay-')) {
        const newVisible = desiredState[key]?.visible ?? false;
        const oldVisible = this.lastDesiredState[key]?.visible ?? false;
        if (newVisible !== oldVisible) {
          visibilityChanged = true;
          break;
        }
      }
    }
    // Also check keys that disappeared (window destroyed)
    if (!visibilityChanged) {
      for (const key of Object.keys(this.lastDesiredState)) {
        if ((key.startsWith('button-v2-') || key.startsWith('popup-v2-') || key.startsWith('review-button-') || key.startsWith('review-status-overlay-')) && !desiredState[key]) {
          if (this.lastDesiredState[key]?.visible) {
            visibilityChanged = true;
            break;
          }
        }
      }
    }
    this.lastDesiredState = desiredState;
    if (visibilityChanged) {
      wordPollEventBus.emit('change', 'webview-visibility-changed');
    }

    if (this.webviewManagerProcess?.stdin?.writable) {
      this.webviewManagerProcess.stdin.write(JSON.stringify(desiredState) + '\n');
    } else {
      logger.info('[WindowMonitorService] Cannot send state to webview-manager: stdin not writable');
    }
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
    this.lastSelectionBounds.delete(windowId);
    // Note: pushWebviewState() is NOT called here — caller handles native update
    // timing to avoid disrupting WebSocket delivery of the state change.
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
    if (this.popupToggledOpen.delete(windowId)) {
      this.popupHeightOverrides.delete(windowId);
      this.popupSizeOverrides.delete(windowId);
      if (clearReviewState) {
        this.clearSelectedTextReviewState(windowId);
      }
      this.reviewErrorMessages.delete(windowId);
      this.pushWebviewState();
    } else {
      logger.info(`[WindowMonitor] Popup for window ${windowId} was not open`);
    }
  }

  getDesiredWebviewVisibility(keyPrefix: string, windowId: string): boolean {
    return this.lastDesiredState[`${keyPrefix}-${windowId}`]?.visible ?? false;
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
    this.lastDesiredState = {};
    this.documentTextContentCache.clear();
    this.selectedTextContentCache.clear();
    for (const timer of this.selectionClearTimers.values()) clearTimeout(timer);
    this.selectionClearTimers.clear();
    for (const timer of this.documentTextCacheCleanupTimers.values()) clearTimeout(timer);
    this.documentTextCacheCleanupTimers.clear();
  }
}

export const windowMonitorService = new WindowMonitorService();
