import { useMemo } from 'react';
import { useApiClient } from '../context/ApiContext';
import {
  ProjectFile,
  DiffResponse,
  ProjectStatusResponse,
} from '../types/project';

/**
 * Hook that provides project-related API functions needed for conversations.
 * Uses the injected API client from context.
 *
 * @example
 * function MyComponent() {
 *   const { getProjectFiles, triggerFullReview } = useProjectsApi();
 *
 *   const loadFiles = async () => {
 *     const files = await getProjectFiles(projectId);
 *     const manuscript = files.find(f => f.is_primary_manuscript);
 *   };
 * }
 */
export function useProjectsApi() {
  const client = useApiClient();

  return useMemo(() => ({
    /**
     * Get files in project
     * GET /v0/co_scientist/projects/:id/files
     */
    getProjectFiles: async (projectId: number): Promise<ProjectFile[]> => {
      const response = await client.invoke<{ files?: ProjectFile[] }>({
        method: 'GET',
        endpoint: `v0/co_scientist/projects/${projectId}/files`,
      });
      return response.files || [];
    },

    /**
     * Get project status with agent runs
     * GET /v0/co_scientist/projects/:id/status
     * @param projectId - Project ID
     * @param agentName - Optional: Filter by agent name (e.g., 'science_agent')
     * @param fileId - Optional: Filter by file ID
     */
    getProjectStatus: async (
      projectId: number,
      agentName?: string,
      fileId?: number
    ): Promise<ProjectStatusResponse> => {
      let endpoint = `v0/co_scientist/projects/${projectId}/status`;

      const params: string[] = [];
      if (agentName) params.push(`agent_name=${agentName}`);
      if (fileId) params.push(`file_id=${fileId}`);

      if (params.length > 0) {
        endpoint += `?${params.join('&')}`;
      }

      const response = await client.invoke<ProjectStatusResponse>({
        method: 'GET',
        endpoint,
      });
      return response;
    },

    /**
     * Get file diff (current version vs previous version)
     * GET /v0/co_scientist/projects/:projectId/files/:fileId/diff?conversation_id=:conversationId
     * Returns diff response with plain text diff and metadata
     */
    getFileDiff: async (
      projectId: number,
      fileId: number,
      conversationId: number
    ): Promise<DiffResponse> => {
      const response = await client.invoke<DiffResponse>({
        method: 'GET',
        endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}/diff?conversation_id=${conversationId}`,
      });
      return response;
    },

    /**
     * Trigger full review for a manuscript file
     * POST /v0/co_scientist/projects/:projectId/files/:fileId/trigger_full_review
     */
    triggerFullReview: async (
      projectId: number,
      fileId: number
    ): Promise<{ agent_run_id: number; status: string; current_version_id: string }> => {
      const response = await client.invoke<{
        agent_run_id: number;
        status: string;
        current_version_id: string;
      }>({
        method: 'POST',
        endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}/trigger_full_review`,
      });
      return response;
    },

    /**
     * Trigger diff review for a manuscript file (reviews only changes since last review)
     * POST /v0/co_scientist/projects/:projectId/files/:fileId/trigger_diff_review
     */
    triggerDiffReview: async (
      projectId: number,
      fileId: number
    ): Promise<{ agent_run_id: number; status: string; current_version_id: string }> => {
      const response = await client.invoke<{
        agent_run_id: number;
        status: string;
        current_version_id: string;
      }>({
        method: 'POST',
        endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}/trigger_diff_review`,
      });
      return response;
    },
  }), [client]);
}
