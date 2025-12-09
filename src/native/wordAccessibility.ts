import * as path from 'path';
import { defaultLogger as logger } from '../utils/logger';

// Webpack provides __non_webpack_require__ to access Node's native require
declare const __non_webpack_require__: NodeRequire | undefined;

export interface SelectionEvent {
  type: 'selectionChanged';
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScrollEvent {
  type: 'scrollStarted' | 'scrollEnded';
}

export interface ButtonClickEvent {
  type: 'buttonClicked';
  text: string;
}

export type AccessibilityEvent = SelectionEvent | ScrollEvent | ButtonClickEvent;

export interface SelectedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageCornerVisibility {
  isVisible: boolean;
  inViewport: boolean;
  visibleRangeStart: number;
  visibleRangeLength: number;
}

export interface ParentElement {
  level: number;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ButtonState {
  x: number;
  y: number;
  width: number;
  height: number;
  isVisible: boolean;
}

export interface ButtonStates {
  academiaButton: ButtonState | null;
  countButton: ButtonState | null;
}

export interface FirstTextAreaInfo {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  charCount: number;
}

export interface BadgeState {
  count: number;
  isVisible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeModule {
  // Legacy single-observer API (deprecated - use multi-PID API instead)
  /** @deprecated Use startObservingPID instead */
  startObserving(pid: number, callback: (event: AccessibilityEvent) => void): boolean;
  /** @deprecated Use stopObservingPID or stopAllObserving instead */
  stopObserving(): void;

  // Multi-PID observer API (Phase 2)
  startObservingPID(pid: number, callback: (event: AccessibilityEvent) => void): boolean;
  stopObservingPID(pid: number): boolean;
  stopAllObserving(): void;
  setActivePID(pid: number): boolean;
  getActivePID(): number | null;
  getObservedPIDs(): number[];
  isObservingPID(pid: number): boolean;

  // Configuration
  setFeatureFlags(flags: { textSideButtonEnabled?: boolean; overallReviewButtonEnabled?: boolean; scrollTrackingEnabled?: boolean }): boolean;

  // Utility functions
  getSelectedText(): SelectedText | null;
  getFirstTextAreaInfo(): FirstTextAreaInfo | null;
  checkPermission(): boolean;
  requestPermission(): boolean;
  openAccessibilitySettings(): void;
  resetAndRequestPermission(): { resetSuccess: boolean; bundleId: string };
  getAppInfo(): { bundleId: string; executablePath: string; teamId: string };
  setLogFilePath(path: string): boolean;
  setPopupPath(path: string): boolean;
  setServerBaseUrl(url: string): boolean;
  setAuthToken(token: string): boolean;
  getDocumentTopLeftCorner(): Position | null;
  getWordWindowBounds(): Bounds | null;
  getFirstLinePosition(): Bounds | null;
  getPageCornerVisibility(): PageCornerVisibility | null;
  getParentHierarchy(): ParentElement[];
  getButtonStates(): ButtonStates | null;
  getScrollAreaBounds(): Bounds | null;
  // WAGENT-94: updateButtonBadge and getBadgeState removed - badges handled by new architecture
}

// Load the native module
let nativeModule: NativeModule | null = null;

// Use native Node.js require, not webpack's require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeRequire = typeof __non_webpack_require__ !== 'undefined' ? __non_webpack_require__ : require;

try {
  // Try multiple possible paths
  const possiblePaths = [
    // Webpack output: relative to main bundle (most likely in development)
    path.join(__dirname, 'native', 'build', 'Release', 'word_accessibility.node'),
    // Development: absolute from project root
    path.join(process.cwd(), 'src', 'native', 'build', 'Release', 'word_accessibility.node'),
    // Development: relative to source
    path.join(__dirname, 'build', 'Release', 'word_accessibility.node'),
    // Webpack output directory alternative
    path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'word_accessibility.node'),
    // Packaged app: from extraResources
    path.join(process.resourcesPath || '', 'word_accessibility.node'),
    // Packaged app: alternative path
    path.join(process.resourcesPath || '', 'native', 'build', 'Release', 'word_accessibility.node')
  ];

  for (const modulePath of possiblePaths) {
    try {
      const fs = nodeRequire('fs');
      const exists = fs.existsSync(modulePath);
      if (exists) {
        nativeModule = nodeRequire(modulePath) as NativeModule;
        logger.debug('[Native Module] Loaded from:', modulePath);
        break;
      }
    } catch (e) {
      // Try next path
      continue;
    }
  }

  if (!nativeModule) {
    throw new Error('Native module not found in any expected location');
  }

