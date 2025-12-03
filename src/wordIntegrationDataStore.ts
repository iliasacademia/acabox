/**
 * Data store for Word integration - separates data from service logic.
 * Used by httpServer to access project file info without importing full service.
 *
 * Architecture:
 * - wordIntegrationService writes to this store (tracked PIDs)
 * - main.ts writes to this store (project file cache)
 * - httpServer reads from this store (getProjectFileForPID)
 */

/**
 * Project file information for a manuscript
 */
export interface ProjectFileInfo {
  project_id: number;
  project_file_id: number;
}

/**
 * Tracked PID information
 */
export interface TrackedPIDInfo {
  pid: number;
  filePath: string;
  isActive: boolean;
}

class WordIntegrationDataStore {
  private projectFileCache: Map<string, ProjectFileInfo> = new Map();
  private trackedPIDs: Map<number, TrackedPIDInfo> = new Map();

  // === Setters (called by wordIntegrationService and main.ts) ===

  /**
   * Set the project file cache mapping file paths to project info.
   * Called from refreshManuscriptPaths() in main.ts.
   */
  setProjectFileCache(cache: Map<string, ProjectFileInfo>): void {
    this.projectFileCache = cache;
  }

  /**
   * Add or update a tracked PID.
   * Called from wordIntegrationService when tracking starts.
   */
  setTrackedPID(pid: number, info: TrackedPIDInfo): void {
    this.trackedPIDs.set(pid, info);
  }

  /**
   * Remove a tracked PID.
   * Called from wordIntegrationService when tracking stops.
   */
  deleteTrackedPID(pid: number): void {
    this.trackedPIDs.delete(pid);
  }

  /**
   * Clear all tracked PIDs.
   * Called from wordIntegrationService on cleanup.
   */
  clearTrackedPIDs(): void {
    this.trackedPIDs.clear();
  }

  // === Getters (called by httpServer routes) ===

  /**
   * Get project file info for a tracked PID.
   * Returns null if PID not tracked or project file info not found.
   */
  getProjectFileForPID(pid: number): ProjectFileInfo | null {
    const tracked = this.trackedPIDs.get(pid);
    if (!tracked) {
      return null;
    }

    const projectFile = this.projectFileCache.get(tracked.filePath);
    if (!projectFile) {
      return null;
    }

    return projectFile;
  }

  /**
   * Get all tracked PIDs with their info.
   */
  getTrackedPIDs(): TrackedPIDInfo[] {
    return Array.from(this.trackedPIDs.values());
  }
}

export const wordIntegrationDataStore = new WordIntegrationDataStore();
