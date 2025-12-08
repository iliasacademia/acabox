import React, { useState, useEffect } from 'react';
import { IPC_CHANNELS } from '../../shared/types';
import MSWordIcon from '../../assets/images/MSWordIcon.png';

interface CreateProjectWizardProps {
  onClose: () => void;
  onComplete: (data: ProjectCreationData) => void;
  isCreating?: boolean;
}

export interface ProjectCreationData {
  name: string;
  description?: string;
  folder?: string; // Single folder path
  primaryManuscriptPath?: string;
  collaboratorEmails?: string[];
}

interface LocalFile {
  path: string;
  name: string;
  relativePath: string;
  folderPath: string;
}

const CreateProjectWizard: React.FC<CreateProjectWizardProps> = ({
  onClose,
  onComplete,
  isCreating = false,
}) => {
  const [step, setStep] = useState(1);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>(''); // Single folder
  const [availableFiles, setAvailableFiles] = useState<LocalFile[]>([]);
  const [selectedManuscriptPath, setSelectedManuscriptPath] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Load files when step 3 is reached
  useEffect(() => {
    if (step === 3) {
      loadFiles();
    }
  }, [step]);

  const loadFiles = async () => {
    try {
      setLoading(true);

      // Scan selected folder for files
      if (selectedFolderPath) {
        const files = await window.electronAPI.invoke(IPC_CHANNELS.SCAN_FOLDER_FOR_FILES, [selectedFolderPath]);
        console.log('[Wizard] Scanned files from folder:', files);
        setAvailableFiles(files || []);
      } else {
        setAvailableFiles([]);
      }
    } catch (err: any) {
      console.error('Failed to load files:', err);
      setError('Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = async () => {
    try {
      setError('');

      // Open folder selection dialog
      const folderPath = await window.electronAPI.invoke(IPC_CHANNELS.SELECT_FOLDER);

      if (!folderPath) {
        return; // User cancelled
      }

      // Set the single selected folder
      setSelectedFolderPath(folderPath);
    } catch (err: any) {
      console.error('Failed to select folder:', err);
      setError('Failed to select folder');
    }
  };

  const handleNext = () => {
    setError('');

    if (step === 1) {
      if (!projectName.trim()) {
        setError('Project name is required');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!selectedFolderPath) {
        setError('Please select a folder');
        return;
      }
      setStep(3);
    } else if (step === 3) {
      if (!selectedManuscriptPath) {
        setError('Please select a primary manuscript');
        return;
      }
      handleComplete();
    }
  };

  const handleBack = () => {
    setError('');
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const handleSkip = () => {
    setError('');
    if (step === 3) {
      // Skip manuscript selection and complete
      handleComplete();
    }
  };

  const handleComplete = () => {
    onComplete({
      name: projectName,
      description: projectDescription,
      folder: selectedFolderPath || undefined,
      primaryManuscriptPath: selectedManuscriptPath || undefined,
      collaboratorEmails: [],
    });
  };

  const clearFolder = () => {
    setSelectedFolderPath('');
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNext();
    }
  };

  return (
    <div className="wizardOverlay" onClick={isCreating ? undefined : onClose}>
      <div className="wizardModal" onClick={(e) => e.stopPropagation()}>
        <button
          className="wizardClose"
          onClick={onClose}
          disabled={isCreating}
          style={{ opacity: isCreating ? 0.5 : 1, cursor: isCreating ? 'not-allowed' : 'pointer' }}
        >
          ×
        </button>

        {/* Step 1: Project Name */}
        {step === 1 && (
          <div className="wizardContent">
            <h2 className="wizardTitle">Create new project</h2>
            <div className="wizardForm">
              <div className="formGroup">
                <label htmlFor="projectName">Project name</label>
                <input
                  id="projectName"
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Enter project name"
                  onKeyPress={handleKeyPress}
                  autoFocus
                />
              </div>
              <div className="formGroup">
                <label htmlFor="projectDescription">
                  Description (optional)
                </label>
                <textarea
                  id="projectDescription"
                  value={projectDescription}
                  onChange={(e) => setProjectDescription(e.target.value)}
                  placeholder="Enter project description"
                  rows={3}
                />
              </div>
            </div>
            {error && <div className="wizardError">{error}</div>}
            <div className="wizardActions">
              <button className="wizardButtonSecondary" onClick={onClose}>
                Cancel
              </button>
              <button className="wizardButtonPrimary" onClick={handleNext}>
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Select Folders */}
        {step === 2 && (
          <div className="wizardContent">
            <h2 className="wizardTitle">Create new project</h2>
            <div className="wizardForm">
              <div className="wizardSection">
                <p className="wizardSectionTitle">
                  Select a folder your project will read from
                </p>
                {loading && <div className="wizardLoading">Loading folder...</div>}
                <div className="folderList">
                  {selectedFolderPath && (
                    <div className="selectedFolders">
                      <div className="selectedFolderItem">
                        <span className="folderIcon">📁</span>
                        <span className="folderName">
                          {selectedFolderPath.split('/').pop() || selectedFolderPath}
                        </span>
                        <button
                          className="folderRemove"
                          onClick={clearFolder}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    className="wizardAddButton"
                    onClick={handleSelectFolder}
                    disabled={!!selectedFolderPath}
                  >
                    {selectedFolderPath ? '✓ Folder selected' : '+ Select folder'}
                  </button>
                </div>
              </div>
            </div>
            {error && <div className="wizardError">{error}</div>}
            <div className="wizardActions">
              <button className="wizardButtonSecondary" onClick={handleBack}>
                Back
              </button>
              <button className="wizardButtonPrimary" onClick={handleNext}>
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Select Manuscript */}
        {step === 3 && (
          <div className="wizardContent">
            <h2 className="wizardTitle">Select your primary manuscript</h2>
            <div className="wizardForm">
              {loading && <div className="wizardLoading">Loading files...</div>}
              <div className="manuscriptList">
                {availableFiles.length === 0 && !loading && (
                  <div className="wizardEmpty">
                    No synced files found. Add folders with documents to see them here.
                  </div>
                )}
                {availableFiles.map((file) => (
                  <div
                    key={file.path}
                    className={`manuscriptItem ${
                      selectedManuscriptPath === file.path ? 'selected' : ''
                    }`}
                    onClick={() => setSelectedManuscriptPath(file.path)}
                  >
                    <span className="fileIcon">
                      <img src={MSWordIcon} alt="Word document" />
                    </span>
                    <div className="fileName">
                      <span>{file.name}</span>
                      <span className="fileRelPath">{file.relativePath}</span>
                    </div>
                    <input
                      type="radio"
                      checked={selectedManuscriptPath === file.path}
                      onChange={() => setSelectedManuscriptPath(file.path)}
                    />
                  </div>
                ))}
              </div>
            </div>
            {error && <div className="wizardError">{error}</div>}
            {isCreating && <div className="wizardLoading">Creating your project...</div>}
            <div className="wizardActions">
              <button className="wizardButtonSecondary" onClick={handleBack} disabled={isCreating}>
                Back
              </button>
              <button className="wizardButtonText" onClick={handleSkip} disabled={isCreating}>
                Skip
              </button>
              <button
                className="wizardButtonPrimary"
                onClick={handleNext}
                disabled={!selectedManuscriptPath || isCreating}
              >
                {isCreating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default CreateProjectWizard;
