import React, { useState, useEffect } from 'react';
import { useSupportingMaterialsApi } from '../api/useSupportingMaterialsApi';
import {
  SupportingMaterial,
  SupportingMaterialCategory,
} from '../types/supportingMaterials';
import { SupportingMaterialsTable } from './SupportingMaterialsTable';

interface UploadingFile {
  tempId: string;
  fileName: string;
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  fileId?: number;
}

export interface SupportingMaterialsContentProps {
  projectId: number;
  onMaterialsChange?: () => void;
  fileUploadEvent?: { file: any; timestamp: number } | null;
}

export function SupportingMaterialsContent({
  projectId,
  onMaterialsChange,
  fileUploadEvent,
}: SupportingMaterialsContentProps) {
  const [materials, setMaterials] = useState<SupportingMaterial[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const tableContainerRef = React.useRef<HTMLDivElement>(null);

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

  // Handle file upload events (from events polling)
  useEffect(() => {
    if (!fileUploadEvent) return;

    const { file } = fileUploadEvent;

    console.log('[SupportingMaterialsContent] File upload event:', file);

    // Check if this is a failed upload
    if (file.status === 'failed' || file.upload_status === 'failed') {
      // Mark the uploading file as failed
      setUploadingFiles((prev) =>
        prev.map((uf) =>
          uf.fileId === file.id ? { ...uf, status: 'failed' } : uf
        )
      );

      // Also update existing material if it's already in the list
      setMaterials((prev) =>
        prev.map((m) =>
          m.id === file.id ? { ...m, upload_status: 'failed' } : m
        )
      );
      return;
    }

    // File upload completed - remove from uploadingFiles and update materials
    if (file.id) {
      // Remove from uploading files by fileId AND by fileName as fallback
      setUploadingFiles((prev) =>
        prev.filter((uf) => uf.fileId !== file.id && uf.fileName !== file.file_name)
      );

      // Map the file data (tag → category)
      const material: SupportingMaterial = {
        ...file,
        category: file.tag || file.category,
      };

      // Update existing material or add new one (prevent duplicates)
      setMaterials((prev) => {
        // Check if file already exists by ID or file_name
        const existingIndex = prev.findIndex((m) =>
          m.id === material.id || m.file_name === material.file_name
        );

        if (existingIndex >= 0) {
          // File already exists - update it in place
          console.log('[SupportingMaterialsContent] Updating existing file at index', existingIndex);
          const updated = [...prev];
          updated[existingIndex] = material;
          return updated;
        } else {
          // New file - add to top
          console.log('[SupportingMaterialsContent] Adding new file to materials');
          return [material, ...prev];
        }
      });

      // Notify parent when materials change
      if (onMaterialsChange) {
        onMaterialsChange();
      }
    }
  }, [fileUploadEvent]);

  const fetchMaterials = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setCurrentPage(1);
      const { materials: data, hasMore: more, totalCount: count } =
        await getSupportingMaterials(projectId, 1);
      setMaterials(data);
      setHasMore(more);
      setTotalCount(count);
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
      setUploadProgress(null);
      setError(null);

      // Trigger file selection via IPC with multiple selection enabled
      if (!window.electronAPI?.invoke) {
        throw new Error('File selection not available');
      }

      const filePaths = await window.electronAPI.invoke('select-file', {
        extensions: ['pdf', 'doc', 'docx', 'txt'],
        multiSelection: true,
      });

      if (!filePaths || (Array.isArray(filePaths) && filePaths.length === 0)) {
        setIsUploading(false);
        return; // User cancelled
      }

      // Handle single or multiple files
      const files = Array.isArray(filePaths) ? filePaths : [filePaths];

      // Create placeholder rows for each file
      const placeholders: UploadingFile[] = files.map((filePath) => {
        const fileName = filePath.split('/').pop() || filePath;
        return {
          tempId: `temp-${Date.now()}-${Math.random()}`,
          fileName,
          status: 'uploading' as const,
        };
      });

      setUploadingFiles(placeholders);

      // Upload files sequentially with progress tracking
      for (let i = 0; i < files.length; i++) {
        setUploadProgress({ current: i + 1, total: files.length });
        const response = await uploadSupportingMaterial(projectId, files[i], 'reference');

        // Update placeholder with fileId and change status to processing
        setUploadingFiles((prev) =>
          prev.map((file, idx) =>
            idx === i ? { ...file, fileId: response.file.id, status: 'processing' } : file
          )
        );
      }

      // Files will be updated via events polling
    } catch (err) {
      console.error('Failed to upload file:', err);
      setError('Failed to upload file. Please try again.');
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
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

  const loadMoreMaterials = async () => {
    if (!hasMore || isLoadingMore) {
      console.log('[loadMoreMaterials] Skipping:', { hasMore, isLoadingMore, currentPage });
      return;
    }

    const nextPage = currentPage + 1;
    console.log('[loadMoreMaterials] Loading page:', nextPage);

    try {
      setIsLoadingMore(true);
      setError(null);
      const { materials: newMaterials, hasMore: more, totalCount: count } =
        await getSupportingMaterials(projectId, nextPage);

      console.log('[loadMoreMaterials] Received:', {
        page: nextPage,
        newMaterialsCount: newMaterials.length,
        hasMore: more,
        totalCount: count
      });

      setMaterials((prev) => [...prev, ...newMaterials]);
      setHasMore(more);
      setCurrentPage(nextPage);
      setTotalCount(count);
    } catch (err) {
      console.error('Failed to load more materials:', err);
      setError('Failed to load more materials.');
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Handle scroll for infinite loading
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container) return;

    let scrollTimeout: NodeJS.Timeout;

    const handleScroll = () => {
      // Clear previous timeout
      clearTimeout(scrollTimeout);

      // Debounce scroll events
      scrollTimeout = setTimeout(() => {
        // Don't load if already loading or no more items
        if (isLoadingMore || !hasMore) {
          return;
        }

        const { scrollTop, scrollHeight, clientHeight } = container;
        // Load more when scrolled to within 100px of bottom
        if (scrollHeight - scrollTop - clientHeight < 100) {
          loadMoreMaterials();
        }
      }, 150);
    };

    container.addEventListener('scroll', handleScroll);
    return () => {
      clearTimeout(scrollTimeout);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [hasMore, isLoadingMore, currentPage]);

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

      {/* Loading State */}
      {isLoading ? (
        <div className="supportingMaterialsLoading">Loading materials...</div>
      ) : (
        <>
          {/* Upload Section - Always visible */}
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
                  {isUploading
                    ? uploadProgress
                      ? `Uploading ${uploadProgress.current}/${uploadProgress.total} files...`
                      : 'Uploading...'
                    : 'Upload from computer'}
                </h3>
                <p className="uploadOptionSubtitle">PDF, DOCX, TXT</p>
              </div>
            </button>

            {/* Zotero Integration */}
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
                <p className="uploadOptionSubtitle">Status: Connected</p>
              </div>
            </button>
          </div>

          {/* Materials Table or Empty State */}
          {materials.length === 0 && uploadingFiles.length === 0 ? (
            <div className="supportingMaterialsEmpty">
              <p className="supportingMaterialsEmptyText">0 materials added</p>
            </div>
          ) : (
            <div
              ref={tableContainerRef}
              className="supportingMaterialsTableContainer"
            >
              <SupportingMaterialsTable
                materials={materials}
                uploadingFiles={uploadingFiles}
                onDelete={handleDelete}
                onCategoryChange={handleCategoryChange}
              />
              {isLoadingMore && (
                <div className="supportingMaterialsLoadingMore">
                  Loading more materials...
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
