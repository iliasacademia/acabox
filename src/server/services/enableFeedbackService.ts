/**
 * Service to orchestrate the "Enable feedback" flow:
 * 1. Resolve document path from window ID
 * 2. Create project with derived name
 * 3. Start file sync (upload + watch)
 * 4. Refresh manuscript paths cache
 * 5. Trigger full review
 * 6. Set review state on window
 * 7. Navigate renderer to project detail
 * 8. Close the popup
 */

import * as path from 'path';
import { APIclient, getCsrfToken } from '../../apiClient';
import { windowMonitorService } from '../../windowMonitorService';
import { projectSyncService } from '../../projectSyncService';
import { defaultLogger as logger } from '../../utils/logger';
import { refreshManuscriptPaths } from './manuscriptPathsService';
import { NavigationHandler } from '../routes/navigation';

export interface EnableFeedbackResult {
  success: boolean;
  projectId?: number;
  projectFileId?: number;
  error?: string;
}

export async function enableFeedback(
  wid: string,
  navigationHandler?: NavigationHandler | null,
): Promise<EnableFeedbackResult> {
  try {
    // Step 1: Resolve document path
    const documentPath = windowMonitorService.getDocumentPathForWindow(wid);
    if (!documentPath) {
      return { success: false, error: 'No document path found for this window' };
    }

    logger.info(`[EnableFeedback] Starting for wid=${wid}, path=${documentPath}`);

    // Step 2: Derive project name from filename (strip extension)
    const fileName = path.basename(documentPath);
    const dotIdx = fileName.lastIndexOf('.');
    const projectName = dotIdx >= 0 ? fileName.substring(0, dotIdx) : fileName;

    // Step 3: Create project via API
    const client = await APIclient();
    const csrfToken = await getCsrfToken();

    const createResponse = await client.post(
      'v0/co_scientist/projects',
      { project: { name: projectName, file_path: documentPath } },
      { headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' } },
    );

    const project = createResponse.data?.project || createResponse.data;
    const projectId = project?.id;
    if (!projectId) {
      return { success: false, error: 'Project creation failed: no project ID returned' };
    }

    logger.info(`[EnableFeedback] Project created: id=${projectId}, name=${projectName}`);

    // Step 4: Start file sync (upload + watch)
    await projectSyncService.startWatchingFile(projectId, documentPath);
    logger.info(`[EnableFeedback] File sync started for project ${projectId}`);

    // Step 5: Refresh manuscript paths cache so the document is recognized
    await refreshManuscriptPaths();
    logger.info(`[EnableFeedback] Manuscript paths refreshed`);

    // Step 6: Get project file ID from files endpoint
    const filesResponse = await client.get(`/v0/co_scientist/projects/${projectId}/files`);
    const files = filesResponse.data?.files || [];
    const manuscriptFile = files.find(
      (f: any) => f.is_primary_manuscript || f.file_path === documentPath,
    );
    const projectFileId = manuscriptFile?.id || project.primary_manuscript_id;

    if (!projectFileId) {
      return { success: false, error: 'Could not find project file ID after creation', projectId };
    }

    // Step 7: Trigger full review
    await client.post(
      `v0/co_scientist/projects/${projectId}/files/${projectFileId}/trigger_full_review`,
      {},
      { headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' } },
    );
    logger.info(`[EnableFeedback] Full review triggered for project ${projectId}, file ${projectFileId}`);

    // Step 8: Set reviewing state on window
    windowMonitorService.setSelectedTextReviewState(wid, projectId, projectFileId, 'full-paper');

    // Step 9: Navigate renderer to project detail
    if (navigationHandler) {
      try {
        await navigationHandler({ page: 'conversations', projectId });
        logger.info(`[EnableFeedback] Navigated to project ${projectId}`);
      } catch (navError) {
        logger.warn(`[EnableFeedback] Navigation failed (non-fatal):`, navError);
      }
    }

    // Step 10: Close the popup
    windowMonitorService.closePopupForWindow(wid, false);

    return { success: true, projectId, projectFileId };
  } catch (error: any) {
    logger.error(`[EnableFeedback] Error:`, error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}
