import React, { useState } from 'react';
import { ProjectFile, ProjectFolder } from '../services/mockProjectsApi';

interface CreateProjectWizardProps {
  onClose: () => void;
  onComplete: (data: ProjectCreationData) => void;
}

export interface ProjectCreationData {
  name: string;
  description?: string;
  folders: string[];
  primaryManuscriptId?: number;
  collaboratorEmails: string[];
}

// Dummy data for demonstration
const AVAILABLE_FOLDERS: ProjectFolder[] = [
  {
    id: 1,
    project_id: 0,
    folder_name: 'Protocols',
    folder_path: '/Users/researcher/Documents/Protocols',
    file_count: 16,
    created_at: new Date().toISOString(),
    synced: true,
  },
  {
    id: 2,
    project_id: 0,
    folder_name: 'Sequencing-Results-2024',
    folder_path: '/Users/researcher/Documents/Sequencing-Results-2024',
    file_count: 8,
    created_at: new Date().toISOString(),
    synced: true,
  },
];

const AVAILABLE_FILES: ProjectFile[] = [
  {
    id: 1,
    project_id: 0,
    file_name: 'draft_manuscript_v0.3',
    file_type: 'manuscript',
    file_path: '/manuscripts/draft_manuscript_v0.3.docx',
    size: 2048576,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_primary_manuscript: false,
  },
  {
    id: 2,
    project_id: 0,
    file_name: 'genes_expression',
    file_type: 'data',
    file_path: '/data/genes_expression.csv',
    size: 5242880,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_primary_manuscript: false,
  },
  {
    id: 3,
    project_id: 0,
    file_name: 'micro_analysis',
    file_type: 'data',
    file_path: '/data/micro_analysis.xlsx',
    size: 3145728,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_primary_manuscript: false,
  },
];

const CreateProjectWizard: React.FC<CreateProjectWizardProps> = ({
  onClose,
  onComplete,
}) => {
  const [step, setStep] = useState(1);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [selectedFolders, setSelectedFolders] = useState<number[]>([]);
  const [selectedManuscript, setSelectedManuscript] = useState<number | null>(
    null
  );
  const [collaboratorEmail, setCollaboratorEmail] = useState('');
  const [collaboratorEmails, setCollaboratorEmails] = useState<string[]>([]);
  const [error, setError] = useState('');

  const handleNext = () => {
    setError('');

    if (step === 1) {
      if (!projectName.trim()) {
        setError('Project name is required');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    } else if (step === 3) {
      if (!selectedManuscript) {
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
    if (step === 4) {
      handleComplete();
    }
  };

  const handleComplete = () => {
    const folders = selectedFolders.map(
      (id) =>
        AVAILABLE_FOLDERS.find((f) => f.id === id)?.folder_path || ''
    );

    onComplete({
      name: projectName,
      description: projectDescription,
      folders,
      primaryManuscriptId: selectedManuscript || undefined,
      collaboratorEmails,
    });
  };

  const toggleFolder = (folderId: number) => {
    if (selectedFolders.includes(folderId)) {
      setSelectedFolders(selectedFolders.filter((id) => id !== folderId));
    } else {
      setSelectedFolders([...selectedFolders, folderId]);
    }
  };

  const handleAddCollaborator = () => {
    if (collaboratorEmail && collaboratorEmail.includes('@')) {
      setCollaboratorEmails([...collaboratorEmails, collaboratorEmail]);
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
                <div className="folderList">
                  {selectedFolders.length > 0 && (
                    <div className="selectedFolders">
                      {selectedFolders.map((folderId) => {
                        const folder = AVAILABLE_FOLDERS.find(
                          (f) => f.id === folderId
                        );
                        return folder ? (
                          <div key={folder.id} className="selectedFolderItem">
                            <span className="folderIcon">📁</span>
                            <span className="folderName">
                              {folder.folder_name} ({folder.file_count} files)
                            </span>
                            <button
                              className="folderRemove"
                              onClick={() => toggleFolder(folder.id)}
                            >
                              ×
                            </button>
                          </div>
                        ) : null;
                      })}
                    </div>
                  )}
                  <button
                    className="wizardAddButton"
                    onClick={() => {
                      // Toggle first folder for demo
                      if (AVAILABLE_FOLDERS.length > 0) {
                        toggleFolder(AVAILABLE_FOLDERS[0].id);
                      }
                    }}
                  >
                    + Select folders
                  </button>
                </div>
              </div>
            </div>
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
              <div className="manuscriptList">
                {AVAILABLE_FILES.map((file) => (
                  <div
                    key={file.id}
                    className={`manuscriptItem ${
                      selectedManuscript === file.id ? 'selected' : ''
                    }`}
                    onClick={() => setSelectedManuscript(file.id)}
                  >
                    <span className="fileIcon">📄</span>
                    <span className="fileName">{file.file_name}</span>
                    <input
                      type="radio"
                      checked={selectedManuscript === file.id}
                      onChange={() => setSelectedManuscript(file.id)}
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
              <button className="wizardButtonPrimary" onClick={handleNext}>
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
