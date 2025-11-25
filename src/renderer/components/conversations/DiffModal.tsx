import React from 'react';
import DOMPurify from 'isomorphic-dompurify';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';

interface DiffModalProps {
  diffData: any; // Will be the new JSON format from backend
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
}

interface DiffSection {
  section: string;
  original: string;
  edited: string;
}

const DiffModal: React.FC<DiffModalProps> = ({ diffData, onClose, isLoading = false, error = null }) => {
  // Debug logging
  console.log('[DiffModal] Received diffData:', diffData);
  if (diffData?.sections?.[0]) {
    console.log('[DiffModal] First section:', diffData.sections[0]);
    console.log('[DiffModal] First section edited text:', diffData.sections[0].edited);
    console.log('[DiffModal] Contains {+:', diffData.sections[0].edited?.includes('{+'));
  }

  // Helper to render text with word-level highlights
  const renderHighlightedText = (text: string) => {
    if (!text) return '';

    // Replace {+added text+} with green highlighted spans
    let highlighted = text.replace(/\{\+([^}]+)\+\}/g, '<span class="diff-word-added">$1</span>');

    // Replace [-deleted text-] with red strikethrough spans
    highlighted = highlighted.replace(/\[-([^\]]+)-\]/g, '<span class="diff-word-deleted">$1</span>');

    const sanitized = DOMPurify.sanitize(highlighted, {
      ALLOWED_TAGS: ['span'],
      ALLOWED_ATTR: ['class'],
    });

    return sanitized;
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
            {diffData?.title || `Manuscript edits on ${diffData?.date ? formatDate(diffData.date) : 'Unknown'}`}
          </h1>

          {/* Manuscript file info */}
          {diffData?.manuscript_name && (
            <div className="diffManuscriptInfo">
              <span className="diffManuscriptLabel">Draft manuscript:</span>
              <img src={MSWordIcon} alt="Word" className="diffManuscriptIcon" />
              <span className="diffManuscriptName">{diffData.manuscript_name}</span>
            </div>
          )}

          {/* Loading/Error states */}
          {isLoading ? (
            <div className="diffLoadingState">Loading changes...</div>
          ) : error ? (
            <div className="diffErrorState">{error}</div>
          ) : !diffData || !diffData.sections || diffData.sections.length === 0 ? (
            <div className="diffEmptyState">No changes to display</div>
          ) : (
            /* Sections */
            <div className="diffSections">
              {diffData.sections.map((section: DiffSection, idx: number) => (
                <div key={idx} className="diffSection">
                  <h2 className="diffSectionTitle">{section.section}</h2>

                  <div className="diffSectionContent">
                    {/* Original text column */}
                    <div className="diffColumn diffColumnOriginal">
                      <div className="diffColumnHeader">Original text</div>
                      <div className="diffColumnText diffColumnTextOriginal">
                        {section.original}
                      </div>
                    </div>

                    {/* Edited text column */}
                    <div className="diffColumn diffColumnEdited">
                      <div className="diffColumnHeader">Edits</div>
                      <div
                        className="diffColumnText diffColumnTextEdited"
                        dangerouslySetInnerHTML={{
                          __html: renderHighlightedText(section.edited)
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
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
