import React, { useState, useMemo } from 'react';
import {
  SupportingMaterial,
  SupportingMaterialCategory,
} from '../types/supportingMaterials';

export interface SupportingMaterialsTableProps {
  materials: SupportingMaterial[];
  onDelete: (id: number) => void;
  onCategoryChange: (id: number, category: SupportingMaterialCategory) => void;
}

export function SupportingMaterialsTable({
  materials,
  onDelete,
  onCategoryChange,
}: SupportingMaterialsTableProps) {
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

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
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 5) {
      return 'Just now';
    } else if (diffMins < 60) {
      return `${diffMins} min ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
    }
  };

  const isRecentlyUpdated = (timestamp: string): boolean => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = diffMs / 3600000;
    return diffHours < 24; // Show green dot if updated within 24 hours
  };

  const handleCategoryChange = (id: number, event: React.ChangeEvent<HTMLSelectElement>) => {
    const newCategory = event.target.value as SupportingMaterialCategory;
    onCategoryChange(id, newCategory);
  };

  const handleDelete = (id: number, fileName: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${fileName}"? This action cannot be undone.`
    );
    if (confirmed) {
      onDelete(id);
    }
  };

  if (materials.length === 0) {
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
          Materials ({materials.length})
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
              Last updated {sortOrder === 'desc' ? '↓' : '↑'}
            </th>
            <th>Category</th>
            <th style={{ width: '50px' }}></th>
          </tr>
        </thead>
        <tbody>
          {sortedMaterials.map((material) => (
            <tr key={material.id}>
              <td>
                <span className="materialFileName">{material.file_name}</span>
              </td>
              <td>
                <div className="materialUpdatedAt">
                  {isRecentlyUpdated(material.updated_at) && (
                    <span className="materialUpdatedStatus" />
                  )}
                  Updated: {formatDate(material.updated_at)}
                </div>
              </td>
              <td>
                <select
                  className="materialCategoryDropdown"
                  value={material.category}
                  onChange={(e) => handleCategoryChange(material.id, e)}
                >
                  <option value="reference">Reference</option>
                  <option value="note">Note</option>
                  <option value="proposal">Proposal</option>
                  <option value="other">Other</option>
                </select>
              </td>
              <td>
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
