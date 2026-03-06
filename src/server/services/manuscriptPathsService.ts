/**
 * Service to refresh manuscript paths cache.
 * Extracted from main.ts for reuse by enableFeedbackService.
 */

import { APIclient, checkLogin } from '../../apiClient';
import { wordIntegrationDataStoreV2, ProjectFileInfo } from '../../wordIntegrationDataStoreV2';
import { FEATURES } from '../../shared/types';
import { defaultLogger as logger } from '../../utils/logger';
import { remoteFeatureFlags, REMOTE_FLAGS } from '../../remoteFeatureFlags';

/**
 * Fetches all projects and their files, extracts manuscript paths,
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

    // Fetch all projects
    const projectsResponse = await client.get('/v0/co_scientist/projects');
    const projects = projectsResponse.data?.projects || [];

    if (projects.length === 0) {
      if (remoteFeatureFlags.getFlag(REMOTE_FLAGS.VERBOSE_WINDOW_MONITOR_LOGGING)) {
        logger.info('[VERBOSE] [MANUSCRIPT-PATHS] No projects found, cache empty');
      }
      wordIntegrationDataStoreV2.setProjectFileCache(new Map());
      return;
    }

    // Fetch files for each project in parallel, attaching project_id to each file
    const filesPromises = projects.map(async (project: { id: number }) => {
      try {
        const filesResponse = await client.get(`/v0/co_scientist/projects/${project.id}/files`);
        const files = filesResponse.data?.files || [];
        // Attach project_id to each file for building the cache
        return files.map((file: any) => ({ ...file, project_id: project.id }));
      } catch (error) {
        logger.error(`[MANUSCRIPT-PATHS] Failed to fetch files for project ${project.id}:`, error);
        return [];
      }
    });

    const allFilesArrays = await Promise.all(filesPromises);
    const allFiles = allFilesArrays.flat();

    // Filter for primary manuscript files
    const manuscriptFiles = allFiles.filter(
      (file: { is_primary_manuscript: boolean }) => file.is_primary_manuscript
    );

    // Build project file cache: filePath → { project_id, project_file_id }
    const projectFileCache = new Map<string, ProjectFileInfo>();
    for (const file of manuscriptFiles) {
      projectFileCache.set(file.file_path, {
        project_id: file.project_id,
        project_file_id: file.id,  // file.id is the project_file_id
      });
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
