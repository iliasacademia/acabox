import React, { useState, useEffect } from 'react';
import type { Workspace, WorkspaceDirectory } from '../../shared/types';
import { SOUL_MD, MEMORY_PATH_ABOUT_YOU, MEMORY_PATH_WORKING_ON, MAX_WORKSPACE_DIRECTORIES } from '../../shared/paths';
import { kernelRegistry } from './notebook/kernelRegistry';
import { XIcon, PlusIcon } from 'lucide-react';
import DirectoryPermBadge from './DirectoryPermBadge';
import './DirectoryPermissions.css';
import './shared-forms.css';

interface DirectoryPermissionsProps {
  workspace: Workspace;
  userDirectories: WorkspaceDirectory[];
  onClose: () => void;
  onSaved: (ws: Workspace) => void;
  onLogout: () => void;
  onRestartOnboarding: () => void;
  onDirectoriesChanged?: (dirs: WorkspaceDirectory[]) => void;
  inline?: boolean;
}

const DirectoryPermissions: React.FC<DirectoryPermissionsProps> = ({ workspace, userDirectories, onClose, onLogout, onRestartOnboarding, onDirectoriesChanged, inline }) => {
  const [localDirs, setLocalDirs] = useState<WorkspaceDirectory[]>(userDirectories);
  const [dirError, setDirError] = useState<string | null>(null);
  const [togglingDirId, setTogglingDirId] = useState<string | null>(null);

  useEffect(() => {
    setLocalDirs(userDirectories);
  }, [userDirectories]);

  const [aboutContent, setAboutContent] = useState('');
  const [savedAboutContent, setSavedAboutContent] = useState('');
  const [workingOnContent, setWorkingOnContent] = useState('');
  const [savedWorkingOnContent, setSavedWorkingOnContent] = useState('');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const [soulContent, setSoulContent] = useState('');
  const [savedSoulContent, setSavedSoulContent] = useState('');
  const [soulLoaded, setSoulLoaded] = useState(false);
  const [soulError, setSoulError] = useState<string | null>(null);
  const [isSavingSoul, setIsSavingSoul] = useState(false);

  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isRestartingOnboarding, setIsRestartingOnboarding] = useState(false);

  useEffect(() => {
    window.academiaFileAPI.read(SOUL_MD).then(({ content }) => {
      setSoulContent(content);
      setSavedSoulContent(content);
      setSoulLoaded(true);
    });
    Promise.all([
      window.academiaFileAPI.read(MEMORY_PATH_ABOUT_YOU),
      window.academiaFileAPI.read(MEMORY_PATH_WORKING_ON),
    ]).then(([about, workingOn]) => {
      setAboutContent(about.content);
      setSavedAboutContent(about.content);
      setWorkingOnContent(workingOn.content);
      setSavedWorkingOnContent(workingOn.content);
      setProfileLoaded(true);
    });
  }, []);

  const soulDirty = soulContent !== savedSoulContent;
  const canSaveSoul = soulLoaded && soulDirty && !isSavingSoul;

  const handleSaveSoul = async () => {
    if (!canSaveSoul) return;
    setSoulError(null);
    setIsSavingSoul(true);
    try {
      await window.academiaFileAPI.write(SOUL_MD, soulContent);
      setSavedSoulContent(soulContent);
    } catch (err) {
      setSoulError(err instanceof Error ? err.message : 'Failed to save system prompt.');
    } finally {
      setIsSavingSoul(false);
    }
  };

  const handleCancelSoul = () => {
    setSoulContent(savedSoulContent);
    setSoulError(null);
  };

  const handleAddDirectory = async () => {
    setDirError(null);
    const selected = await window.workspacesAPI.selectDirectory();
    if (!selected) return;
    if (localDirs.some(d => d.directory_path === selected)) {
      setDirError('This directory is already in your workspace.');
      return;
    }
    try {
      const added = await window.workspacesAPI.addDirectory(selected);
      const updated = [...localDirs, added];
      setLocalDirs(updated);
      onDirectoriesChanged?.(updated);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : 'Failed to add directory.');
    }
  };

  const handleRemoveDirectory = async (dirId: string) => {
    if (!window.confirm('Are you sure you want to remove this directory from your workspace?')) return;
    setDirError(null);
    try {
      await window.workspacesAPI.removeDirectory(dirId);
      const updated = localDirs.filter(d => d.id !== dirId);
      setLocalDirs(updated);
      onDirectoriesChanged?.(updated);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : 'Failed to remove directory.');
    }
  };

  const handleTogglePermission = async (dirId: string, currentlyReadOnly: boolean) => {
    if (togglingDirId) return;
    setDirError(null);
    setTogglingDirId(dirId);
    const snapshot = localDirs;
    const optimistic = snapshot.map(d =>
      d.id === dirId ? { ...d, read_only: !currentlyReadOnly } : d
    );
    setLocalDirs(optimistic);
    onDirectoriesChanged?.(optimistic);
    try {
      const updated = await window.workspacesAPI.updateDirectoryPermission(dirId, !currentlyReadOnly);
      const confirmed = optimistic.map(d => d.id === dirId ? updated : d);
      setLocalDirs(confirmed);
      onDirectoriesChanged?.(confirmed);
    } catch (err) {
      setLocalDirs(snapshot);
      onDirectoriesChanged?.(snapshot);
      setDirError(err instanceof Error ? err.message : 'Failed to update directory permission.');
    } finally {
      setTogglingDirId(null);
    }
  };

  const profileDirty = aboutContent !== savedAboutContent || workingOnContent !== savedWorkingOnContent;
  const canSaveProfile = profileLoaded && profileDirty && !isSavingProfile;

  const handleSaveProfile = async () => {
    if (!canSaveProfile) return;
    setProfileError(null);
    setIsSavingProfile(true);
    try {
      await Promise.all([
        window.academiaFileAPI.write(MEMORY_PATH_ABOUT_YOU, aboutContent),
        window.academiaFileAPI.write(MEMORY_PATH_WORKING_ON, workingOnContent),
      ]);
      setSavedAboutContent(aboutContent);
      setSavedWorkingOnContent(workingOnContent);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to save researcher profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleCancelProfile = () => {
    setAboutContent(savedAboutContent);
    setWorkingOnContent(savedWorkingOnContent);
    setProfileError(null);
  };

  return (
    <div
      className={inline ? 'pageShell' : 'wsSettings'}
      onClick={inline ? undefined : onClose}
    >
      <div
        className={inline ? 'pageShell__inner' : 'wsSettings__page'}
        onClick={(e) => e.stopPropagation()}
      >
        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Workspace directories</p>
          <div className="wsSettings__sectionCard">
            <div className="wsSettings__integrationName" style={{ marginBottom: 6 }}>Local folders</div>
            {localDirs.length > 0 ? (
              <div className="wsSettings__dirList">
                {localDirs.map((dir) => (
                  <div key={dir.id} className="wsSettings__dirRow">
                    <span className="wsSettings__dirPath" title={dir.directory_path}>
                      {dir.directory_path}
                    </span>
                    <DirectoryPermBadge
                      readOnly={dir.read_only}
                      isToggling={togglingDirId === dir.id}
                      disabled={togglingDirId !== null}
                      onToggle={() => handleTogglePermission(dir.id, dir.read_only)}
                    />
                    <button
                      type="button"
                      className="wsSettings__dirRemoveBtn"
                      onClick={() => handleRemoveDirectory(dir.id)}
                      aria-label="Remove directory"
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="wsSettings__hint" style={{ margin: 0 }}>
                No local directories added.
              </p>
            )}
            {dirError && <p className="wsSettings__dirError">{dirError}</p>}
            {localDirs.length < MAX_WORKSPACE_DIRECTORIES && (
              <button type="button" className="wsSettings__dirAddBtn" onClick={handleAddDirectory}>
                <PlusIcon size={14} />
                Add folder
              </button>
            )}
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">System prompt</p>
          <div className="wsSettings__sectionCard">
            <p className="wsSettings__hint">
              Custom instructions appended to the AI system prompt for this workspace. Saved to .academia/SOUL.md.
            </p>
            <textarea
              className="wsSettings__textarea"
              value={soulContent}
              onChange={(e) => setSoulContent(e.target.value)}
              placeholder="Enter custom instructions for the AI agent..."
              rows={6}
              disabled={!soulLoaded}
            />
            {soulError && <p className="gsStep__error">{soulError}</p>}
            <div className="wsSettings__cardActions wsSettings__cardActions--flush">
              <button
                type="button"
                className="gsStep__btn gsStep__btn--secondary"
                disabled={!soulDirty || isSavingSoul}
                onClick={handleCancelSoul}
              >
                Cancel
              </button>
              <button
                type="button"
                className="gsStep__btn gsStep__btn--primary"
                disabled={!canSaveSoul}
                onClick={handleSaveSoul}
              >
                {isSavingSoul ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Researcher profile</p>
          <div className="wsSettings__sectionCard">
            <p className="wsSettings__hint">
              How the AI understands you and your current work. Saved to .academia/agent-memory/.
            </p>

            <div className="wsSettings__field">
              <label className="wsSettings__label">About You</label>
              <textarea
                className="wsSettings__textarea"
                value={aboutContent}
                onChange={(e) => setAboutContent(e.target.value)}
                placeholder="A summary of who you are and your research..."
                rows={6}
                disabled={!profileLoaded}
              />
            </div>

            <div className="wsSettings__field">
              <label className="wsSettings__label">What You&rsquo;re Working On</label>
              <textarea
                className="wsSettings__textarea"
                value={workingOnContent}
                onChange={(e) => setWorkingOnContent(e.target.value)}
                placeholder="What you're currently focused on..."
                rows={6}
                disabled={!profileLoaded}
              />
            </div>

            {profileError && <p className="gsStep__error">{profileError}</p>}

            <div className="wsSettings__cardActions wsSettings__cardActions--flush">
              <button
                type="button"
                className="gsStep__btn gsStep__btn--secondary"
                disabled={!profileDirty || isSavingProfile}
                onClick={handleCancelProfile}
              >
                Cancel
              </button>
              <button
                type="button"
                className="gsStep__btn gsStep__btn--primary"
                disabled={!canSaveProfile}
                onClick={handleSaveProfile}
              >
                {isSavingProfile ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Account</p>
          <div className="wsSettings__sectionCard">
            <div className="wsSettings__dirRow" style={{ marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Restart onboarding</div>
                <div className="wsSettings__integrationDesc">
                  Beginning again with a fresh scan of your workspace.
                </div>
              </div>
              <button
                type="button"
                className="gsStep__btn gsStep__btn--secondary"
                disabled={isRestartingOnboarding || isLoggingOut}
                onClick={async () => {
                  setIsRestartingOnboarding(true);
                  await window.debugAPI.restartOnboarding();
                  kernelRegistry.clearAll().catch(() => {});
                  onRestartOnboarding();
                }}
              >
                {isRestartingOnboarding ? 'Restarting...' : 'Restart Onboarding'}
              </button>
            </div>

            <div className="wsSettings__dirRow">
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Log out</div>
                <div className="wsSettings__integrationDesc">
                  Sign out of your Academia account on this device.
                </div>
              </div>
              <button
                type="button"
                className="gsStep__btn gsStep__btn--secondary"
                disabled={isLoggingOut || isRestartingOnboarding}
                onClick={async () => {
                  setIsLoggingOut(true);
                  const result = await window.authAPI.logout();
                  if (result.success) {
                    kernelRegistry.clearAll().catch(() => {});
                    onLogout();
                  } else {
                    setIsLoggingOut(false);
                  }
                }}
              >
                {isLoggingOut ? 'Logging out...' : 'Log Out'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default DirectoryPermissions;
