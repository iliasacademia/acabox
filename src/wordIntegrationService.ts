import { execSync } from 'child_process';
import { screen } from 'electron';
import { wordAccessibility, AccessibilityEvent } from './native/wordAccessibility';
import { FEATURES } from './shared/types';

/**
 * WordIntegrationService handles all MS Word integration functionality:
 * - Auto-detection of Word process
 * - Accessibility observer management
 * - Position/debug info retrieval
 */
class WordIntegrationService {
  private wordCheckInterval: NodeJS.Timeout | null = null;
  private isSelectionTrackingActive = false;
  private serverBaseUrl: string | null = null;
  private manuscriptPaths: string[] = [];

  /**
   * Initialize Word integration.
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
   * Phase 1: Logs all matching PIDs, tracks only the first one.
   */
  setManuscriptPaths(filePaths: string[]): void {
    this.manuscriptPaths = filePaths;
    console.log('[WORD-INTEGRATION] Manuscript paths set:', filePaths);

    if (!FEATURES.MS_WORD_INTEGRATION_ENABLED) {
      console.log('[WORD-INTEGRATION] MS Word integration is disabled');
      return;
    }

    if (filePaths.length === 0) {
      console.log('[WORD-INTEGRATION] No manuscript paths - stopping tracking');
      if (this.isSelectionTrackingActive) {
        wordAccessibility.stopObserving();
        this.isSelectionTrackingActive = false;
      }
      return;
    }

    // Find and log all matches, track first one
    this.checkAndTrackManuscripts();

    // Start polling if not already running
    this.startPollingIfNeeded();
  }

  /**
   * Check for manuscripts and track the first matching PID.
   * Logs ALL matches for verification even though we only track one (Phase 1).
   */
  private checkAndTrackManuscripts(): void {
    const matches = this.findWordPIDsWithFiles(this.manuscriptPaths);

    if (matches.length > 0 && !this.isSelectionTrackingActive) {
      // Track first match only (Phase 1 limitation)
      const { pid, filePath } = matches[0];
      console.log(`[WORD-INTEGRATION] Tracking PID ${pid} (${filePath})`);

      if (matches.length > 1) {
        console.log(`[WORD-INTEGRATION] NOTE: ${matches.length - 1} other Word process(es) also have manuscripts (Phase 2 will track all)`);
      }

      this.startObservingPID(pid);
    }
  }

  /**
   * Start the polling interval if not already running.
   */
  private startPollingIfNeeded(): void {
    if (this.wordCheckInterval) return;

    this.wordCheckInterval = setInterval(() => {
      if (this.manuscriptPaths.length === 0) return;
      if (this.isSelectionTrackingActive) return; // Already tracking (Phase 1)

      this.checkAndTrackManuscripts();
    }, 5000);
  }

  /**
   * Start observing a specific Word PID.
   * Uses existing single-PID bridge (no changes to bridge.mm).
   */
  private startObservingPID(pid: number): void {
    if (!wordAccessibility.checkPermission()) {
      console.log('[WORD-BUTTON] Accessibility permission not granted');
      return;
    }

    wordAccessibility.startObserving(pid, (event: AccessibilityEvent) => {
      if (event.type === 'buttonClicked' && event.text === 'academia-button-clicked') {
        console.log('[WORD-BUTTON] Academia button clicked');
      }
    });

    this.isSelectionTrackingActive = true;
    console.log('[WORD-BUTTON] Tracking started for PID:', pid);
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

    // Stop selection tracking
    if (this.isSelectionTrackingActive) {
      try {
        wordAccessibility.stopObserving();
        this.isSelectionTrackingActive = false;
        console.log('[WORD-INTEGRATION] Selection tracking stopped successfully');
      } catch (error) {
        console.error('[WORD-INTEGRATION] Error stopping observer:', error);
      }
    }
  }

  /**
   * Check if Word tracking is currently active
   */
  isActive(): boolean {
    return this.isSelectionTrackingActive;
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
