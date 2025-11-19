import React from 'react';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';

/**
 * ManuscriptVersionCard Component
 *
 * Displays the primary manuscript file for a project in a styled card.
 * Shows the document icon and filename.
 */

interface ManuscriptVersionCardProps {
  fileName: string;
  isLoading?: boolean;
}

const ManuscriptVersionCard: React.FC<ManuscriptVersionCardProps> = ({
  fileName,
  isLoading = false
}) => {
  if (isLoading) {
    return (
      <div className="manuscriptVersionContainer">
        <div className="manuscriptVersionContent">
          <div className="manuscriptVersionHeader">
            <p className="manuscriptVersionTitle">Latest manuscript version</p>
          </div>
          <div className="manuscriptVersionCard">
            <div className="manuscriptFileRow">
              <span className="manuscriptFileLoading">Loading...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="manuscriptVersionContainer">
      <div className="manuscriptVersionContent">
        <div className="manuscriptVersionHeader">
          <p className="manuscriptVersionTitle">Latest manuscript version</p>
        </div>
        <div className="manuscriptVersionCard">
          <div className="manuscriptFileRow">
            <div className="manuscriptFileIcon">
              <img src={MSWordIcon} alt="Word document" />
            </div>
            <span className="manuscriptFileName">{fileName}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManuscriptVersionCard;
