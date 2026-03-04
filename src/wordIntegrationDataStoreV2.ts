/**
 * V2 Data store for Word integration — no PID logic.
 * Maps filePath → ProjectFileInfo for wid-based lookups.
 *
 * Architecture:
 * - main.ts writes to this store (project file cache from refreshManuscriptPaths)
 * - V2 HTTP/WS routes read from this store via getProjectFileForPath()
 */

import { wordPollEventBus } from './server/events/wordPollEventBus';

export interface ProjectFileInfo {
  project_id: number;
  project_file_id: number;
}

class WordIntegrationDataStoreV2 {
  private projectFileCache: Map<string, ProjectFileInfo> = new Map();

  setProjectFileCache(cache: Map<string, ProjectFileInfo>): void {
    this.projectFileCache = cache;
    wordPollEventBus.emit('change', 'v2-project-file-cache-changed');
  }

  getProjectFileForPath(filePath: string): ProjectFileInfo | null {
    return this.projectFileCache.get(filePath) || null;
  }

  getCacheSize(): number {
    return this.projectFileCache.size;
  }

  getCacheKeys(): string[] {
    return Array.from(this.projectFileCache.keys());
  }
}

export const wordIntegrationDataStoreV2 = new WordIntegrationDataStoreV2();
