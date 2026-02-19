import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useUserPreferences } from '../contexts/UserPreferencesContext';
import { getZoteroStatus, disconnectZotero, getZoteroAuthorizeUrl, ZoteroStatus } from '../services/zoteroApi';
import { IPC_CHANNELS } from '../../shared/types';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { preferences: currentPreferences, updatePreferences } = useUserPreferences();
  const [autoDiffReview, setAutoDiffReview] = useState(currentPreferences.auto_diff_review);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Zotero state
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef<number>(0);

  // Sync local state with context when modal opens
  useEffect(() => {
    if (isOpen) {
      setAutoDiffReview(currentPreferences.auto_diff_review);
      setError(null);
      getZoteroStatus().then(setZoteroStatus);
    } else {
      // Stop polling when modal closes
      stopPolling();
    }
  }, [isOpen, currentPreferences]);

  // Clean up poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    setIsPolling(false);
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    setIsPolling(true);
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

  const handleDisconnectZotero = async () => {
    setIsDisconnecting(true);
    try {
      await disconnectZotero();
      const status = await getZoteroStatus();
      setZoteroStatus(status);
    } catch (err: any) {
      console.error('[SettingsModal] Zotero disconnect failed:', err);
    } finally {
      setIsDisconnecting(false);
    }
  };

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

  const isConnected = zoteroStatus?.connected ?? false;

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

          <div className="settingsSectionLabel">Integrations</div>

          <div className="settingsSection">
            <div className="settingItem zoteroSettingItem">
              <div className="settingContent">
                <div className="settingLabel">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ verticalAlign: 'text-bottom', marginRight: 6 }}>
                    <text x="12" y="17" textAnchor="middle" fontFamily="DM Sans, sans-serif" fontSize="16" fontWeight="700" fill="#CC2936">Z</text>
                  </svg>
                  Zotero
                </div>
                <div className="settingDescription">
                  {isPolling
                    ? 'Waiting for authorization...'
                    : isConnected
                      ? `Connected as ${zoteroStatus?.zotero_username || 'user'}`
                      : 'Connect your Zotero library to sync references'
                  }
                </div>
              </div>
              <div className="zoteroAction">
                {isConnected ? (
                  <button
                    className="zoteroButton zoteroButtonDisconnect"
                    onClick={handleDisconnectZotero}
                    disabled={isDisconnecting}
                  >
                    {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                ) : (
                  <button
                    className="zoteroButton zoteroButtonConnect"
                    onClick={handleConnectZotero}
                    disabled={isPolling}
                  >
                    {isPolling ? 'Waiting...' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          </div>

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
