/**
 * Data store for Word integration - separates data from service logic.
 * Used by httpServer to access project file info without importing full service.
 *
 * Architecture:
 * - wordIntegrationService writes to this store (tracked PIDs)
 * - main.ts writes to this store (project file cache)
 * - httpServer reads from this store (getProjectFileForPID)
 */

import { wordPollEventBus } from './server/events/wordPollEventBus';

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
    wordPollEventBus.emit('change', 'project-file-cache-changed');
  }

  /**
   * Add or update a tracked PID.
   * Called from wordIntegrationService when tracking starts.
   */
  setTrackedPID(pid: number, info: TrackedPIDInfo): void {
    this.trackedPIDs.set(pid, info);
    wordPollEventBus.emit('change', 'tracked-pids-changed');
  }

  /**
   * Remove a tracked PID.
   * Called from wordIntegrationService when tracking stops.
   */
  deleteTrackedPID(pid: number): void {
    this.trackedPIDs.delete(pid);
    wordPollEventBus.emit('change', 'tracked-pids-changed');
  }

  /**
   * Clear all tracked PIDs.
   * Called from wordIntegrationService on cleanup.
   */
  clearTrackedPIDs(): void {
    this.trackedPIDs.clear();
    wordPollEventBus.emit('change', 'tracked-pids-changed');
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
   * Get project file info for a given file path.
   * Note: The file path must match the one used during manuscript registration.
   */
  getProjectFileForPath(filePath: string): ProjectFileInfo | null {
    // We might need to normalize the path here (e.g. NFD/NFC) if not matching
    // But for now, direct lookup since main.ts sets the cache
    return this.projectFileCache.get(filePath) || null;
  }

  /**
   * Get all tracked PIDs with their info.
   */
  getTrackedPIDs(): TrackedPIDInfo[] {
    return Array.from(this.trackedPIDs.values());
  }
}

export const wordIntegrationDataStore = new WordIntegrationDataStore();
