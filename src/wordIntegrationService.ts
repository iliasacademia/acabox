import { execSync } from 'child_process';
import { screen } from 'electron';
import { wordAccessibility, AccessibilityEvent } from './native/wordAccessibility';
import { FEATURES } from './shared/types';
import { wordIntegrationDataStore } from './wordIntegrationDataStore';
import { defaultLogger as logger } from './utils/logger';

/**
 * Represents a tracked Word process with its manuscript file.
 */
interface TrackedPID {
  pid: number;
  filePath: string;
  isActive: boolean;
}

/**
 * WordIntegrationService handles all MS Word integration functionality:
 * - Auto-detection of Word processes (supports multiple PIDs)
 * - Accessibility observer management
 * - Position/debug info retrieval
 *
 * Phase 2: Multi-PID support - tracks all Word processes with manuscripts,
 * but only shows overlays on the active/focused Word window.
 */
class WordIntegrationService {
  private wordCheckInterval: NodeJS.Timeout | null = null;
  private serverBaseUrl: string | null = null;
  private manuscriptPaths: string[] = [];

  // Multi-PID tracking (Phase 2)
  private trackedPIDs: Map<number, TrackedPID> = new Map();
  private activePID: number | null = null;
  private readonly MAX_PIDS = 3;  // Prioritizes first-opened PIDs

  // Navigation handler callback (set by main.ts)
  private navigationHandler: ((payload: { page: string; projectId: number; conversationId: number }) => void) | null = null;

  /**
   * Initialize Word integration.
   * - Sets feature flags for native components
   * - Sets server base URL for native popups
   * - Tracking starts when setManuscriptPaths() is called
   */
  initialize(serverBaseUrl?: string): void {
    // Set server base URL for native popups
    if (serverBaseUrl) {
      this.setServerBaseUrl(serverBaseUrl);
    }

    if (!FEATURES.MS_WORD_INTEGRATION_ENABLED) {
      return;
    }

    // Set native feature flags BEFORE any PID observation starts
    // (buttons are created during observer initialization)
    wordAccessibility.setFeatureFlags({
      textSideButtonEnabled: FEATURES.TEXT_SIDE_BUTTON_ENABLED,
      overallReviewButtonEnabled: FEATURES.OVERALL_REVIEW_BUTTON_ENABLED,
      scrollTrackingEnabled: FEATURES.SCROLL_TRACKING_ENABLED,
    });
  }

  /**
   * Set the HTTP server base URL for native popups
   */
  setServerBaseUrl(url: string): boolean {
    this.serverBaseUrl = url;
    const success = wordAccessibility.setServerBaseUrl(url);
    if (!success) {
      logger.error('[WORD-INTEGRATION] Failed to set server URL for native popups');
    }
    return success;
  }

  /**
   * Set the navigation handler callback for popup-to-main-window navigation.
   * Called by main.ts to provide navigation functionality.
   */
  setNavigationHandler(handler: (payload: { page: string; projectId: number; conversationId: number }) => void): void {
    this.navigationHandler = handler;
  }

  /**
   * Find all Word PIDs that have any of the specified files open using lsof.
   * Returns array of {pid, filePath} pairs.
   */
  private findWordPIDsWithFiles(filePaths: string[]): Array<{pid: number, filePath: string}> {
    if (filePaths.length === 0) return [];

    const matches: Array<{pid: number, filePath: string}> = [];

    try {
      const pidsResult = execSync("pgrep 'Microsoft Word'", { encoding: 'utf8' }).trim();
      if (!pidsResult) {
        return [];
      }

      const pids = pidsResult.split('\n').map(p => parseInt(p.trim())).filter(p => !isNaN(p));

      for (const pid of pids) {
        try {
          const lsofResult = execSync(`lsof -p ${pid} 2>/dev/null`, { encoding: 'utf8' });

          for (const filePath of filePaths) {
            if (lsofResult.includes(filePath)) {
              matches.push({ pid, filePath });
              break; // One match per PID is enough
            }
          }
        } catch {
          // Could not check PID
        }
      }

    } catch {
      // pgrep failed - Word not running
    }

    return matches;
  }

  /**
   * Set or update the manuscript paths and start tracking.
   * Phase 2: Tracks ALL matching PIDs, shows overlays only on active/focused Word.
   */
  setManuscriptPaths(filePaths: string[]): void {
    this.manuscriptPaths = filePaths;

    if (filePaths.length === 0) {
      this.stopAllTracking();
      return;
    }

    // Find and track all matching PIDs
    this.checkAndTrackManuscripts();

    // Start polling if not already running
    this.startPollingIfNeeded();
  }

  /**
   * Stop tracking all PIDs and clean up.
   */
  private stopAllTracking(): void {
    if (this.trackedPIDs.size > 0) {
      wordAccessibility.stopAllObserving();
      this.trackedPIDs.clear();
      wordIntegrationDataStore.clearTrackedPIDs();
      this.activePID = null;
    }
  }

  /**
   * Check for manuscripts and track ALL matching PIDs.
   * Phase 2: Manages adding new PIDs and removing stale ones.
   */
  private checkAndTrackManuscripts(): void {
    const matches = this.findWordPIDsWithFiles(this.manuscriptPaths);

    // Get current and new PID sets
    const currentPIDs = new Set(this.trackedPIDs.keys());
    const newPIDs = new Set(matches.map(m => m.pid));

    // Add new PIDs (in matches but not currently tracked)
    // Note: First-opened PIDs are prioritized - we won't replace them with newer ones
    for (const { pid, filePath } of matches) {
      if (!this.trackedPIDs.has(pid)) {
        if (this.trackedPIDs.size >= this.MAX_PIDS) {
          continue;
        }
        this.startTrackingPID(pid, filePath);
      }
    }

    // Remove stale PIDs (tracked but no longer in matches)
    for (const pid of currentPIDs) {
      if (!newPIDs.has(pid)) {
        this.stopTrackingPID(pid);
      }
    }
  }

