import React from 'react';
import { DiffResponse } from '../../services/projectsApi';
import SplitDiffViewer from './SplitDiffViewer';

interface DiffModalProps {
  diffData: DiffResponse | null;
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
}

const DiffModal: React.FC<DiffModalProps> = ({ diffData, onClose, isLoading = false, error = null }) => {

  return (
    <div className="diffModalOverlay" onClick={onClose}>
      <div
        className="diffModalContainer"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="diffModalClose" onClick={onClose}>
          ×
        </button>

        <div className="diffModalContent">
          {/* Title */}
          <h1 className="diffModalTitle">
            {diffData?.title || 'Manuscript Changes'}
          </h1>

          {/* Metadata */}
          {diffData?.manuscript_name && (
            <div className="diffMetadata">
              <span className="diffManuscriptName">{diffData.manuscript_name}</span>
              {diffData.modified_date && (
                <span className="diffModifiedDate">
                  {new Date(diffData.modified_date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </div>
          )}

          {/* Loading/Error states */}
          {isLoading ? (
            <div className="diffLoadingState">Loading changes...</div>
          ) : error ? (
            <div className="diffErrorState">{error}</div>
          ) : !diffData?.diff ? (
            <div className="diffEmptyState">No changes to display</div>
          ) : (
            /* Split Diff Viewer */
            <div className="diffContainer">
              <SplitDiffViewer diffText={diffData.diff} />
            </div>
          )}

          {/* Close button */}
          <div className="diffModalFooter">
            <button className="diffModalCloseButton" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiffModal;
