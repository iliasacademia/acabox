import { useMemo } from 'react';
import { useApiClient } from '../context/ApiContext';
import {
  SupportingMaterial,
  SupportingMaterialCategory,
  UploadResponse,
} from '../types/supportingMaterials';

/**
 * Hook that provides supporting materials API functions.
 * Uses the injected API client from context.
 *
 * @example
 * function MyComponent() {
 *   const { getSupportingMaterials, uploadSupportingMaterial } = useSupportingMaterialsApi();
 *
 *   const loadMaterials = async () => {
 *     const materials = await getSupportingMaterials(projectId);
 *   };
 * }
 */
export function useSupportingMaterialsApi() {
  const client = useApiClient();

  return useMemo(() => ({
    /**
     * Get supporting materials for a project
     * GET /v0/co_scientist/projects/:id/files
     * Filters response to only include supporting materials (files where is_manuscript is false or omitted)
     */
    getSupportingMaterials: async (projectId: number): Promise<SupportingMaterial[]> => {
      const response = await client.invoke<{ files?: SupportingMaterial[] }>({
        method: 'GET',
        endpoint: `v0/co_scientist/projects/${projectId}/files`,
      });

      // Filter to only supporting materials (exclude primary manuscript)
      const allFiles = response.files || [];
      return allFiles.filter((file: any) =>
        !file.is_primary_manuscript
      ) as SupportingMaterial[];
    },

    /**
     * Upload supporting material
     * POST /v0/co_scientist/projects/:projectId/files
     * Uploads a file and returns the file info with upload_status: "pending"
     *
     * After upload, file upload events will be sent through the existing events polling system:
     * - file_upload_started: Job picked up, S3 copy in progress
     * - file_upload_completed: File at final S3 path, tagging/embedding queued
     * - file_upload_failed: Upload failed with error
     *
     * Listen for these events using useCoScientistEvents hook.
     *
     * @param projectId - Project ID
     * @param filePath - Local file path (absolute path)
     * @param category - Optional material category
     * @returns Upload response with file info including ID
     */
    uploadSupportingMaterial: async (
      projectId: number,
      filePath: string,
      category?: SupportingMaterialCategory
    ): Promise<UploadResponse> => {
      // Use IPC channel to upload file through main process
      // The main process will handle multipart form upload to backend
      const response = await client.invoke<UploadResponse>({
        method: 'POST',
        endpoint: 'upload-supporting-material',
        data: {
          projectId,
          filePath,
          category,
        },
      });
      return response;
    },

    /**
     * Delete supporting material
     * DELETE /v0/co_scientist/projects/:projectId/files/:fileId
     */
    deleteSupportingMaterial: async (
      projectId: number,
      fileId: number
    ): Promise<void> => {
      await client.invoke({
        method: 'DELETE',
        endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}`,
      });
    },

    /**
     * Update material category
     * PUT /v0/co_scientist/projects/:projectId/files/:fileId
     */
    updateMaterialCategory: async (
      projectId: number,
      fileId: number,
      category: SupportingMaterialCategory
    ): Promise<void> => {
      await client.invoke({
        method: 'PUT',
        endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}`,
        data: { category },
      });
    },
  }), [client]);
}
