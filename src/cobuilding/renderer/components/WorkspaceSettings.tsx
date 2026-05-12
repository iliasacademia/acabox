import React, { useState, useEffect } from 'react';
import type { Workspace } from '../../shared/types';
import { SOUL_MD, MEMORY_PATH_ABOUT_YOU, MEMORY_PATH_WORKING_ON } from '../../shared/paths';
import { kernelRegistry } from './notebook/kernelRegistry';
import './WorkspaceSettings.css';
import './shared-forms.css';

interface WorkspaceSettingsProps {
  workspace: Workspace;
  onClose: () => void;
  onSaved: (ws: Workspace) => void;
  onLogout: () => void;
  onRestartOnboarding: () => void;
  inline?: boolean;
}

const WorkspaceSettings: React.FC<WorkspaceSettingsProps> = ({ workspace, onClose, onSaved, onLogout, onRestartOnboarding, inline }) => {
  // --- Workspace card state ---
  // Editable values plus their last-saved baselines so Cancel can revert.
  const [name, setName] = useState(workspace.name);
  const [savedName, setSavedName] = useState(workspace.name);
  const [directoryPath, setDirectoryPath] = useState(workspace.directory_path);
  const [savedDirectoryPath, setSavedDirectoryPath] = useState(workspace.directory_path);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);

  // --- Researcher Profile card state ---
  const [aboutContent, setAboutContent] = useState('');
  const [savedAboutContent, setSavedAboutContent] = useState('');
  const [workingOnContent, setWorkingOnContent] = useState('');
  const [savedWorkingOnContent, setSavedWorkingOnContent] = useState('');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // --- System Prompt card state ---
  const [soulContent, setSoulContent] = useState('');
  const [savedSoulContent, setSavedSoulContent] = useState('');
  const [soulLoaded, setSoulLoaded] = useState(false);
  const [soulError, setSoulError] = useState<string | null>(null);
  const [isSavingSoul, setIsSavingSoul] = useState(false);

  // Accessibility permission (shared across all overlay integrations)
  const [accessibilityGranted, setAccessibilityGranted] = useState<boolean | null>(null);
  const [requestingPermission, setRequestingPermission] = useState(false);

  // Per-integration enable state (Word, Obsidian, Apple Notes, Google Docs, ...).
  type IntegrationId = 'word' | 'obsidian' | 'apple-notes' | 'google-docs';
  const [wordIntegrationEnabled, setWordIntegrationEnabled] = useState<boolean | null>(null);
  const [obsidianIntegrationEnabled, setObsidianIntegrationEnabled] = useState<boolean | null>(null);
  const [appleNotesIntegrationEnabled, setAppleNotesIntegrationEnabled] = useState<boolean | null>(null);
  const [googleDocsIntegrationEnabled, setGoogleDocsIntegrationEnabled] = useState<boolean | null>(null);
  // Google Docs OAuth (Phase C2) — separate from the host-app integration toggle.
  const [googleDocsApiConnected, setGoogleDocsApiConnected] = useState<boolean | null>(null);
  const [googleDocsApiHasCreds, setGoogleDocsApiHasCreds] = useState<boolean>(false);
  const [googleDocsApiBusy, setGoogleDocsApiBusy] = useState<boolean>(false);
  const [googleDocsApiError, setGoogleDocsApiError] = useState<string | null>(null);
  const [integrationToggling, setIntegrationToggling] = useState<IntegrationId | null>(null);
  const [integrationPermissionPrompt, setIntegrationPermissionPrompt] = useState<{ id: IntegrationId; displayName: string } | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isRestartingOnboarding, setIsRestartingOnboarding] = useState(false);

  const [allWorkspaces, setAllWorkspaces] = useState<Workspace[]>([]);
  const [isSwitching, setIsSwitching] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDirectory, setNewDirectory] = useState('');
  const [newDirectoryOverridden, setNewDirectoryOverridden] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
    window.workspacesAPI.list().then(setAllWorkspaces);
    window.electronAPI.invoke('check-accessibility-permission').then((result: any) => {
      if (result) setAccessibilityGranted(result.hasPermission ?? false);
    }).catch(() => setAccessibilityGranted(false));
    window.electronAPI.invoke('integration:get-enabled', 'word').then((v: boolean) => setWordIntegrationEnabled(!!v)).catch(() => setWordIntegrationEnabled(false));
    window.electronAPI.invoke('integration:get-enabled', 'obsidian').then((v: boolean) => setObsidianIntegrationEnabled(!!v)).catch(() => setObsidianIntegrationEnabled(false));
    window.electronAPI.invoke('integration:get-enabled', 'apple-notes').then((v: boolean) => setAppleNotesIntegrationEnabled(!!v)).catch(() => setAppleNotesIntegrationEnabled(false));
    window.electronAPI.invoke('integration:get-enabled', 'google-docs').then((v: boolean) => setGoogleDocsIntegrationEnabled(!!v)).catch(() => setGoogleDocsIntegrationEnabled(false));
    refreshGoogleDocsApiStatus();
  }, []);

  const refreshGoogleDocsApiStatus = () => {
    const api = (window as any).googleDocsAPI;
    if (!api?.status) { setGoogleDocsApiConnected(false); setGoogleDocsApiHasCreds(false); return; }
    api.status().then((r: { connected: boolean; hasCredentials: boolean }) => {
      setGoogleDocsApiConnected(!!r?.connected);
      setGoogleDocsApiHasCreds(!!r?.hasCredentials);
    }).catch(() => { setGoogleDocsApiConnected(false); });
  };

  const handleConnectGoogleDocs = async () => {
    setGoogleDocsApiBusy(true);
    setGoogleDocsApiError(null);
    try {
      const result: any = await (window as any).googleDocsAPI.connect();
      if (result?.success === false) {
        setGoogleDocsApiError(result.error ?? 'Could not connect to Google Docs.');
      }
    } catch (err: any) {
      setGoogleDocsApiError(err?.message ?? 'Could not connect to Google Docs.');
    } finally {
      setGoogleDocsApiBusy(false);
      refreshGoogleDocsApiStatus();
    }
  };

  const handleDisconnectGoogleDocs = async () => {
    setGoogleDocsApiBusy(true);
    try {
      await (window as any).googleDocsAPI.disconnect();
    } finally {
      setGoogleDocsApiBusy(false);
      setGoogleDocsApiError(null);
      refreshGoogleDocsApiStatus();
    }
  };

  useEffect(() => {
    if (newDirectoryOverridden || !newName.trim()) return;
    window.workspacesAPI.getDefaultDirectory(newName.trim()).then(setNewDirectory);
  }, [newName, newDirectoryOverridden]);

  // --- Workspace card save/cancel ---
  const workspaceDirty = name !== savedName || directoryPath !== savedDirectoryPath;
  const canSaveWorkspace = workspaceDirty && name.trim().length > 0 && directoryPath.length > 0 && !isSavingWorkspace;

  const handleChangeDirectory = async () => {
    const selected = await window.workspacesAPI.selectDirectory();
    if (selected) {
      setDirectoryPath(selected);
      setWorkspaceError(null);
    }
  };

  const handleSaveWorkspace = async () => {
    if (!canSaveWorkspace) return;
    setWorkspaceError(null);
    setIsSavingWorkspace(true);
    try {
      const updated = await window.workspacesAPI.update({ name: name.trim(), directoryPath });
      setSavedName(updated.name);
      setSavedDirectoryPath(updated.directory_path);
      onSaved(updated);
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : 'Failed to update workspace.');
    } finally {
      setIsSavingWorkspace(false);
    }
  };

  const handleCancelWorkspace = () => {
    setName(savedName);
    setDirectoryPath(savedDirectoryPath);
    setWorkspaceError(null);
  };

  // --- System Prompt card save/cancel ---
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

  // --- Researcher Profile card save/cancel ---
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

  const handleSwitch = async (id: string) => {
    setIsSwitching(id);
    try {
      await window.workspacesAPI.switch(id);
      window.location.reload();
    } catch (err) {
      setIsSwitching(null);
    }
  };

  const handleNewChangeDirectory = async () => {
    const selected = await window.workspacesAPI.selectDirectory();
    if (selected) {
      setNewDirectory(selected);
      setNewDirectoryOverridden(true);
      setCreateError(null);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newDirectory) return;
    setCreateError(null);
    setIsCreating(true);
    try {
      await window.workspacesAPI.create({ name: newName.trim(), directoryPath: newDirectory });
      window.location.reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create workspace.');
      setIsCreating(false);
    }
  };

  const handleToggleIntegration = async (id: IntegrationId, displayName: string, currentlyEnabled: boolean | null) => {
    if (currentlyEnabled === null || integrationToggling !== null) return;
    setIntegrationToggling(id);
    setIntegrationPermissionPrompt(null);
    try {
      const result: any = await window.electronAPI.invoke(
        'integration:set-enabled',
        id,
        !currentlyEnabled,
      );
      if (result?.success === false && result?.error === 'permission_required') {
        setIntegrationPermissionPrompt({ id, displayName });
      }
    } catch (err) {
      console.error('[WorkspaceSettings] Integration toggle failed:', err);
    } finally {
      setIntegrationToggling(null);
    }
  };

  const handleRequestPermission = async () => {
    setRequestingPermission(true);
    try {
      const result: any = await window.electronAPI.invoke('request-accessibility-permission');
      if (result) setAccessibilityGranted(result.hasPermission ?? false);
    } catch { /* ignore */ }
    setRequestingPermission(false);
  };

  useEffect(() => {
    const recheck = () => {
      window.electronAPI.invoke('check-accessibility-permission').then((result: any) => {
        if (result) setAccessibilityGranted(result.hasPermission ?? false);
      }).catch(() => {});
    };
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, []);

  return (
    <div
      className={inline ? 'pageShell' : 'wsSettings'}
      onClick={inline ? undefined : onClose}
    >
      <div
        className={inline ? 'pageShell__inner' : 'wsSettings__page'}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ───────── Workspace ───────── */}
        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Workspace</p>
          <div className="wsSettings__sectionCard">
            <div className="wsSettings__field">
              <label className="wsSettings__label">Workspaces</label>
              <div className="wsSettings__wsList">
                {allWorkspaces.map((ws) => (
                  <div key={ws.id} className={`wsSettings__wsRow${ws.id === workspace.id ? ' wsSettings__wsRow--active' : ''}`}>
                    <div className="wsSettings__wsInfo">
                      <span className="wsSettings__wsName">{ws.name}</span>
                      <span className="wsSettings__wsDir">{ws.directory_path}</span>
                    </div>
                    {ws.id === workspace.id ? (
                      <span className="wsSettings__wsBadge">Active</span>
                    ) : (
                      <button
                        type="button"
                        className="gsStep__btn gsStep__btn--secondary wsSettings__wsBtn"
                        disabled={isSwitching !== null}
                        onClick={() => handleSwitch(ws.id)}
                      >
                        {isSwitching === ws.id ? 'Switching...' : 'Switch'}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {showNewForm ? (
                <div className="wsSettings__newForm">
                  <input
                    type="text"
                    className="gsStep__input"
                    value={newName}
                    onChange={(e) => { setNewName(e.target.value); setNewDirectoryOverridden(false); }}
                    placeholder="Workspace name"
                    autoFocus
                  />
                  {newDirectory && (
                    <div className="wsSettings__dirRow" style={{ marginTop: 8 }}>
                      <span className="wsSettings__dirPath" title={newDirectory}>{newDirectory}</span>
                      <button type="button" className="gsStep__btn gsStep__btn--ghost" onClick={handleNewChangeDirectory}>Change</button>
                    </div>
                  )}
                  {createError && <p className="gsStep__error">{createError}</p>}
                  <div className="wsSettings__newFormActions">
                    <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={() => { setShowNewForm(false); setNewName(''); setNewDirectory(''); setCreateError(null); }}>
                      Cancel
                    </button>
                    <button type="button" className="gsStep__btn gsStep__btn--primary" disabled={!newName.trim() || !newDirectory || isCreating} onClick={handleCreate}>
                      {isCreating ? 'Creating...' : 'Create'}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="gsStep__btn gsStep__btn--ghost wsSettings__newBtn" onClick={() => setShowNewForm(true)}>
                  + New Workspace
                </button>
              )}
            </div>

            <div className="wsSettings__divider" />

            <div className="wsSettings__field">
              <label className="wsSettings__label">Workspace Name</label>
              <input
                type="text"
                className="gsStep__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Workspace"
              />
            </div>

            <div className="wsSettings__field">
              <label className="wsSettings__label">Directory</label>
              <div className="wsSettings__dirRow">
                <span className="wsSettings__dirPath" title={directoryPath}>
                  {directoryPath}
                </span>
                <button
                  type="button"
                  className="gsStep__btn gsStep__btn--secondary"
                  onClick={handleChangeDirectory}
                >
                  Change
                </button>
              </div>
            </div>

            {workspaceError && <p className="gsStep__error">{workspaceError}</p>}

            <div className="wsSettings__cardActions">
              <button
                type="button"
                className="gsStep__btn gsStep__btn--secondary"
                disabled={!workspaceDirty || isSavingWorkspace}
                onClick={handleCancelWorkspace}
              >
                Cancel
              </button>
              <button
                type="button"
                className="gsStep__btn gsStep__btn--primary"
                disabled={!canSaveWorkspace}
                onClick={handleSaveWorkspace}
              >
                {isSavingWorkspace ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </section>

        {/* ───────── System Prompt ───────── */}
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

        {/* ───────── Researcher Profile ───────── */}
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

        {/* ───────── Integrations ───────── */}
        <section className="wsSettings__section">
          <p className="wsSettings__sectionLabel">Integrations</p>
          <div className="wsSettings__sectionCard">
            <p className="wsSettings__hint">
              Show the floating overlay over a host app and let the agent propose edits with Approve/Deny cards. All integrations require macOS Accessibility permission for Academia.
            </p>

            <div className="wsSettings__dirRow">
              <span style={{
                flex: 1,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 14,
                color: accessibilityGranted === null ? '#888' : accessibilityGranted ? '#16a34a' : '#dc2626',
              }}>
                <span style={{ fontSize: 16 }}>
                  {accessibilityGranted === null ? '⏳' : accessibilityGranted ? '✓' : '✗'}
                </span>
                {accessibilityGranted === null
                  ? 'Checking accessibility permission...'
                  : accessibilityGranted
                  ? 'Accessibility permission granted'
                  : 'Accessibility permission not granted'}
              </span>
              {accessibilityGranted === false && (
                <button
                  type="button"
                  className="gsStep__btn gsStep__btn--primary"
                  disabled={requestingPermission}
                  onClick={handleRequestPermission}
                >
                  {requestingPermission ? 'Opening...' : 'Grant Permission'}
                </button>
              )}
            </div>

            <div className="wsSettings__divider" />

            <div className="wsSettings__dirRow" style={{ marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Word Integration</div>
                <div className="wsSettings__integrationDesc">
                  {wordIntegrationEnabled
                    ? 'Overlay appears over Microsoft Word documents. Edits are proposed via Track Changes.'
                    : 'Show the overlay over Microsoft Word and let the agent propose tracked-change edits.'}
                </div>
              </div>
              <button
                type="button"
                className={`gsStep__btn ${wordIntegrationEnabled ? 'gsStep__btn--secondary' : 'gsStep__btn--primary'}`}
                disabled={wordIntegrationEnabled === null || integrationToggling !== null}
                onClick={() => handleToggleIntegration('word', 'Word', wordIntegrationEnabled)}
              >
                {integrationToggling === 'word'
                  ? 'Working...'
                  : wordIntegrationEnabled === null
                    ? '...'
                    : wordIntegrationEnabled
                      ? 'Disable and Restart'
                      : 'Enable and Restart'}
              </button>
            </div>

            <div className="wsSettings__dirRow" style={{ marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Obsidian Integration</div>
                <div className="wsSettings__integrationDesc">
                  {obsidianIntegrationEnabled
                    ? 'Overlay appears over Obsidian when the active workspace is the vault. Edits go through Approve/Deny cards.'
                    : 'Show the overlay over Obsidian for any markdown note in the active workspace. The workspace must be your Obsidian vault (folder with .obsidian/ inside).'}
                </div>
              </div>
              <button
                type="button"
                className={`gsStep__btn ${obsidianIntegrationEnabled ? 'gsStep__btn--secondary' : 'gsStep__btn--primary'}`}
                disabled={obsidianIntegrationEnabled === null || integrationToggling !== null}
                onClick={() => handleToggleIntegration('obsidian', 'Obsidian', obsidianIntegrationEnabled)}
              >
                {integrationToggling === 'obsidian'
                  ? 'Working...'
                  : obsidianIntegrationEnabled === null
                    ? '...'
                    : obsidianIntegrationEnabled
                      ? 'Disable and Restart'
                      : 'Enable and Restart'}
              </button>
            </div>

            <div className="wsSettings__dirRow" style={{ marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Apple Notes Integration</div>
                <div className="wsSettings__integrationDesc">
                  {appleNotesIntegrationEnabled
                    ? 'Overlay appears over Apple Notes for the focused note. Edits go through Approve/Deny cards and apply via AppleScript.'
                    : 'Show the overlay over Apple Notes. Notes are not files — chats are tied to the active note via its Notes id, independent of the workspace.'}
                </div>
              </div>
              <button
                type="button"
                className={`gsStep__btn ${appleNotesIntegrationEnabled ? 'gsStep__btn--secondary' : 'gsStep__btn--primary'}`}
                disabled={appleNotesIntegrationEnabled === null || integrationToggling !== null}
                onClick={() => handleToggleIntegration('apple-notes', 'Apple Notes', appleNotesIntegrationEnabled)}
              >
                {integrationToggling === 'apple-notes'
                  ? 'Working...'
                  : appleNotesIntegrationEnabled === null
                    ? '...'
                    : appleNotesIntegrationEnabled
                      ? 'Disable and Restart'
                      : 'Enable and Restart'}
              </button>
            </div>

            <div className="wsSettings__dirRow" style={{ marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="wsSettings__integrationName">Google Docs Integration</div>
                <div className="wsSettings__integrationDesc">
                  {googleDocsIntegrationEnabled
                    ? 'Overlay appears over Chrome when the focused tab is a Google Doc. Selection text and the doc id come from the Academia browser extension. Edit suggestions show as cards but Apply is disabled until OAuth + Docs API ships.'
                    : 'Show the overlay over Chrome when you are on a Google Doc. Requires the Academia browser extension to be installed and connected. Phase A is read-only (selection) plus suggestion cards — automatic editing arrives with the upcoming Google Docs API integration.'}
                </div>
              </div>
              <button
                type="button"
                className={`gsStep__btn ${googleDocsIntegrationEnabled ? 'gsStep__btn--secondary' : 'gsStep__btn--primary'}`}
                disabled={googleDocsIntegrationEnabled === null || integrationToggling !== null}
                onClick={() => handleToggleIntegration('google-docs', 'Google Docs', googleDocsIntegrationEnabled)}
              >
                {integrationToggling === 'google-docs'
                  ? 'Working...'
                  : googleDocsIntegrationEnabled === null
                    ? '...'
                    : googleDocsIntegrationEnabled
                      ? 'Disable and Restart'
                      : 'Enable and Restart'}
              </button>
            </div>

            {googleDocsIntegrationEnabled && (
              <div className="wsSettings__dirRow" style={{ marginBottom: 8, marginLeft: 16, paddingLeft: 12, borderLeft: '2px solid rgb(232, 226, 214)' }}>
                <div style={{ flex: 1 }}>
                  <div className="wsSettings__integrationName" style={{ fontSize: 13 }}>Connect Google account (full doc reads + apply edits)</div>
                  <div className="wsSettings__integrationDesc">
                    {googleDocsApiConnected
                      ? 'Connected. Academia can read multi-tab Google Docs (including download-restricted ones) via the official Docs API, and Apply on suggestion cards now writes the edit directly. Scope: google-docs only — no Drive, Sheets, Gmail, or Calendar access.'
                      : googleDocsApiHasCreds
                        ? 'Sign in with Google to grant access to your Docs only. The requested scope is google-docs only — no Drive, Sheets, Gmail, or Calendar access.'
                        : 'Google Docs API isn\'t configured in this build. Production builds bake the OAuth client at compile time; for dev, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your shell before launching the app.'}
                  </div>
                  {googleDocsApiError && (
                    <div style={{ fontSize: 12, color: '#7a1f29', marginTop: 4 }}>{googleDocsApiError}</div>
                  )}
                </div>
                <button
                  type="button"
                  className={`gsStep__btn ${googleDocsApiConnected ? 'gsStep__btn--secondary' : 'gsStep__btn--primary'}`}
                  disabled={googleDocsApiBusy || googleDocsApiConnected === null || (!googleDocsApiHasCreds && !googleDocsApiConnected)}
                  onClick={googleDocsApiConnected ? handleDisconnectGoogleDocs : handleConnectGoogleDocs}
                >
                  {googleDocsApiBusy ? 'Working...' : googleDocsApiConnected ? 'Disconnect' : 'Connect Google'}
                </button>
              </div>
            )}

            {integrationPermissionPrompt && (
              <div style={{ marginTop: 8, padding: 10, background: 'rgba(204, 41, 54, 0.08)', borderRadius: 2, fontSize: 12, color: '#7a1f29' }}>
                <strong>Accessibility permission required for {integrationPermissionPrompt.displayName}.</strong>{' '}
                Academia needs macOS Accessibility permission to position the overlay over {integrationPermissionPrompt.displayName} windows. We've opened System Settings — once you grant Academia access there, return here and click the toggle again.
              </div>
            )}
          </div>
        </section>

        {/* ───────── Account ───────── */}
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
                  await window.workspacesAPI.deleteAll();
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

export default WorkspaceSettings;
