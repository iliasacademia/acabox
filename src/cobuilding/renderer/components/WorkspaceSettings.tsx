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

  useEffect(() => {
    window.soulPromptAPI.get().then(({ content }) => {
      setSoulContent(content);
      setSoulLoaded(true);
    });
  }, []);

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
      const updated = await window.workspacesAPI.update({
        name: name.trim(),
        directoryPath,
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
