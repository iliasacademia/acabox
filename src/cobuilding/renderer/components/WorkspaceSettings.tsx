import React, { useState, useEffect } from 'react';
import type { Workspace } from '../../shared/types';
import './WorkspaceSettings.css';

interface WorkspaceSettingsProps {
  workspace: Workspace;
  onClose: () => void;
  onSaved: (ws: Workspace) => void;
}

const WorkspaceSettings: React.FC<WorkspaceSettingsProps> = ({ workspace, onClose, onSaved }) => {
  const [name, setName] = useState(workspace.name);
  const [directoryPath, setDirectoryPath] = useState(workspace.directory_path);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [soulContent, setSoulContent] = useState('');
  const [soulLoaded, setSoulLoaded] = useState(false);

  const [allWorkspaces, setAllWorkspaces] = useState<Workspace[]>([]);
  const [isSwitching, setIsSwitching] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDirectory, setNewDirectory] = useState('');
  const [newDirectoryOverridden, setNewDirectoryOverridden] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    window.soulPromptAPI.get().then(({ content }) => {
      setSoulContent(content);
      setSoulLoaded(true);
    });
    window.workspacesAPI.list().then(setAllWorkspaces);
  }, []);

  useEffect(() => {
    if (newDirectoryOverridden || !newName.trim()) return;
    window.workspacesAPI.getDefaultDirectory(newName.trim()).then(setNewDirectory);
  }, [newName, newDirectoryOverridden]);

  const canSave = name.trim().length > 0 && directoryPath.length > 0 && !isSaving;

  const handleChangeDirectory = async () => {
    const selected = await window.workspacesAPI.selectDirectory();
    if (selected) {
      setDirectoryPath(selected);
      setError(null);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setError(null);
    setIsSaving(true);
    try {
      await window.soulPromptAPI.set(soulContent);
      const updated = await window.workspacesAPI.update({ name: name.trim(), directoryPath });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update workspace.');
      setIsSaving(false);
    }
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

  return (
    <div className="wsSettings" onClick={onClose}>
      <div className="wsSettings__card" onClick={(e) => e.stopPropagation()}>
        <h2 className="wsSettings__title">Workspace Settings</h2>

        {/* Workspace switcher */}
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

        {/* Current workspace settings */}
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

        <div className="wsSettings__field">
          <label className="wsSettings__label">System Prompt</label>
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
        </div>

        {error && <p className="gsStep__error">{error}</p>}

        <div className="wsSettings__actions">
          <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="gsStep__btn gsStep__btn--primary" disabled={!canSave} onClick={handleSave}>
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceSettings;
