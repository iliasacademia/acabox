/**
 * Service to refresh manuscript paths cache.
 */

import { APIclient, checkLogin } from '../../apiClient';
import { wordIntegrationDataStoreV2, ProjectFileInfo } from '../../wordIntegrationDataStoreV2';
import { FEATURES } from '../../shared/types';
import { defaultLogger as logger } from '../../utils/logger';
import { remoteFeatureFlags, REMOTE_FLAGS } from '../../remoteFeatureFlags';

const FILES_PAGE_LIMIT = 50;

/**
 * Fetches all primary manuscript files for the authenticated user across all
 * projects using GET /v0/co_scientist/files?is_primary_manuscript=true,
 * and passes them to wordIntegrationDataStoreV2.
 */
export async function refreshManuscriptPaths(): Promise<void> {
  if (!(FEATURES.MS_WORD_INTEGRATION_ENABLED && FEATURES.MS_WORD_V2_ENABLED)) {
    if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
      logger.info('[VERBOSE] [MANUSCRIPT-PATHS] Feature disabled, skipping');
    }
    return;
  }
  try {
    // Check if user is logged in first - if not, clear cache and return
    const isLoggedIn = await checkLogin();
    if (!isLoggedIn) {
      logger.info('[MANUSCRIPT-PATHS] User is logged out, clearing cache');
      wordIntegrationDataStoreV2.setProjectFileCache(new Map());
      return;
    }

    const client = await APIclient();

    // Fetch all primary manuscripts across all projects, paginating through results
    const allFiles: any[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await client.get('/v0/co_scientist/files', {
        params: { is_primary_manuscript: true, limit: FILES_PAGE_LIMIT, page },
      });
      const files = response.data?.files || [];
      allFiles.push(...files);
      hasMore = response.data?.pagination?.has_more ?? false;
      page += 1;
    }

    // Build project file cache: filePath → { project_id, project_file_id }
    // Skip files without a file_path or project_id (e.g. URL-only files)
    const projectFileCache = new Map<string, ProjectFileInfo>();
    for (const file of allFiles) {
      if (file.file_path && file.project_id) {
        projectFileCache.set(file.file_path, {
          project_id: file.project_id,
          project_file_id: file.id,
        });
      }
    }

    wordIntegrationDataStoreV2.setProjectFileCache(projectFileCache);
    if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
      logger.info(`[VERBOSE] [MANUSCRIPT-PATHS] Cache populated with ${projectFileCache.size} entries: ${Array.from(projectFileCache.keys()).join(', ')}`);
    }

  } catch (error) {
    logger.error('[MANUSCRIPT-PATHS] Error refreshing manuscript paths:', error);
    throw error;
  }
}
