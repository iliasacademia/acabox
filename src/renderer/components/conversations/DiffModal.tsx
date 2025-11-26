import React, { useMemo } from 'react';
import { parseDiff, Diff, Hunk, tokenize } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';

interface DiffModalProps {
  diffData: string; // Git diff output as a string
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
}

const DiffModal: React.FC<DiffModalProps> = ({ diffData, onClose, isLoading = false, error = null }) => {
  // Parse the git diff string into structured data
  const files = useMemo(() => {
    if (!diffData || typeof diffData !== 'string') {
      console.log('[DiffModal] No valid diff data to parse');
      return [];
    }

    try {
      console.log('[DiffModal] Parsing git diff:', diffData.substring(0, 200));
      const parsed = parseDiff(diffData);
      console.log('[DiffModal] Parsed files:', parsed);
      return parsed;
    } catch (err) {
      console.error('[DiffModal] Failed to parse diff:', err);
      return [];
    }
  }, [diffData]);

  // Tokenize changes for word-level highlighting
  const renderFile = (file: any) => {
    const tokens = tokenize(file.hunks);

    return (
      <div key={file.oldRevision + '-' + file.newRevision} className="diffFileSection">
        <div className="diffFileName">
          {file.type === 'delete' && (
            <span className="diffFileNameOld">- {file.oldPath}</span>
          )}
          {file.type === 'add' && (
            <span className="diffFileNameNew">+ {file.newPath}</span>
          )}
          {file.type === 'modify' && (
            <span>{file.newPath}</span>
          )}
          {file.type === 'rename' && (
            <span>{file.oldPath} → {file.newPath}</span>
          )}
        </div>
        <Diff
          viewType="split"
          diffType={file.type}
          hunks={file.hunks}
          tokens={tokens}
        >
          {(hunks) => hunks.map((hunk) => (
            <Hunk key={hunk.content} hunk={hunk} />
          ))}
        </Diff>
      </div>
    );
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  };

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
            Manuscript Changes
          </h1>

          {/* Loading/Error states */}
          {isLoading ? (
            <div className="diffLoadingState">Loading changes...</div>
          ) : error ? (
            <div className="diffErrorState">{error}</div>
          ) : !diffData || files.length === 0 ? (
            <div className="diffEmptyState">No changes to display</div>
          ) : (
            /* Diff Container */
            <div className="diffContainer">
              {files.map(renderFile)}
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
