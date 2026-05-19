import React, { useEffect, useState } from 'react';
import './WorkspaceOnboarding.css';
import { FolderOpenIcon, CloudIcon, LayoutGridIcon, InfoIcon, ArrowRightIcon, XIcon, PlusIcon } from 'lucide-react';
import { GoogleDrivePicker } from './GoogleDrivePicker';
import { MAX_WORKSPACE_DIRECTORIES } from '../../shared/paths';

interface WorkspaceOnboardingProps {
  onComplete: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

const WorkspaceOnboarding: React.FC<WorkspaceOnboardingProps> = ({ onComplete, onSkip, onBack }) => {
  const [directoryPaths, setDirectoryPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [driveItemCount, setDriveItemCount] = useState(0);
  const [pendingDriveItems, setPendingDriveItems] = useState<Array<{ id: string; name: string; mimeType: string; path: string }>>([]);

  useEffect(() => {
    window.workspacesAPI.listDirectories().then((dirs) => {
      if (dirs.length > 0) {
        setDirectoryPaths(dirs.map(d => d.directory_path));
      }
    });
  }, []);

  const handleSelectFolder = async () => {
    const selected = await window.workspacesAPI.selectDirectory();
    if (selected) {
      if (directoryPaths.includes(selected)) {
        setError('This directory is already added.');
        return;
      }
      if (directoryPaths.length >= MAX_WORKSPACE_DIRECTORIES) {
        setError(`Maximum of ${MAX_WORKSPACE_DIRECTORIES} directories reached.`);
        return;
      }
      setDirectoryPaths(prev => [...prev, selected]);
      setError(null);
    }
  };

  const handleRemoveDirectory = (index: number) => {
    setDirectoryPaths(prev => prev.filter((_, i) => i !== index));
    setError(null);
  };

  const createWorkspace = async (callback: () => void) => {
    if ((directoryPaths.length === 0 && driveItemCount === 0) || isCreating) return;
    setError(null);
    setIsCreating(true);
    try {
      const name = directoryPaths.length > 0
        ? directoryPaths[0].split('/').filter(Boolean).pop() || 'My Workspace'
        : 'My Workspace';
      await window.workspacesAPI.create({ name, directoryPaths });
      if (pendingDriveItems.length > 0) {
        await window.googleDriveAPI.saveSelection({
          selectedItems: pendingDriveItems,
          connectedAt: new Date().toISOString(),
        });
      }
      callback();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create workspace.';
      setError(message);
      setIsCreating(false);
    }
  };

  const handleContinue = () => createWorkspace(onComplete);
  const handleSkip = () => createWorkspace(onSkip);

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

      <div className="wsSetup__body">
        <div className="wsSetup__inner">
          <p className="wsSetup__stepIndicator">STEP 1 OF 3 &middot; POINT ME AT YOUR WORK</p>

        <h1 className="wsSetup__title">Where does your research live?</h1>
        <p className="wsSetup__subtitle">Connect at least one source so I can read your work.</p>

        <div className="wsSetup__infoBanner">
          <InfoIcon className="wsSetup__infoIcon" />
          <span>This process will only read your files, not modify them.</span>
        </div>

        <div className="wsSetup__sources">
          {/* Folders on your computer — functional */}
          <div className={`wsSource${directoryPaths.length > 0 ? ' wsSource--selected' : ''}`}>
            <span className="wsSource__icon"><FolderOpenIcon size={18} /></span>
            <div className="wsSource__body">
              <div className="wsSource__titleRow">
                <h3 className="wsSource__title">Folders on your computer</h3>
                <span className="wsSource__badge">RECOMMENDED</span>
              </div>
              {directoryPaths.length > 0 ? (
                <>
                  <div className="wsSource__pathList">
                    {directoryPaths.map((dp, i) => (
                      <div key={dp} className="wsSource__pathItem">
                        <span className="wsSource__path">{dp}</span>
                        <button
                          type="button"
                          className="wsSource__removeBtn"
                          onClick={() => handleRemoveDirectory(i)}
                          aria-label="Remove directory"
                        >
                          <XIcon size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {directoryPaths.length < MAX_WORKSPACE_DIRECTORIES && (
                    <button type="button" className="wsSource__addMoreBtn" onClick={handleSelectFolder}>
                      <PlusIcon size={14} />
                      Add another folder
                    </button>
                  )}
                </>
              ) : (
                <div className="wsSource__emptyState">
                <p className="wsSource__desc">Select one or more folders where your research lives.</p>
                <button type="button" className="wsSource__browseBtn" onClick={handleSelectFolder}>
                  <FolderOpenIcon size={14} />
                  Browse folders
                </button>
                <p className="wsSource__hint">Most researchers start here</p>
              </div>
              )}
            </div>
          </div>

          {/* Cloud document services — Google Drive */}
          <div className={`wsSource${driveItemCount > 0 ? ' wsSource--selected' : ''}`}>
            <span className="wsSource__icon"><CloudIcon size={18} /></span>
            <div className="wsSource__body">
              <h3 className="wsSource__title">Google Drive</h3>
              {driveItemCount > 0 ? (
                <>
                  <div className="wsSource__pathList">
                    {pendingDriveItems.map((item) => (
                      <div key={item.id} className="wsSource__pathItem">
                        <span className="wsSource__path">{item.name}</span>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="wsSource__addMoreBtn" onClick={() => setDrivePickerOpen(true)}>
                    Manage selection
                  </button>
                </>
              ) : (
                <div className="wsSource__emptyState">
                  <p className="wsSource__desc">Connect Google Drive to give your workspace access to cloud files.</p>
                  <button type="button" className="wsSource__browseBtn" onClick={() => setDrivePickerOpen(true)}>
                    <CloudIcon size={14} />
                    Connect Google Drive
                  </button>
                  <p className="wsSource__hint">Optional</p>
                </div>
              )}
            </div>
          </div>
          <GoogleDrivePicker
            open={drivePickerOpen}
            onOpenChange={setDrivePickerOpen}
            skipSave
            onSelectionSaved={(items) => { setPendingDriveItems(items); setDriveItemCount(items.length); }}
          />

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
          disabled={(directoryPaths.length === 0 && driveItemCount === 0) || isCreating}
          onClick={handleContinue}
        >
          {isCreating ? 'Setting up...' : <>Continue <ArrowRightIcon className="wsSetup__arrow" /></>}
        </button>

          {(directoryPaths.length > 0 || driveItemCount > 0) && (
            <button
              type="button"
              className="wsSetup__skipBtn"
              disabled={isCreating}
              onClick={handleSkip}
            >
              Skip for now
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default WorkspaceOnboarding;
