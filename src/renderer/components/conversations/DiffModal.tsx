import React, { useMemo } from 'react';
import { parseDiff, Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface DiffModalProps {
  diffString: string;
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
}

const DiffModal: React.FC<DiffModalProps> = ({ diffString, onClose, isLoading = false, error = null }) => {
  const files = useMemo(() => {
    try {
      return parseDiff(diffString);
    } catch (error) {
      console.error('Error parsing diff:', error);
      return [];
    }
  }, [diffString]);

  return (
    <div className="wizardOverlay" onClick={onClose}>
      <div
        className="diffModal"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="wizardClose" onClick={onClose}>
          ×
        </button>

        <div className="wizardContent">
          <h2 className="wizardTitle">Manuscript Changes</h2>

          <div className="diffContainer">
            {isLoading ? (
              <div className="wizardLoading">Loading diff...</div>
            ) : error ? (
              <div className="wizardError">{error}</div>
            ) : files.length === 0 ? (
              <p className="diffEmptyState">No changes to display</p>
            ) : (
              files.map((file, index) => (
                <div key={index} className="diffFileSection">
                  <Diff
                    viewType="split"
                    diffType={file.type}
                    hunks={file.hunks || []}
                  >
                    {(hunks) =>
                      hunks.map((hunk) => (
                        <Hunk key={hunk.content} hunk={hunk} />
                      ))
                    }
                  </Diff>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiffModal;
