import React, { useState, useEffect } from 'react';
import { useUserPreferences } from '../contexts/UserPreferencesContext';
import { IPC_CHANNELS } from '../../shared/types';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { preferences: currentPreferences, updatePreferences } = useUserPreferences();
  const [autoDiffReview, setAutoDiffReview] = useState(currentPreferences.auto_diff_review);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [popupVersion, setPopupVersion] = useState<'v1' | 'v2' | null>(null);
  const [switching, setSwitching] = useState(false);

  // Sync local state with context when modal opens
  useEffect(() => {
    if (isOpen) {
      setAutoDiffReview(currentPreferences.auto_diff_review);
      setError(null);
      setSwitching(false);
      // Fetch current popup version
      window.electronAPI.invoke(IPC_CHANNELS.GET_MS_WORD_VERSION)
        .then((version: string) => setPopupVersion(version as 'v1' | 'v2'))
        .catch(() => setPopupVersion(null));
    }
  }, [isOpen, currentPreferences]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Only send the specific field we're updating
      await updatePreferences({ auto_diff_review: autoDiffReview });
      onClose();
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to save preferences';
      setError(errorMessage.replace('API Error: ', ''));
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="wizardOverlay" onClick={handleOverlayClick}>
      <div className="wizardModal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <button className="wizardClose" onClick={onClose}>×</button>

        <div className="wizardContent">
          <h2 className="wizardTitle">Settings</h2>

          <div className="settingsSection">
            <div
              className={`settingItem ${autoDiffReview ? 'enabled' : ''}`}
              onClick={() => setAutoDiffReview(!autoDiffReview)}
            >
              <div className="settingCheckbox">
                {autoDiffReview && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M13.5 4L6 11.5L2.5 8" stroke="#0645b1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <div className="settingContent">
                <div className="settingLabel">Auto Diff Review</div>
                <div className="settingDescription">
                  Automatically review manuscript changes when files are synced
                </div>
              </div>
            </div>
          </div>

          {popupVersion && (
            <>
              <div className="settingsDivider" />
              <div className="settingsSection">
                <div className="settingContent" style={{ padding: '0' }}>
                  <div className="settingLabel">Word Popup Version</div>
                  <div className="settingDescription">
                    Currently using {popupVersion === 'v2' ? 'V2' : 'V1'}. Switching will restart the app.
                  </div>
                </div>
                <button
                  className="wizardButtonSecondary"
                  style={{ marginTop: '8px', alignSelf: 'flex-start' }}
                  disabled={switching}
                  onClick={() => {
                    setSwitching(true);
                    const target = popupVersion === 'v2' ? 'v1' : 'v2';
                    window.electronAPI.invoke(IPC_CHANNELS.SET_MS_WORD_VERSION, target);
                  }}
                >
                  {switching ? 'Restarting...' : `Switch to ${popupVersion === 'v2' ? 'V1' : 'V2'} and restart`}
                </button>
              </div>
            </>
          )}

          {error && <div className="settingsError">{error}</div>}

          <div className="wizardActions">
            <button className="wizardButtonSecondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button className="wizardButtonPrimary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
