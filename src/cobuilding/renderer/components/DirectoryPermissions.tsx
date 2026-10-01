import React, { useState, useEffect } from 'react';
import type { Workspace, WorkspaceDirectory } from '../../shared/types';
import { SOUL_MD, MEMORY_PATH_ABOUT_YOU, MEMORY_PATH_WORKING_ON, MAX_WORKSPACE_DIRECTORIES } from '../../shared/paths';
import { XIcon, PlusIcon } from 'lucide-react';
import DirectoryPermBadge from './DirectoryPermBadge';
import ApiKeySettings from './ApiKeySettings';
import ConnectorsSettings from './ConnectorsSettings';
import ApiSettings from './ApiSettings';
import ClaudeDesignSettings from './ClaudeDesignSettings';
import SharingSettings from './SharingSettings';
import './DirectoryPermissions.css';
import './shared-forms.css';

interface DirectoryPermissionsProps {
  workspace: Workspace;
  userDirectories: WorkspaceDirectory[];
  onClose: () => void;
  onSaved: (ws: Workspace) => void;
  onDirectoriesChanged?: (dirs: WorkspaceDirectory[]) => void;
  /** Jump to the Knowledge page, which shows every memory rather than these two. */
  onOpenKnowledge?: () => void;
  inline?: boolean;
  /**
   * Whether this page is the visible tab. Forwarded to the sections whose
   * content is observed host state rather than stored settings, so they
   * re-read on arrival instead of showing a snapshot taken at app boot.
   * See `ApiSettingsProps.active`.
   */
  active?: boolean;
}

const DirectoryPermissions: React.FC<DirectoryPermissionsProps> = ({ workspace, userDirectories, onClose, onDirectoriesChanged, onOpenKnowledge, inline, active = true }) => {
  const [localDirs, setLocalDirs] = useState<WorkspaceDirectory[]>(userDirectories);
  const [dirError, setDirError] = useState<string | null>(null);
  const [isExportingLogs, setIsExportingLogs] = useState(false);
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

  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

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
      setSoulError(err instanceof Error ? err.message : 'Couldn\'t save your instructions.');
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
      setDirError('That folder is already added.');
      return;
    }
    try {
      const added = await window.workspacesAPI.addDirectory(selected);
      const updated = [...localDirs, added];
      setLocalDirs(updated);
      onDirectoriesChanged?.(updated);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : 'Couldn\'t add that folder.');
    }
  };

  const handleRemoveDirectory = async (dirId: string) => {
    if (!window.confirm('Stop sharing this folder with Acabox? Your files are not touched.')) return;
    setDirError(null);
    try {
      await window.workspacesAPI.removeDirectory(dirId);
      const updated = localDirs.filter(d => d.id !== dirId);
      setLocalDirs(updated);
      onDirectoriesChanged?.(updated);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : 'Couldn\'t remove that folder.');
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
      setDirError(err instanceof Error ? err.message : 'Couldn\'t change that folder\'s lock.');
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
          <p className="wsSettings__sectionLabel">Your folders</p>
          <div className="wsSettings__sectionCard">
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
                      aria-label="Stop sharing this folder"
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="wsSettings__hint" style={{ margin: 0 }}>
                No folders yet — add the folder your data lives in.
              </p>
            )}
            {dirError && <p className="wsSettings__dirError">{dirError}</p>}
            {localDirs.length < MAX_WORKSPACE_DIRECTORIES && (
              <button type="button" className="wsSettings__dirAddBtn" onClick={handleAddDirectory}>
                <PlusIcon size={14} />
                Add folder
              </button>
            )}
            <div className="wsSettings__dirRow" style={{ marginTop: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Look through my folders again</div>
                <div className="wsSettings__integrationDesc">
                  Have me re-read your folders to refresh what I know about your research.
                </div>
              </div>
              <button
                type="button"
                className="gsStep__btn gsStep__btn--secondary"
                disabled={isScanning || localDirs.length === 0}
                onClick={async () => {
                  setIsScanning(true);
                  setScanError(null);
                  try {
                    await window.scannerAPI.start();
                  } catch (err) {
                    setScanError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setIsScanning(false);
                  }
                }}
              >
                {isScanning ? 'Looking…' : 'Look again'}
              </button>
            </div>
            {scanError && <p className="wsSettings__dirError">{scanError}</p>}
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Instructions for Acabox</p>
          <div className="wsSettings__sectionCard">
            <p className="wsSettings__hint">
              Anything I should always keep in mind — your field, preferred formats, house rules.
            </p>
            <textarea
              className="wsSettings__textarea"
              value={soulContent}
              onChange={(e) => setSoulContent(e.target.value)}
              placeholder="e.g. Always report p-values to 3 decimals; our lab uses R-style column names."
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
          {/* This section used to be headed "Researcher profile" over copy that
              read as though these two notes were everything Acabox remembers.
              It is two of the notes it keeps; the rest live on the Knowledge
              page, which the link below opens. */}
          <p className="wsSettings__sectionLabel">About you</p>
          <div className="wsSettings__sectionCard">
            <p className="wsSettings__hint">
              Who you are and what you&rsquo;re working on. I read these before every chat, and I
              add my own notes over time &mdash; see them under What I know.
              {onOpenKnowledge && (
                <>
                  {' '}
                  <button type="button" className="connectorLink" onClick={onOpenKnowledge}>
                    See everything I&rsquo;ve learned &rarr;
                  </button>
                </>
              )}
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
          <p className="wsSettings__sectionLabel">Connected services</p>
          <div className="wsSettings__sectionCard">
            <ConnectorsSettings />
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Claude Design</p>
          <div className="wsSettings__sectionCard">
            <ClaudeDesignSettings active={active} />
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Online data services</p>
          <div className="wsSettings__sectionCard">
            <ApiSettings active={active} />
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Sharing</p>
          <div className="wsSettings__sectionCard">
            <SharingSettings />
          </div>
        </section>

        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Anthropic account &amp; key</p>
          <div className="wsSettings__sectionCard">

            {/* The Debug tab is dev-only, so this is the one way a packaged
                user can hand us the logs when something goes wrong. */}
            <div className="wsSettings__dirRow" style={{ marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Export logs</div>
                <div className="wsSettings__integrationDesc">
                  Save the app and command logs to a text file you can send when something goes wrong.
                </div>
              </div>
              <button
                type="button"
                className="gsStep__btn gsStep__btn--secondary"
                disabled={isExportingLogs}
                onClick={async () => {
                  setIsExportingLogs(true);
                  try {
                    await window.debugAPI.exportLogs();
                  } finally {
                    setIsExportingLogs(false);
                  }
                }}
              >
                {isExportingLogs ? 'Exporting…' : 'Export logs…'}
              </button>
            </div>

            <ApiKeySettings />
          </div>
        </section>
      </div>
    </div>
  );
};

export default DirectoryPermissions;
