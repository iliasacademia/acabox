import { execSync } from 'child_process';
import { screen } from 'electron';
import { wordAccessibility, AccessibilityEvent } from './native/wordAccessibility';
import { FEATURES } from './shared/types';
import { wordIntegrationDataStore } from './wordIntegrationDataStore';

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
      console.log('[WORD-INTEGRATION] MS Word integration is disabled');
      return;
    }

    // Set native feature flags BEFORE any PID observation starts
    // (buttons are created during observer initialization)
    wordAccessibility.setFeatureFlags({
      textSideButtonEnabled: FEATURES.TEXT_SIDE_BUTTON_ENABLED,
      overallReviewButtonEnabled: FEATURES.OVERALL_REVIEW_BUTTON_ENABLED,
    });

    console.log('[WORD-INTEGRATION] Initialized. Call setManuscriptPaths() to start tracking.');
  }

  /**
   * Set the HTTP server base URL for native popups
   */
  setServerBaseUrl(url: string): boolean {
    this.serverBaseUrl = url;
    const success = wordAccessibility.setServerBaseUrl(url);
    if (success) {
      console.log('[WORD-INTEGRATION] Server URL set for native popups');
    } else {
      console.error('[WORD-INTEGRATION] Failed to set server URL for native popups');
    }
    return success;
  }

  /**
   * Set the navigation handler callback for popup-to-main-window navigation.
   * Called by main.ts to provide navigation functionality.
   */
  setNavigationHandler(handler: (payload: { page: string; projectId: number; conversationId: number }) => void): void {
    this.navigationHandler = handler;
    console.log('[WORD-INTEGRATION] Navigation handler set');
  }

  /**
   * Find all Word PIDs that have any of the specified files open using lsof.
   * Logs all matches for verification. Returns array of {pid, filePath} pairs.
   */
  private findWordPIDsWithFiles(filePaths: string[]): Array<{pid: number, filePath: string}> {
    if (filePaths.length === 0) return [];

    const matches: Array<{pid: number, filePath: string}> = [];

    try {
      const pidsResult = execSync("pgrep 'Microsoft Word'", { encoding: 'utf8' }).trim();
      if (!pidsResult) {
        console.log('[WORD-INTEGRATION] No Microsoft Word processes found');
        return [];
      }

      const pids = pidsResult.split('\n').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
      console.log(`[WORD-INTEGRATION] Found ${pids.length} Word process(es):`, pids);

      for (const pid of pids) {
        try {
          const lsofResult = execSync(`lsof -p ${pid} 2>/dev/null`, { encoding: 'utf8' });

          for (const filePath of filePaths) {
            if (lsofResult.includes(filePath)) {
              console.log(`[WORD-INTEGRATION] ✓ PID ${pid} has manuscript: ${filePath}`);
              matches.push({ pid, filePath });
              break; // One match per PID is enough
            }
          }
        } catch {
          console.log(`[WORD-INTEGRATION] Could not check PID ${pid}`);
        }
      }

      // Summary log
      if (matches.length === 0) {
        console.log('[WORD-INTEGRATION] No Word processes have manuscripts open');
        console.log('[WORD-INTEGRATION] Looking for:', filePaths);
      } else {
        console.log(`[WORD-INTEGRATION] Found ${matches.length} Word process(es) with manuscripts`);
      }

    } catch {
      console.log('[WORD-INTEGRATION] pgrep failed - Word not running');
    }

    return matches;
  }

  /**
   * Set or update the manuscript paths and start tracking.
   * Phase 2: Tracks ALL matching PIDs, shows overlays only on active/focused Word.
   */
  setManuscriptPaths(filePaths: string[]): void {
    this.manuscriptPaths = filePaths;
    console.log('[WORD-INTEGRATION] Manuscript paths set:', filePaths);

    if (filePaths.length === 0) {
      console.log('[WORD-INTEGRATION] No manuscript paths - stopping all tracking');
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
      console.log(`[WORD-INTEGRATION] Stopping tracking of ${this.trackedPIDs.size} PID(s)`);
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
          console.log(`[WORD-INTEGRATION] Max PIDs (${this.MAX_PIDS}) reached, keeping first-opened. Skipping newer PID ${pid}`);
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

    // Log current state
    if (this.trackedPIDs.size > 0) {
      console.log(`[WORD-INTEGRATION] Tracking ${this.trackedPIDs.size} PID(s), active: ${this.activePID ?? 'none'}`);
    }
  }

  /**
   * Start tracking a specific PID.
   */
  private startTrackingPID(pid: number, filePath: string): void {
    if (!FEATURES.MS_WORD_INTEGRATION_ENABLED) {
      console.log('[WORD-INTEGRATION] Native tracking disabled (feature flag off)');
      return;
    }

    if (!wordAccessibility.checkPermission()) {
      console.log('[WORD-INTEGRATION] Accessibility permission not granted');
      return;
    }

    if (this.trackedPIDs.has(pid)) {
      return;
    }

    const success = wordAccessibility.startObservingPID(pid, (event: AccessibilityEvent) => {
      // Handle events from this PID
      if (event.type === 'buttonClicked' && event.text === 'academia-button-clicked') {
        console.log(`[WORD-BUTTON] Academia button clicked on PID ${pid}`);
      }

      // Handle navigation requests from popup (format: "navigateToPage|{json}")
      if (event.type === 'buttonClicked' && event.text?.startsWith('navigateToPage|')) {
        try {
          const jsonPayload = event.text.substring('navigateToPage|'.length);
          const payload = JSON.parse(jsonPayload);
          console.log(`[WORD-INTEGRATION] Navigate to page from popup:`, payload);

          if (this.navigationHandler) {
            this.navigationHandler(payload);
          } else {
            console.warn('[WORD-INTEGRATION] Navigation handler not set');
          }
        } catch (err) {
          console.error('[WORD-INTEGRATION] Error parsing navigateToPage payload:', err);
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

      console.log(`[WORD-INTEGRATION] Started tracking PID ${pid} (${filePath}), active: ${isActive}`);
    } else {
      console.error(`[WORD-INTEGRATION] Failed to start tracking PID ${pid}`);
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

    console.log(`[WORD-INTEGRATION] Stopped tracking PID ${pid}`);

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
        console.log(`[WORD-INTEGRATION] Activated next PID: ${nextPID}`);
      }
    }
  }

  /**
   * Log all current PID → manuscriptPath mappings for verification.
   * Called every poll cycle regardless of tracking state.
   */
  private logCurrentPIDMappings(): void {
    const matches = this.findWordPIDsWithFiles(this.manuscriptPaths);

    console.log('[WORD-INTEGRATION] === PID Mapping Check ===');
    console.log(`[WORD-INTEGRATION] Tracked: ${this.trackedPIDs.size}, Active: ${this.activePID ?? 'none'}`);
    if (matches.length === 0) {
      console.log('[WORD-INTEGRATION] No Word processes have manuscripts open');
    } else {
      console.log('[WORD-INTEGRATION] Current mappings:');
      for (const { pid, filePath } of matches) {
        const tracked = this.trackedPIDs.has(pid) ? ' [TRACKED]' : '';
        const active = this.activePID === pid ? ' [ACTIVE]' : '';
        console.log(`[WORD-INTEGRATION]   PID ${pid} → ${filePath}${tracked}${active}`);
      }
    }
    console.log('[WORD-INTEGRATION] ========================');
  }

  /**
   * Start the polling interval if not already running.
   */
  private startPollingIfNeeded(): void {
    if (this.wordCheckInterval) return;

    this.wordCheckInterval = setInterval(() => {
      if (this.manuscriptPaths.length === 0) return;

      // Always log current PID mappings for verification
      this.logCurrentPIDMappings();

      // Always check and sync tracked PIDs (adds new, removes stale)
      this.checkAndTrackManuscripts();
    }, 5000);
  }

  /**
   * Clean up all Word integration resources
   */
  cleanup(): void {
    console.log('[WORD-INTEGRATION] Cleaning up native resources...');

    // Stop Word check interval
    if (this.wordCheckInterval) {
      console.log('[WORD-INTEGRATION] Stopping Word check interval...');
      clearInterval(this.wordCheckInterval);
      this.wordCheckInterval = null;
    }

    // Stop all observers
    if (this.trackedPIDs.size > 0) {
      try {
        console.log(`[WORD-INTEGRATION] Stopping ${this.trackedPIDs.size} observer(s)...`);
        wordAccessibility.stopAllObserving();
        this.trackedPIDs.clear();
        wordIntegrationDataStore.clearTrackedPIDs();
        this.activePID = null;
        console.log('[WORD-INTEGRATION] All observers stopped successfully');
      } catch (error) {
        console.error('[WORD-INTEGRATION] Error stopping observers:', error);
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
      console.error('[WORD-INTEGRATION] Error getting position info:', error);
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