  /**
   * Start tracking a specific PID.
   */
  private startTrackingPID(pid: number, filePath: string): void {
    if (!FEATURES.MS_WORD_INTEGRATION_ENABLED) {
      return;
    }

    if (!wordAccessibility.checkPermission()) {
      return;
    }

    if (this.trackedPIDs.has(pid)) {
      return;
    }

    const success = wordAccessibility.startObservingPID(pid, (event: AccessibilityEvent) => {
      // Handle navigation requests from popup (format: "navigateToPage|{json}")
      if (event.type === 'buttonClicked' && event.text?.startsWith('navigateToPage|')) {
        try {
          const jsonPayload = event.text.substring('navigateToPage|'.length);
          const payload = JSON.parse(jsonPayload);

          if (this.navigationHandler) {
            this.navigationHandler(payload);
          } else {
            logger.warn('[WORD-INTEGRATION] Navigation handler not set');
          }
        } catch (err) {
          logger.error('[WORD-INTEGRATION] Error parsing navigateToPage payload:', err);
        }
      }
    });

    if (success) {
      const isActive = this.trackedPIDs.size === 0; // First PID is active by default
      const trackedInfo = { pid, filePath, isActive };
      this.trackedPIDs.set(pid, trackedInfo);
      wordIntegrationDataStore.setTrackedPID(pid, trackedInfo);

      if (isActive) {
        this.activePID = pid;
      }
    } else {
      logger.error(`[WORD-INTEGRATION] Failed to start tracking PID ${pid}`);
    }
  }

  /**
   * Stop tracking a specific PID.
   */
  private stopTrackingPID(pid: number): void {
    if (!this.trackedPIDs.has(pid)) {
      return;
    }

    wordAccessibility.stopObservingPID(pid);
    this.trackedPIDs.delete(pid);
    wordIntegrationDataStore.deleteTrackedPID(pid);

    // If we removed the active PID, activate the next available one
    if (this.activePID === pid) {
      this.activePID = null;
      const nextPID = this.trackedPIDs.keys().next().value;
      if (nextPID !== undefined) {
        this.activePID = nextPID;
        wordAccessibility.setActivePID(nextPID);
        const tracked = this.trackedPIDs.get(nextPID);
        if (tracked) {
          tracked.isActive = true;
        }
      }
    }
  }

  /**
   * Start the polling interval if not already running.
   */
  private startPollingIfNeeded(): void {
    if (this.wordCheckInterval) return;

    this.wordCheckInterval = setInterval(() => {
      if (this.manuscriptPaths.length === 0) return;

      // Check and sync tracked PIDs (adds new, removes stale)
      this.checkAndTrackManuscripts();
    }, 5000);
  }

  /**
   * Clean up all Word integration resources
   */
  cleanup(): void {
    // Stop Word check interval
    if (this.wordCheckInterval) {
      clearInterval(this.wordCheckInterval);
      this.wordCheckInterval = null;
    }

    // Stop all observers
    if (this.trackedPIDs.size > 0) {
      try {
        wordAccessibility.stopAllObserving();
        this.trackedPIDs.clear();
        wordIntegrationDataStore.clearTrackedPIDs();
        this.activePID = null;
      } catch (error) {
        logger.error('[WORD-INTEGRATION] Error stopping observers:', error);
      }
    }
  }

  /**
   * Check if Word tracking is currently active (any PIDs being tracked)
   */
  isActive(): boolean {
    return this.trackedPIDs.size > 0;
  }

  /**
   * Get the number of PIDs currently being tracked
   */
  getTrackedPIDCount(): number {
    return this.trackedPIDs.size;
  }

  /**
   * Get the currently active PID
   */
  getActivePID(): number | null {
    return this.activePID;
  }

  /**
   * Get all tracked PIDs with their file paths
   */
  getTrackedPIDs(): Array<{ pid: number; filePath: string; isActive: boolean }> {
    return Array.from(this.trackedPIDs.values());
  }

  /**
   * Get position debug info for the IPC handler
   */
  getPositionDebugInfo(): { success: boolean; data: object | null; error?: string } {
    try {
      // Get position data from native bridge
      const documentTopLeftCorner = wordAccessibility.getDocumentTopLeftCorner();
      const wordWindowBounds = wordAccessibility.getWordWindowBounds();
      const firstLinePosition = wordAccessibility.getFirstLinePosition();
      const pageCornerVisibility = wordAccessibility.getPageCornerVisibility();
      const parentHierarchy = wordAccessibility.getParentHierarchy();
      const buttonStates = wordAccessibility.getButtonStates();
      const scrollAreaBounds = wordAccessibility.getScrollAreaBounds();
      const firstTextAreaInfo = wordAccessibility.getFirstTextAreaInfo();

      // Get screen height for coordinate conversion
      const primaryDisplay = screen.getPrimaryDisplay();
      const screenHeight = primaryDisplay.bounds.height;

      return {
        success: true,
        data: {
          documentTopLeftCorner,
          wordWindowBounds,
          firstLinePosition,
          pageCornerVisibility,
          parentHierarchy,
          buttonStates,
          scrollAreaBounds,
          firstTextAreaInfo,
          screenHeight,
          timestamp: Date.now()
        }
      };
    } catch (error: any) {
      logger.error('[WORD-INTEGRATION] Error getting position info:', error);
      return {
        success: false,
        error: error.message,
        data: null
      };
    }
  }
}

// Export singleton instance
export const wordIntegrationService = new WordIntegrationService();
