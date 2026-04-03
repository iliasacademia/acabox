import React, { useState } from 'react';
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
  const [apiKey, setApiKey] = useState(workspace.api_key);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const canSave = name.trim().length > 0 && directoryPath.length > 0 && apiKey.trim().length > 0 && !isSaving;

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
      const updated = await window.workspacesAPI.update({
        name: name.trim(),
        directoryPath,
        apiKey: apiKey.trim(),
      });
      onSaved(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update workspace.';
      setError(message);
      setIsSaving(false);
    }
  };

  return (
    <div className="wsSettings" onClick={onClose}>
      <div className="wsSettings__card" onClick={(e) => e.stopPropagation()}>
        <h2 className="wsSettings__title">Workspace Settings</h2>

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
          <label className="wsSettings__label">Anthropic API Key</label>
          <input
            type="password"
            className="gsStep__input"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
          />
        </div>

        {error && <p className="gsStep__error">{error}</p>}

        <div className="wsSettings__actions">
          <button
            type="button"
            className="gsStep__btn gsStep__btn--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="gsStep__btn gsStep__btn--primary"
            disabled={!canSave}
            onClick={handleSave}
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceSettings;
