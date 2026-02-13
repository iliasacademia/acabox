import React from 'react';
import './Projects.css';

interface SupportingMaterialsModalProps {
  onAdd: () => void;
  onSkip: () => void;
  isCreating?: boolean;
}

const SupportingMaterialsModal: React.FC<SupportingMaterialsModalProps> = ({
  onAdd,
  onSkip,
  isCreating = false,
}) => {
  return (
    <div className="wizardOverlay">
      <div className="wizardModal">
        <button className="wizardClose" onClick={onSkip} disabled={isCreating}>
          &times;
        </button>
        {isCreating ? (
          <div className="wizardContent wizardLoading">
            <div className="loadingSpinner" />
            <p>Creating project...</p>
          </div>
        ) : (
          <div className="wizardContent">
            <h2 className="wizardTitle">Improve reviews by adding supporting materials</h2>
            <p style={{ fontSize: '16px', color: '#535366', lineHeight: '24px', margin: 0 }}>
              Add supplementary materials by connecting your Zotero account or uploading files.
            </p>
            <div className="supportingMaterialsActions">
              <button className="wizardButtonPrimary" onClick={onAdd}>
                Add supporting materials
              </button>
              <button className="wizardButtonSecondary" onClick={onSkip}>
                Maybe later
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SupportingMaterialsModal;
