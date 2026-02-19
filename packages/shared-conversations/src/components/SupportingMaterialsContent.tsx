import React, { useState, useEffect } from 'react';
import { useSupportingMaterialsApi } from '../api/useSupportingMaterialsApi';
import {
  SupportingMaterial,
  SupportingMaterialCategory,
} from '../types/supportingMaterials';
import { SupportingMaterialsTable } from './SupportingMaterialsTable';

export interface SupportingMaterialsContentProps {
  projectId: number;
  onMaterialsChange?: () => void;
}

export function SupportingMaterialsContent({
  projectId,
  onMaterialsChange,
}: SupportingMaterialsContentProps) {
  const [materials, setMaterials] = useState<SupportingMaterial[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    getSupportingMaterials,
    uploadSupportingMaterial,
    deleteSupportingMaterial,
    updateMaterialCategory,
  } = useSupportingMaterialsApi();

  // Fetch materials on mount
  useEffect(() => {
    fetchMaterials();
  }, [projectId]);

  const fetchMaterials = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getSupportingMaterials(projectId);
      setMaterials(data);
    } catch (err) {
      console.error('Failed to load supporting materials:', err);
      setError('Failed to load supporting materials. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUploadFromComputer = async () => {
    try {
      setIsUploading(true);
      setError(null);

      // Trigger file selection via IPC
      // @ts-ignore - electronAPI is defined in global.d.ts in the main app
      if (!window.electronAPI?.invoke) {
        throw new Error('File selection not available');
      }

      // @ts-ignore - electronAPI is defined in global.d.ts in the main app
      const filePath = await window.electronAPI.invoke('select-file', {
        extensions: ['pdf', 'doc', 'docx', 'txt'],
      });

      if (!filePath) {
        setIsUploading(false);
        return; // User cancelled
      }

      // Upload file with default category 'reference'
      await uploadSupportingMaterial(projectId, filePath, 'reference');

      // Refresh materials list
      await fetchMaterials();

      // Notify parent of changes
      if (onMaterialsChange) {
        onMaterialsChange();
      }
    } catch (err) {
      console.error('Failed to upload file:', err);
      setError('Failed to upload file. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setError(null);
      await deleteSupportingMaterial(projectId, id);
      await fetchMaterials();

      // Notify parent of changes
      if (onMaterialsChange) {
        onMaterialsChange();
      }
    } catch (err) {
      console.error('Failed to delete file:', err);
      setError('Failed to delete file. Please try again.');
    }
  };

  const handleCategoryChange = async (
    id: number,
    newCategory: SupportingMaterialCategory
  ) => {
    try {
      setError(null);
      // Optimistically update local state
      setMaterials((prev) =>
        prev.map((m) => (m.id === id ? { ...m, category: newCategory } : m))
      );
      await updateMaterialCategory(projectId, id, newCategory);
    } catch (err) {
      console.error('Failed to update category:', err);
      setError('Failed to update category.');
      await fetchMaterials(); // Revert on error
    }
  };

  return (
    <div className="supportingMaterialsContent">
      {/* Header */}
      <div className="supportingMaterialsContentHeader">
        <h1 className="supportingMaterialsContentTitle">Supporting materials</h1>
        <p className="supportingMaterialsContentDescription">
          Improve reviews by uploading related papers, proposals, or notes.
        </p>
      </div>

      {/* Error Message */}
      {error && <div className="supportingMaterialsError">{error}</div>}

      {/* Upload Section */}
      <div className="supportingMaterialsUploadSection">
        {/* Upload from Computer */}
        <button
          className="uploadOption"
          onClick={handleUploadFromComputer}
          disabled={isUploading}
        >
          <div className="uploadOptionIcon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M17 8L12 3L7 8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 3V15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="uploadOptionContent">
            <h3 className="uploadOptionTitle">
              {isUploading ? 'Uploading...' : 'Upload from your computer'}
            </h3>
            <p className="uploadOptionSubtitle">PDF, DOCX, TXT</p>
          </div>
        </button>

        {/* Zotero Integration (Coming Soon) */}
        <button className="uploadOption disabled" disabled>
          <div className="uploadOptionIcon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M12 2L2 7L12 12L22 7L12 2Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M2 17L12 22L22 17"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M2 12L12 17L22 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="uploadOptionContent">
            <h3 className="uploadOptionTitle">Choose from Zotero</h3>
            <p className="uploadOptionSubtitle">Coming soon</p>
          </div>
        </button>
      </div>

      {/* Materials Table */}
      {isLoading ? (
        <div className="supportingMaterialsLoading">Loading materials...</div>
      ) : (
        <SupportingMaterialsTable
          materials={materials}
          onDelete={handleDelete}
          onCategoryChange={handleCategoryChange}
        />
      )}
    </div>
  );
}