  // Set the popup HTML path for the native module
  try {
    const fs = nodeRequire('fs');
    const popupPaths = [
      // Development: dist/popup
      path.join(process.cwd(), 'dist', 'popup', 'index.html'),
      // Packaged: in resources
      path.join(process.resourcesPath || '', 'popup', 'index.html'),
    ];

    for (const popupPath of popupPaths) {
      if (fs.existsSync(popupPath)) {
        nativeModule.setPopupPath(popupPath);
        break;
      }
    }
  } catch (error) {
    logger.error('[Native Module] Failed to set popup path:', error);
  }
} catch (error) {
  logger.error('Failed to load native Word accessibility module:', error);
  logger.error('Make sure to build the native module first: npm run build:native');
}

export class WordAccessibilityBridge {
  // Legacy single-PID tracking (deprecated)
  private callback: ((event: AccessibilityEvent) => void) | null = null;
  private pid: number | null = null;

  // Multi-PID tracking
  private sharedCallback: ((event: AccessibilityEvent) => void) | null = null;

  checkPermission(): boolean {
    if (!nativeModule) {
      throw new Error('Native module not loaded');
    }
    return nativeModule.checkPermission();
  }

  requestPermission(): boolean {
    if (!nativeModule) {
      return false;
    }
    return nativeModule.requestPermission();
  }

  openAccessibilitySettings(): void {
    if (!nativeModule) {
      return;
    }
    nativeModule.openAccessibilitySettings();
  }

  resetAndRequestPermission(): { resetSuccess: boolean; bundleId: string } {
    if (!nativeModule) {
      return { resetSuccess: false, bundleId: '(native module not loaded)' };
    }
    return nativeModule.resetAndRequestPermission();
  }

  getAppInfo(): { bundleId: string; executablePath: string; teamId: string } {
    if (!nativeModule) {
      return { bundleId: '(native module not loaded)', executablePath: '(native module not loaded)', teamId: '(native module not loaded)' };
    }
    return nativeModule.getAppInfo();
  }

  setLogFilePath(logFilePath: string): boolean {
    if (!nativeModule) {
      logger.error('[WordAccessibility] Failed to set log file path: Native module not loaded');
      return false;
    }
    try {
      return nativeModule.setLogFilePath(logFilePath);
    } catch (error) {
      logger.error('[WordAccessibility] Failed to set log file path:', error);
      return false;
    }
  }

  // ============================================================================
  // Legacy Single-Observer API (deprecated)
  // ============================================================================

  /** @deprecated Use startObservingPID instead */
  startObserving(pid: number, callback: (event: AccessibilityEvent) => void): boolean {
    logger.warn('[WordAccessibility] WARNING: startObserving() is deprecated. Use startObservingPID() for multi-PID support.');

    if (!nativeModule) {
      throw new Error('Native module not loaded');
    }

    if (!this.checkPermission()) {
      throw new Error('Accessibility permission not granted. Please grant permission in System Settings.');
    }

    this.pid = pid;
    this.callback = callback;

    try {
      return nativeModule.startObserving(pid, callback);
    } catch (error) {
      logger.error('Failed to start observing:', error);
      throw error;
    }
  }

  /** @deprecated Use stopObservingPID or stopAllObserving instead */
  stopObserving(): void {
    logger.warn('[WordAccessibility] WARNING: stopObserving() is deprecated. Use stopObservingPID() or stopAllObserving() for multi-PID support.');

    if (!nativeModule) {
      return;
    }

    try {
      nativeModule.stopObserving();
      this.callback = null;
      this.pid = null;
    } catch (error) {
      logger.error('Failed to stop observing:', error);
    }
  }

  // ============================================================================
  // Multi-PID Observer API (Phase 2)
  // ============================================================================

  /**
   * Start observing a specific PID. Can observe multiple PIDs simultaneously.
   * @param pid The process ID to observe
   * @param callback Callback for accessibility events (shared across all PIDs)
   * @returns true if observation started successfully
   */
  startObservingPID(pid: number, callback: (event: AccessibilityEvent) => void): boolean {
    if (!nativeModule) {
      throw new Error('Native module not loaded');
    }

    if (!this.checkPermission()) {
      throw new Error('Accessibility permission not granted. Please grant permission in System Settings.');
    }

    // Store shared callback
    this.sharedCallback = callback;

    try {
      return nativeModule.startObservingPID(pid, callback);
    } catch (error) {
      logger.error(`Failed to start observing PID ${pid}:`, error);
      throw error;
    }
  }

  /**
   * Stop observing a specific PID.
   * @param pid The process ID to stop observing
   * @returns true if observation was stopped
   */
  stopObservingPID(pid: number): boolean {
    if (!nativeModule) {
      return false;
    }

    try {
      return nativeModule.stopObservingPID(pid);
    } catch (error) {
      logger.error(`Failed to stop observing PID ${pid}:`, error);
      return false;
    }
  }

  /**
   * Stop observing all PIDs and clean up resources.
   */
  stopAllObserving(): void {
    if (!nativeModule) {
      return;
    }

    try {
      nativeModule.stopAllObserving();
      this.sharedCallback = null;
    } catch (error) {
      logger.error('Failed to stop all observers:', error);
    }
  }

