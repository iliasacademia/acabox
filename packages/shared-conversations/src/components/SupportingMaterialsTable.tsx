import React, { useState, useMemo } from 'react';
import {
  SupportingMaterial,
  SupportingMaterialCategory,
} from '../types/supportingMaterials';

interface UploadingFile {
  tempId: string;
  fileName: string;
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  fileId?: number;
}

export interface SupportingMaterialsTableProps {
  materials: SupportingMaterial[];
  uploadingFiles: UploadingFile[];
  onDelete: (id: number) => void;
  onCategoryChange: (id: number, category: SupportingMaterialCategory) => void;
}

export function SupportingMaterialsTable({
  materials,
  uploadingFiles,
  onDelete,
  onCategoryChange,
}: SupportingMaterialsTableProps) {
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Filter out uploading files that already exist in materials as completed
  const filteredUploadingFiles = uploadingFiles.filter((uf) => {
    // If file has a fileId, check if it exists in materials
    if (uf.fileId) {
      return !materials.some((m) => m.id === uf.fileId);
    }
    // If no fileId yet, check by file name
    return !materials.some((m) => m.file_name === uf.fileName);
  });

  // Sort materials by updated_at
  const sortedMaterials = useMemo(() => {
    return [...materials].sort((a, b) => {
      const dateA = new Date(a.updated_at).getTime();
      const dateB = new Date(b.updated_at).getTime();
      return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });
  }, [materials, sortOrder]);

  const toggleSortOrder = () => {
    setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
  };

  const formatDate = (timestamp: string): string => {
    const date = new Date(timestamp);

    // Format: "Jan 15, 03:52"
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const day = date.getDate();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');

    return `${month} ${day}, ${hours}:${minutes}`;
  };

  const isRecentlyUpdated = (timestamp: string): boolean => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = diffMs / 3600000;
    return diffHours < 24; // Show green dot if updated within 24 hours
  };

  const handleCategoryChange = (id: number, event: React.ChangeEvent<HTMLSelectElement>) => {
    const newCategory = event.target.value;
    if (newCategory && newCategory !== '') {
      onCategoryChange(id, newCategory as SupportingMaterialCategory);
    }
  };

  const handleDelete = (id: number, fileName: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${fileName}"? This action cannot be undone.`
    );
    if (confirmed) {
      onDelete(id);
    }
  };

  if (materials.length === 0 && filteredUploadingFiles.length === 0) {
    return (
      <div className="supportingMaterialsEmpty">
        No supporting materials yet. Upload files to get started.
      </div>
    );
  }

  return (
    <div className="supportingMaterialsTableSection">
      <div className="supportingMaterialsTableHeader">
        <h3 className="supportingMaterialsTableTitle">
          Materials
        </h3>
      </div>

      <table className="materialsTable">
        <thead>
          <tr>
            <th>Name</th>
            <th
              className="sortable"
              onClick={toggleSortOrder}
              style={{ cursor: 'pointer' }}
            >
              Last updated {sortOrder === 'desc' ? '↑' : '↓'}
            </th>
            <th style={{ width: '180px' }}></th>
            <th style={{ width: '50px' }}></th>
          </tr>
        </thead>
        <tbody>
          {/* Uploading files first */}
          {filteredUploadingFiles.map((uploadingFile) => {
            return (
              <tr key={uploadingFile.tempId} className="uploadingRow">
                <td>
                  <span className="materialFileName">{uploadingFile.fileName}</span>
                </td>
                <td>
                  <div className="materialUpdatedAt materialUpdatedLoading">
                    <span className="materialLoadingDot" />
                    <span>Loading...</span>
                  </div>
                </td>
                <td>
                  <span className="materialTag">—</span>
                </td>
                <td></td>
              </tr>
            );
          })}

          {/* Regular materials */}
          {sortedMaterials.map((material) => {
            const isProcessing = material.upload_status === 'pending';

            return (
              <tr key={material.id} className={isProcessing ? 'uploadingRow' : ''}>
                <td>
                  <span className="materialFileName">{material.file_name}</span>
                </td>
                <td>
                  <div className="materialUpdatedAt">
                    {isProcessing ? (
                      <>
                        <span className="materialLoadingDot" />
                        <span>Loading...</span>
                      </>
                    ) : (
                      <>
                        {isRecentlyUpdated(material.updated_at) && (
                          <span className="materialUpdatedStatus" />
                        )}
                        <span>Updated: {formatDate(material.updated_at)}</span>
                      </>
                    )}
                  </div>
                </td>
                <td>
                  {isProcessing ? (
                    <span className="materialTag">—</span>
                  ) : (
                    <select
                      className="materialCategoryDropdown"
                      value={material.category || ''}
                      onChange={(e) => handleCategoryChange(material.id, e)}
                    >
                      <option value="">Select category</option>
                      <option value="reference">Reference</option>
                      <option value="note">Note</option>
                      <option value="proposal">Proposal</option>
                      <option value="other">Other</option>
                    </select>
                  )}
                </td>
                <td>
                  {!isProcessing && (
                    <button
                      className="materialDeleteButton"
                      onClick={() => handleDelete(material.id, material.file_name)}
                      aria-label="Delete material"
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 20 20"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M8.33333 5V4.16667C8.33333 3.72464 8.50893 3.30072 8.82149 2.98816C9.13405 2.67559 9.55797 2.5 10 2.5C10.442 2.5 10.8659 2.67559 11.1785 2.98816C11.4911 3.30072 11.6667 3.72464 11.6667 4.16667V5M13.3333 5V15.8333C13.3333 16.2754 13.1577 16.6993 12.8452 17.0118C12.5326 17.3244 12.1087 17.5 11.6667 17.5H8.33333C7.8913 17.5 7.46738 17.3244 7.15482 17.0118C6.84226 16.6993 6.66667 16.2754 6.66667 15.8333V5M5 5H15"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
