import { useMemo } from 'react';
import { useApiClient } from '../context/ApiContext';
import {
  SupportingMaterial,
  SupportingMaterialCategory,
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
     * Uses existing IPC channel to upload file
     * Note: Supporting materials are identified by NOT setting is_primary_manuscript=true
     * @param projectId - Project ID
     * @param filePath - Local file path
     * @param category - Material category (reference, note, proposal, other)
     */
    uploadSupportingMaterial: async (
      projectId: number,
      filePath: string,
      category: SupportingMaterialCategory
    ): Promise<void> => {
      // Use existing IPC channel through the API client
      // For supporting materials, we set is_manuscript to false
      await client.invoke({
        method: 'POST',
        endpoint: 'upload-files',
        data: {
          filePath,
          projectId,
          is_manuscript: false,
          category
        },
      });
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