  /**
   * Set which PID's overlays should be visible.
   * @param pid The process ID to make active
   * @returns true if the PID was successfully set as active
   */
  setActivePID(pid: number): boolean {
    if (!nativeModule) {
      return false;
    }

    try {
      return nativeModule.setActivePID(pid);
    } catch (error) {
      logger.error(`Failed to set active PID ${pid}:`, error);
      return false;
    }
  }

  /**
   * Get the currently active PID (whose overlays are visible).
   * @returns The active PID or null if none
   */
  getActivePID(): number | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getActivePID();
    } catch (error) {
      logger.error('Failed to get active PID:', error);
      return null;
    }
  }

  /**
   * Get list of all PIDs currently being observed.
   * @returns Array of observed PIDs
   */
  getObservedPIDs(): number[] {
    if (!nativeModule) {
      return [];
    }

    try {
      return nativeModule.getObservedPIDs();
    } catch (error) {
      logger.error('Failed to get observed PIDs:', error);
      return [];
    }
  }

  /**
   * Check if a specific PID is currently being observed.
   * @param pid The process ID to check
   * @returns true if the PID is being observed
   */
  isObservingPID(pid: number): boolean {
    if (!nativeModule) {
      return false;
    }

    try {
      return nativeModule.isObservingPID(pid);
    } catch (error) {
      logger.error(`Failed to check if observing PID ${pid}:`, error);
      return false;
    }
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  /**
   * Set feature flags for native components.
   * Must be called BEFORE startObservingPID() since buttons are created during observer initialization.
   */
  setFeatureFlags(flags: { textSideButtonEnabled?: boolean; overallReviewButtonEnabled?: boolean; scrollTrackingEnabled?: boolean }): boolean {
    if (!nativeModule) {
      logger.error('Failed to set feature flags: Native module not loaded');
      return false;
    }

    try {
      return nativeModule.setFeatureFlags(flags);
    } catch (error) {
      logger.error('Failed to set feature flags:', error);
      return false;
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  getSelectedText(): SelectedText | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getSelectedText();
    } catch (error) {
      logger.error('Failed to get selected text:', error);
      return null;
    }
  }

  getFirstTextAreaInfo(): FirstTextAreaInfo | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getFirstTextAreaInfo();
    } catch (error) {
      logger.error('Failed to get first text area info:', error);
      return null;
    }
  }

  isObserving(): boolean {
    return this.pid !== null && this.callback !== null;
  }

  getDocumentTopLeftCorner(): Position | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getDocumentTopLeftCorner();
    } catch (error) {
      logger.error('Failed to get document top left corner:', error);
      return null;
    }
  }

  getWordWindowBounds(): Bounds | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getWordWindowBounds();
    } catch (error) {
      logger.error('Failed to get Word window bounds:', error);
      return null;
    }
  }

  getFirstLinePosition(): Bounds | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getFirstLinePosition();
    } catch (error) {
      logger.error('Failed to get first line position:', error);
      return null;
    }
  }

  getPageCornerVisibility(): PageCornerVisibility | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getPageCornerVisibility();
    } catch (error) {
      logger.error('Failed to get page corner visibility:', error);
      return null;
    }
  }

  getParentHierarchy(): ParentElement[] {
    if (!nativeModule) {
      return [];
    }

    try {
      const result = nativeModule.getParentHierarchy();
      return result || [];  // Convert null to empty array
    } catch (error) {
      logger.error('Failed to get parent hierarchy:', error);
      return [];
    }
  }

  getButtonStates(): ButtonStates | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getButtonStates();
    } catch (error) {
      logger.error('Failed to get button states:', error);
      return null;
    }
  }

  getScrollAreaBounds(): Bounds | null {
    if (!nativeModule) {
      return null;
    }

    try {
      return nativeModule.getScrollAreaBounds();
    } catch (error) {
      logger.error('Failed to get scroll area bounds:', error);
      return null;
    }
  }

  setServerBaseUrl(url: string): boolean {
    if (!nativeModule) {
      logger.error('Failed to set server base URL: Native module not loaded');
      return false;
    }

    try {
      return nativeModule.setServerBaseUrl(url);
    } catch (error) {
      logger.error('Failed to set server base URL:', error);
      return false;
    }
  }

  setAuthToken(token: string): boolean {
    if (!nativeModule) {
      logger.error('Failed to set auth token: Native module not loaded');
      return false;
    }

    try {
      return nativeModule.setAuthToken(token);
    } catch (error) {
      logger.error('Failed to set auth token:', error);
      return false;
    }
  }

  // WAGENT-94: updateButtonBadge and getBadgeState methods removed
  // Badge management now handled by new architecture (AcademiaManager)
}

// Export singleton instance
export const wordAccessibility = new WordAccessibilityBridge();
