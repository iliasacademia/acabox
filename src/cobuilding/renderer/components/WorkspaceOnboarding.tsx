import React, { useEffect, useState } from 'react';
import './WorkspaceOnboarding.css';
import { FolderOpenIcon, CloudIcon, LayoutGridIcon, InfoIcon } from 'lucide-react';

interface WorkspaceOnboardingProps {
  onComplete: () => void;
  onBack?: () => void;
}

const WorkspaceOnboarding: React.FC<WorkspaceOnboardingProps> = ({ onComplete, onBack }) => {
  const [directoryPath, setDirectoryPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    window.workspacesAPI.getActive().then((ws) => {
      if (ws) {
        setDirectoryPath(ws.directory_path);
      }
    });
  }, []);

  const handleSelectFolder = async () => {
    const selected = await window.workspacesAPI.selectDirectory();
    if (selected) {
      setDirectoryPath(selected);
      setError(null);
    }
  };

  const handleContinue = async () => {
    if (!directoryPath || isCreating) return;
    setError(null);
    setIsCreating(true);
    try {
      const name = directoryPath.split('/').filter(Boolean).pop() || 'My Workspace';
      await window.workspacesAPI.create({ name, directoryPath });
      onComplete();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create workspace.';
      setError(message);
      setIsCreating(false);
    }
  };

  return (
    <div className="wsSetup">
      <div className="wsSetup__branding">
        {onBack && (
          <button className="wsSetup__backBtn" onClick={onBack}>
            &larr;
          </button>
        )}
        <span className="wsSetup__brandName">Co-scientist</span>
        <span className="wsSetup__brandLabel">SETUP</span>
      </div>

      <div className="wsSetup__inner">
        <p className="wsSetup__stepIndicator">STEP 1 OF 5 &middot; POINT ME AT YOUR WORK</p>

        <h1 className="wsSetup__title">Where does your research live?</h1>
        <p className="wsSetup__subtitle">Connect at least one source so I can read your work.</p>

        <div className="wsSetup__infoBanner">
          <InfoIcon className="wsSetup__infoIcon" />
          <span>This process will only read your files, not modify them.</span>
        </div>

        <div className="wsSetup__sources">
          {/* Folders on your computer — functional */}
          <button
            type="button"
            className={`wsSource${directoryPath ? ' wsSource--selected' : ''}`}
            onClick={handleSelectFolder}
          >
            <span className="wsSource__icon"><FolderOpenIcon size={18} /></span>
            <div className="wsSource__body">
              <div className="wsSource__titleRow">
                <h3 className="wsSource__title">Folders on your computer</h3>
                <span className="wsSource__badge">RECOMMENDED</span>
              </div>
              {directoryPath ? (
                <>
                  <p className="wsSource__path">{directoryPath}</p>
                  <span className="wsSource__change">Change</span>
                </>
              ) : (
                <>
                  <p className="wsSource__desc">Point me at the folders where your research lives.</p>
                  <p className="wsSource__hint">Most researchers start here</p>
                </>
              )}
            </div>
          </button>

          {/* Cloud document services — placeholder */}
          <div className="wsSource wsSource--disabled">
            <span className="wsSource__icon"><CloudIcon size={18} /></span>
            <div className="wsSource__body">
              <h3 className="wsSource__title">Cloud document services</h3>
              <p className="wsSource__desc">Google Drive, Google Docs, OneDrive, Dropbox.</p>
              <p className="wsSource__hint">Optional</p>
            </div>
          </div>

          {/* Reference manager — placeholder */}
          <div className="wsSource wsSource--disabled">
            <span className="wsSource__icon"><LayoutGridIcon size={18} /></span>
            <div className="wsSource__body">
              <h3 className="wsSource__title">Reference manager</h3>
              <p className="wsSource__desc">Zotero, Mendeley, or EndNote.</p>
              <p className="wsSource__hint">Optional &middot; highly recommended</p>
            </div>
          </div>
        </div>

        {error && <p className="wsSetup__error">{error}</p>}

        <button
          type="button"
          className="wsSetup__continueBtn"
          disabled={!directoryPath || isCreating}
          onClick={handleContinue}
        >
          {isCreating ? 'Setting up...' : <>Continue <span className="wsSetup__arrow">&rarr;</span></>}
        </button>
      </div>
    </div>
  );
};

export default WorkspaceOnboarding;
