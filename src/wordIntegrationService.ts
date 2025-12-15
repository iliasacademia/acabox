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

  // Track if we've already prompted for accessibility permission
  private hasPromptedForPermission = false;

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
   * Unescape lsof output that contains \xNN escape sequences.
   * lsof escapes non-ASCII bytes as \xNN, we need to decode them as UTF-8.
   * e.g., 'ž' (U+017E) in NFD is z + combining caron (U+030C), UTF-8: 0xCC 0x8C
   * lsof shows as: z\xcc\x8c
   */
  private unescapeLsofOutput(input: string): string {
    // Find all \xNN sequences and collect bytes
    const parts: (string | number[])[] = [];
    let lastIndex = 0;
    const regex = /\\x([0-9a-fA-F]{2})/g;
    let match;

    while ((match = regex.exec(input)) !== null) {
      // Add text before this escape sequence
      if (match.index > lastIndex) {
        parts.push(input.substring(lastIndex, match.index));
      }

      // Collect consecutive \xNN sequences as byte array
      const bytes: number[] = [];
      let currentIndex = match.index;
      while (currentIndex < input.length) {
        const nextMatch = input.substring(currentIndex).match(/^\\x([0-9a-fA-F]{2})/);
        if (nextMatch) {
          bytes.push(parseInt(nextMatch[1], 16));
          currentIndex += 4; // \xNN is 4 characters
        } else {
          break;
        }
      }
      parts.push(bytes);
      lastIndex = currentIndex;
      regex.lastIndex = currentIndex;
    }

    // Add remaining text
    if (lastIndex < input.length) {
      parts.push(input.substring(lastIndex));
    }

    // Decode byte arrays as UTF-8 and concatenate
    const decoder = new TextDecoder('utf-8');
    return parts.map(part => {
      if (typeof part === 'string') {
        return part;
      }
      return decoder.decode(new Uint8Array(part));
    }).join('');
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
            // Extract just the filename for matching (lsof may not show full path)
            const fileName = filePath.split('/').pop() || filePath;

            // lsof escapes non-ASCII bytes as \xNN - we need to decode them as UTF-8
            // e.g., 'ž' in NFD = z + combining caron (U+030C), UTF-8: 0xCC 0x8C
            // lsof shows as: z\xcc\x8c (literal escape sequences)
            const unescapedLsof = this.unescapeLsofOutput(lsofResult);

            // Now normalize both to NFD for comparison
            const normalizedFileName = fileName.normalize('NFD');
            const normalizedLsof = unescapedLsof.normalize('NFD');

            if (normalizedLsof.includes(normalizedFileName)) {
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
    // Always call stopAllObserving to ensure native overlays are hidden,
    // even if trackedPIDs is empty (handles state sync issues)
    wordAccessibility.stopAllObserving();
    this.trackedPIDs.clear();
    wordIntegrationDataStore.clearTrackedPIDs();
    this.activePID = null;
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
      } else {
        // PID already tracked, check if file path changed
        const tracked = this.trackedPIDs.get(pid);
        if (tracked && tracked.filePath !== filePath) {
          logger.info(`[WORD-INTEGRATION] PID ${pid} switched file: ${tracked.filePath} -> ${filePath}`);
          tracked.filePath = filePath;
          wordIntegrationDataStore.setTrackedPID(pid, tracked);
        }
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
      if (!this.hasPromptedForPermission) {
        logger.warn('[WORD-INTEGRATION] Accessibility permission not granted, prompting user...');
        this.hasPromptedForPermission = true;
        wordAccessibility.requestPermission();
      }
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
      logger.error('[WORD-INTEGRATION] Failed to start native observer', { pid, filePath });
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
   * Get the active document path for a specific PID from the native layer.
   * This handles multi-window scenarios where one PID manages multiple documents.
   */
  getActiveDocumentPath(pid: number): string | null {
    if (!FEATURES.MS_WORD_INTEGRATION_ENABLED) {
      return null;
    }
    return wordAccessibility.getActiveDocumentPath(pid);
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
