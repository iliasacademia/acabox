import React, { useState, useEffect, useRef, useCallback } from 'react';
import { IPC_CHANNELS } from '../../shared/types';
import { getZoteroStatus, syncZotero, getZoteroAuthorizeUrl, ZoteroStatus } from '../services/zoteroApi';
import { createProject, Project, extractErrorMessage } from '../services/projectsApi';
import {
  trackGettingStartedView,
  trackGettingStartedLoginClick,
  trackGettingStartedPermissionGranted,
  trackGettingStartedZoteroSynced,
  trackGettingStartedZoteroSkipped,
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

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_DURATION_MS = 5 * 60 * 1000;

const GettingStarted: React.FC<GettingStartedProps> = ({
  isLoggedIn,
  hasPermission,
  onLoginRequired,
  onGrantPermission,
  onRestartApp,
  onComplete,
}) => {
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus | null>(null);
  const [isPollingZotero, setIsPollingZotero] = useState(false);
  const [isSyncingZotero, setIsSyncingZotero] = useState(false);
  const [isLoadingZotero, setIsLoadingZotero] = useState(false);
  const [zoteroSkipped, setZoteroSkipped] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef<number>(0);

  useEffect(() => { trackGettingStartedView(); }, []);

  const permissionTrackedRef = useRef(hasPermission === true);
  useEffect(() => {
    if (hasPermission === true && !permissionTrackedRef.current) {
      permissionTrackedRef.current = true;
      trackGettingStartedPermissionGranted();
    }
  }, [hasPermission]);

  useEffect(() => {
    if (isLoggedIn) {
      setIsLoadingZotero(true);
      getZoteroStatus().then(setZoteroStatus).finally(() => setIsLoadingZotero(false));
    }
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [isLoggedIn]);

  const stopPolling = useCallback(() => {
    setIsPollingZotero(false);
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    setIsPollingZotero(true);
    pollStartRef.current = Date.now();

    const poll = async () => {
      if (Date.now() - pollStartRef.current > MAX_POLL_DURATION_MS) {
        stopPolling();
        return;
      }
      const status = await getZoteroStatus();
      setZoteroStatus(status);
      if (status.connected) {
        stopPolling();
        handleSyncZotero(status);
        return;
      }
      pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
  }, [stopPolling]);

  const handleConnectZotero = () => {
    const url = getZoteroAuthorizeUrl();
    window.electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
    startPolling();
  };

  const handleSyncZotero = async (currentStatus?: ZoteroStatus) => {
    const status = currentStatus ?? zoteroStatus;
    if (!status) return;
    setIsSyncingZotero(true);
    const previousSyncedAt = status.last_synced_at;
    try {
      await syncZotero();
      const pollStart = Date.now();
      const pollForSync = async () => {
        const status = await getZoteroStatus();
        setZoteroStatus(status);
        if (status.last_synced_at !== previousSyncedAt || Date.now() - pollStart > MAX_POLL_DURATION_MS) {
          setIsSyncingZotero(false);
          if (status.last_synced_at !== previousSyncedAt) trackGettingStartedZoteroSynced();
          return;
        }
        setTimeout(pollForSync, POLL_INTERVAL_MS);
      };
      setTimeout(pollForSync, POLL_INTERVAL_MS);
    } catch {
      setIsSyncingZotero(false);
    }
  };

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

  const isZoteroConnected = zoteroStatus?.connected ?? false;
  const isZoteroSynced = isZoteroConnected && zoteroStatus?.last_synced_at != null;
  const isZoteroDone = isZoteroSynced || zoteroSkipped;
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

          {/* Step 3: Zotero (optional) */}
          <div className={`gsStep gsStep--optional ${isZoteroDone ? 'gsStep--done' : !canProceed ? 'gsStep--disabled' : 'gsStep--active'}`}>
            <div className="gsStep__indicator">
              {isZoteroDone ? (
                <span className="gsStep__check">✓</span>
              ) : (
                <span className="gsStep__num">3</span>
              )}
            </div>
            <div className="gsStep__body">
              <div className="gsStep__titleRow">
                <h3 className="gsStep__title">Connect Zotero</h3>
                <span className="gsStep__badge">Optional</span>
              </div>
              <p className="gsStep__desc">
                {zoteroSkipped
                  ? 'Skipped. You can connect Zotero later in Settings.'
                  : isZoteroSynced
                    ? `Library synced successfully as ${zoteroStatus?.zotero_username || 'user'}.`
                    : isZoteroConnected
                      ? `Connected as ${zoteroStatus?.zotero_username || 'user'}. Sync your library to continue.`
                      : isPollingZotero
                        ? 'Waiting for Zotero authorization...'
                        : isLoadingZotero
                          ? 'Checking Zotero connection...'
                          : !canProceed
                            ? 'Complete steps 1 and 2 first to connect Zotero.'
                            : 'Sync your Zotero library to use references in your manuscripts.'}
              </p>
              {!isZoteroDone && !isLoadingZotero && canProceed && (
                <div className="gsStep__actions">
                  {!isZoteroConnected ? (
                    <button
                      className="gsStep__btn gsStep__btn--primary"
                      onClick={handleConnectZotero}
                      disabled={isPollingZotero}
                    >
                      {isPollingZotero ? 'Waiting...' : 'Connect Zotero'}
                    </button>
                  ) : (
                    <button
                      className="gsStep__btn gsStep__btn--primary"
                      onClick={() => handleSyncZotero()}
                      disabled={isSyncingZotero}
                    >
                      {isSyncingZotero ? 'Syncing...' : 'Sync Library'}
                    </button>
                  )}
                  <button
                    className="gsStep__btn gsStep__btn--ghost"
                    onClick={() => { setZoteroSkipped(true); trackGettingStartedZoteroSkipped(); }}
                  >
                    Skip for now
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="gettingStarted__connector" />

          {/* Step 4: CTA */}
          <div className={`gsStep gsStep--cta ${!canProceed ? 'gsStep--disabled' : 'gsStep--active'}`}>
            <div className="gsStep__indicator">
              <span className="gsStep__num">4</span>
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
