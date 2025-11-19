import React, { useState, useEffect } from 'react';
import { IPC_CHANNELS } from '../../shared/types';
import MSWordIcon from '../../assets/images/MSWordIcon.png';

interface CreateProjectWizardProps {
  onClose: () => void;
  onComplete: (data: ProjectCreationData) => void;
}

export interface ProjectCreationData {
  name: string;
  description?: string;
  folders: string[];
  primaryManuscriptPath?: string;
  collaboratorEmails: string[];
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
}) => {
  const [step, setStep] = useState(1);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [selectedFolderPaths, setSelectedFolderPaths] = useState<string[]>([]);
  const [availableFiles, setAvailableFiles] = useState<LocalFile[]>([]);
  const [selectedManuscriptPath, setSelectedManuscriptPath] = useState<string | null>(null);
  const [collaboratorEmail, setCollaboratorEmail] = useState('');
  const [collaboratorEmails, setCollaboratorEmails] = useState<string[]>([]);
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

      // Scan selected folders for files
      if (selectedFolderPaths.length > 0) {
        const files = await window.electronAPI.invoke(IPC_CHANNELS.SCAN_FOLDER_FOR_FILES, selectedFolderPaths);
        console.log('[Wizard] Scanned files from folders:', files);
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

      // Add to selected folders (will be synced when project is created)
      if (!selectedFolderPaths.includes(folderPath)) {
        setSelectedFolderPaths([...selectedFolderPaths, folderPath]);
      }
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
      if (selectedFolderPaths.length === 0) {
        setError('Please select at least one folder');
        return;
      }
      setStep(3);
    } else if (step === 3) {
      if (!selectedManuscriptPath) {
        setError('Please select a primary manuscript');
        return;
      }
      setStep(4);
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
      // Skip manuscript selection
      setStep(4);
    } else if (step === 4) {
      handleComplete();
    }
  };

  const handleComplete = () => {
    onComplete({
      name: projectName,
      description: projectDescription,
      folders: selectedFolderPaths,
      primaryManuscriptPath: selectedManuscriptPath || undefined,
      collaboratorEmails,
    });
  };

  const toggleFolder = (folderPath: string) => {
    if (selectedFolderPaths.includes(folderPath)) {
      setSelectedFolderPaths(selectedFolderPaths.filter((p) => p !== folderPath));
    } else {
      setSelectedFolderPaths([...selectedFolderPaths, folderPath]);
    }
  };

  const handleAddCollaborator = () => {
    // RFC-compliant email validation regex
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    const trimmedEmail = collaboratorEmail.trim();

    if (trimmedEmail &&
        trimmedEmail.length <= 254 &&
        emailRegex.test(trimmedEmail)) {
      setCollaboratorEmails([...collaboratorEmails, trimmedEmail]);
      setCollaboratorEmail('');
    }
  };

  const handleRemoveCollaborator = (email: string) => {
    setCollaboratorEmails(collaboratorEmails.filter((e) => e !== email));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (step === 4) {
        handleAddCollaborator();
      } else {
        handleNext();
      }
    }
  };

  return (
    <div className="wizardOverlay" onClick={onClose}>
      <div className="wizardModal" onClick={(e) => e.stopPropagation()}>
        <button className="wizardClose" onClick={onClose}>
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
              <div className="wizardSection">
                <p className="wizardSectionTitle">
                  Add folders your project will read from
                </p>
                <button className="wizardAddButton" onClick={handleNext}>
                  + Select folders
                </button>
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
                  Add folders your project will read from
                </p>
                {loading && <div className="wizardLoading">Loading folders...</div>}
                <div className="folderList">
                  {selectedFolderPaths.length > 0 && (
                    <div className="selectedFolders">
                      {selectedFolderPaths.map((folderPath) => {
                        const folderName = folderPath.split('/').pop() || folderPath;

                        return (
                          <div key={folderPath} className="selectedFolderItem">
                            <span className="folderIcon">📁</span>
                            <span className="folderName">{folderName}</span>
                            <button
                              className="folderRemove"
                              onClick={() => toggleFolder(folderPath)}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <button
                    className="wizardAddButton"
                    onClick={handleSelectFolder}
                  >
                    + Select folders
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
            <div className="wizardActions">
              <button className="wizardButtonSecondary" onClick={handleBack}>
                Back
              </button>
              <button className="wizardButtonText" onClick={handleSkip}>
                Skip
              </button>
              <button
                className="wizardButtonPrimary"
                onClick={handleNext}
                disabled={!selectedManuscriptPath}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Invite Collaborators */}
        {step === 4 && (
          <div className="wizardContent">
            <h2 className="wizardTitle">Last step: Invite collaborators</h2>
            <div className="wizardForm">
              <div className="wizardSection">
                <p className="wizardSectionTitle">
                  Add collaborators to your project (optional)
                </p>
                <div className="collaboratorInput">
                  <input
                    type="email"
                    value={collaboratorEmail}
                    onChange={(e) => setCollaboratorEmail(e.target.value)}
                    placeholder="Enter email address"
                    onKeyPress={handleKeyPress}
                  />
                  <button
                    className="wizardAddButton"
                    onClick={handleAddCollaborator}
                  >
                    + Add collaborator
                  </button>
                </div>
                {collaboratorEmails.length > 0 && (
                  <div className="collaboratorsList">
                    {collaboratorEmails.map((email, index) => (
                      <div key={index} className="collaboratorItem">
                        <span className="collaboratorEmail">{email}</span>
                        <button
                          className="collaboratorRemove"
                          onClick={() => handleRemoveCollaborator(email)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="wizardActions">
              <button className="wizardButtonSecondary" onClick={handleBack}>
                Back
              </button>
              <button className="wizardButtonText" onClick={handleSkip}>
                Skip
              </button>
              <button className="wizardButtonPrimary" onClick={handleComplete}>
                Create Project
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CreateProjectWizard;
