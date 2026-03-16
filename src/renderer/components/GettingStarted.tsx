import React, { useState, useEffect, useRef } from 'react';
import { IPC_CHANNELS } from '../../shared/types';
import { createProject, Project, extractErrorMessage } from '../services/projectsApi';
import {
  trackGettingStartedView,
  trackGettingStartedLoginClick,
  trackGettingStartedPermissionGranted,
  trackGettingStartedFilePickerOpen,
  trackGettingStartedProjectCreated,
} from '../utils/analytics';
import dockIcon from '../../assets/icons/dock-icon.png';
import './GettingStarted.css';

interface GettingStartedProps {
  isLoggedIn: boolean;
  hasPermission: boolean | null; // null = still checking
  onLoginRequired: () => void;
  onGrantPermission: () => void;
  onRestartApp: () => void;
  onComplete: (project: Project) => void;
}

const GettingStarted: React.FC<GettingStartedProps> = ({
  isLoggedIn,
  hasPermission,
  onLoginRequired,
  onGrantPermission,
  onRestartApp,
  onComplete,
}) => {
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);

  const permissionTrackedRef = useRef(hasPermission === true);

  useEffect(() => { trackGettingStartedView(); }, []);

  useEffect(() => {
    if (hasPermission === true && !permissionTrackedRef.current) {
      permissionTrackedRef.current = true;
      trackGettingStartedPermissionGranted();
    }
  }, [hasPermission]);

  const handleSelectManuscript = async () => {
    const filePath = await window.electronAPI.invoke(
      IPC_CHANNELS.SELECT_FILE,
      { extensions: ['docx'] }
    );
    if (!filePath) return;

    trackGettingStartedFilePickerOpen();
    setCreationError(null);
    setIsCreatingProject(true);
    try {
      const fileName = filePath.split('/').pop() ?? filePath;
      const projectName = fileName.replace(/\.docx$/i, '');
      const project = await createProject({ name: projectName, file_path: filePath });
      await window.electronAPI.invoke(IPC_CHANNELS.START_PROJECT_FILE_SYNC, project.id, filePath);
      await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);
      // Open Word in the background — do NOT await (shell.openPath takes seconds)
      window.electronAPI.invoke(IPC_CHANNELS.OPEN_FILE, filePath).catch(() => {});
      // Schedule popup auto-open so the overlay is expanded when Word first shows the document
      window.electronAPI.invoke(IPC_CHANNELS.SCHEDULE_POPUP_AUTO_OPEN, filePath).catch(() => {});
      trackGettingStartedProjectCreated(project.id);
      onComplete(project);
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to create project. Please try again.');
      setCreationError(message);
      setIsCreatingProject(false);
    }
  };

  const canProceed = isLoggedIn && hasPermission === true;

  return (
    <div className="gettingStarted">
      <div className="gettingStarted__inner">
        <div className="gettingStarted__header">
          <img src={dockIcon} className="gettingStarted__logo" alt="Writing Agent" />
          <h1 className="gettingStarted__title">Welcome to Writing Agent</h1>
          <p className="gettingStarted__subtitle">Complete these steps to get started</p>
        </div>

        <div className="gettingStarted__steps">
          {/* Step 1: Login */}
          <div className={`gsStep ${isLoggedIn ? 'gsStep--done' : 'gsStep--active'}`}>
            <div className="gsStep__indicator">
              {isLoggedIn ? (
                <span className="gsStep__check">✓</span>
              ) : (
                <span className="gsStep__num">1</span>
              )}
            </div>
            <div className="gsStep__body">
              <h3 className="gsStep__title">Log in to Academia</h3>
              <p className="gsStep__desc">
                {isLoggedIn
                  ? 'You are logged in.'
                  : 'Sign in with your Academia account to continue.'}
              </p>
              {!isLoggedIn && (
                <button className="gsStep__btn gsStep__btn--primary" onClick={() => { trackGettingStartedLoginClick(); onLoginRequired(); }}>
                  Log In
                </button>
              )}
            </div>
          </div>

          <div className="gettingStarted__connector" />

          {/* Step 2: Permissions */}
          <div className={`gsStep ${!isLoggedIn ? 'gsStep--disabled' : hasPermission === true ? 'gsStep--done' : 'gsStep--active'}`}>
            <div className="gsStep__indicator">
              {hasPermission === true ? (
                <span className="gsStep__check">✓</span>
              ) : (
                <span className="gsStep__num">2</span>
              )}
            </div>
            <div className="gsStep__body">
              <h3 className="gsStep__title">Grant Accessibility Permission</h3>
              <p className="gsStep__desc">
                {hasPermission === null
                  ? 'Checking permission status...'
                  : hasPermission
                    ? 'Accessibility permission granted.'
                    : 'Allow Writing Agent to read your manuscript from Microsoft Word.'}
              </p>
              {hasPermission === false && (
                <div className="gsStep__actions">
                  <button className="gsStep__btn gsStep__btn--primary" onClick={onGrantPermission}>
                    Grant Permission
                  </button>
                  <button className="gsStep__btn gsStep__btn--secondary" onClick={onRestartApp}>
                    Restart App
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="gettingStarted__connector" />

          {/* Step 3: CTA */}
          <div className={`gsStep gsStep--cta ${!canProceed ? 'gsStep--disabled' : 'gsStep--active'}`}>
            <div className="gsStep__indicator">
              <span className="gsStep__num">3</span>
            </div>
            <div className="gsStep__body">
              <h3 className="gsStep__title">Review your first manuscript in Word</h3>
              {isCreatingProject ? (
                <p className="gsStep__desc">Setting up your project...</p>
              ) : (
                <>
                  <p className="gsStep__desc">
                    Choose a .docx file to open in Microsoft Word. Writing Agent will start a full review — you'll see it appear directly in Word.
                  </p>
                  {creationError && (
                    <p className="gsStep__error">{creationError}</p>
                  )}
                  <div className="gsStep__actions">
                    <button
                      className="gsStep__btn gsStep__btn--primary gsStep__btn--large"
                      onClick={handleSelectManuscript}
                      disabled={!canProceed}
                    >
                      {creationError ? 'Try Again' : 'Select Manuscript'}
                    </button>
                  </div>
                  {!canProceed && (
                    <p className="gsStep__hint">
                      Complete steps 1 and 2 to continue.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GettingStarted;
