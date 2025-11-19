import React, { useMemo } from 'react';
import { parseDiff, Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface DiffModalProps {
  diffString: string;
  onClose: () => void;
}

const DiffModal: React.FC<DiffModalProps> = ({ diffString, onClose }) => {
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
          <h2 className="wizardTitle">Differences (Mock Data)</h2>

          <div className="diffContainer">
            {files.length === 0 ? (
              <p className="diffEmptyState">No changes to display</p>
            ) : (
              files.map((file, index) => (
                <div key={index} className="diffFileSection">
                  <div className="diffFileName">
                    <span className="diffFileNameOld">{file.oldPath}</span>
                    {file.oldPath !== file.newPath && (
                      <>
                        {' → '}
                        <span className="diffFileNameNew">{file.newPath}</span>
                      </>
                    )}
                  </div>
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
