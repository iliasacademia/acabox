import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useUserPreferences } from '../contexts/UserPreferencesContext';
import { getZoteroStatus, disconnectZotero, syncZotero, getZoteroAuthorizeUrl, ZoteroStatus } from '../services/zoteroApi';
import { IPC_CHANNELS } from '../../shared/types';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onViewConversations?: () => void;
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, onViewConversations }) => {
  const { preferences: currentPreferences, updatePreferences } = useUserPreferences();
  const [autoDiffReview, setAutoDiffReview] = useState(currentPreferences.auto_diff_review);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Zotero state
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef<number>(0);

  // All-apps monitor feature flag state
  const [allAppsMonitorEnabled, setAllAppsMonitorEnabled] = useState(false);

  // Sandbox state
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState<string | null>(null);
  const [sandboxRunning, setSandboxRunning] = useState(false);

  // Manuscript refresh state
  const [isRefreshingManuscripts, setIsRefreshingManuscripts] = useState(false);
  const [manuscriptRefreshError, setManuscriptRefreshError] = useState<string | null>(null);
  const [manuscriptRefreshSuccess, setManuscriptRefreshSuccess] = useState(false);

  // Sync local state with context when modal opens
  useEffect(() => {
    if (isOpen) {
      setAutoDiffReview(currentPreferences.auto_diff_review);
      setError(null);
      setManuscriptRefreshError(null);
      setManuscriptRefreshSuccess(false);
      setIsLoadingStatus(true);
      getZoteroStatus().then(setZoteroStatus).finally(() => setIsLoadingStatus(false));
      window.electronAPI.invoke(IPC_CHANNELS.GET_ALL_APPS_MONITOR_ENABLED).then((v: boolean) => setAllAppsMonitorEnabled(v));
      window.electronAPI.invoke(IPC_CHANNELS.PODMAN_GET_STATUS).then((s: { running: boolean }) => setSandboxRunning(s.running));
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

  const handleSyncZotero = async () => {
    setIsSyncing(true);
    const previousSyncedAt = zoteroStatus?.last_synced_at ?? null;
    try {
      await syncZotero();
      const pollStart = Date.now();
      const pollForSync = async () => {
        const status = await getZoteroStatus();
        setZoteroStatus(status);
        if (
          status.last_synced_at !== previousSyncedAt ||
          Date.now() - pollStart > MAX_POLL_DURATION_MS
        ) {
          setIsSyncing(false);
          return;
        }
        setTimeout(pollForSync, POLL_INTERVAL_MS);
      };
      setTimeout(pollForSync, POLL_INTERVAL_MS);
    } catch (err: any) {
      console.error('[SettingsModal] Zotero sync failed:', err);
      setIsSyncing(false);
    }
  };

  const handleRefreshManuscriptData = async () => {
    setIsRefreshingManuscripts(true);
    setManuscriptRefreshError(null);
    setManuscriptRefreshSuccess(false);
    try {
      const result = await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);
      if (result.success) {
        setManuscriptRefreshSuccess(true);
      } else {
        setManuscriptRefreshError(result.error || 'Failed to refresh manuscript data');
      }
    } catch (err: any) {
      setManuscriptRefreshError(err.message || 'Failed to refresh manuscript data');
    } finally {
      setIsRefreshingManuscripts(false);
    }
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
                  {isLoadingStatus
                    ? 'Checking connection...'
                    : isPolling
                      ? 'Waiting for authorization...'
                      : isConnected
                        ? `Connected as ${zoteroStatus?.zotero_username || 'user'}${zoteroStatus?.last_synced_at ? ` · Last synced ${new Date(zoteroStatus.last_synced_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`
                        : 'Connect your Zotero library to sync references'
                  }
                </div>
              </div>
              <div className="zoteroAction">
                {isLoadingStatus ? null : isConnected ? (
                  <>
                    <button
                      className="zoteroButton zoteroButtonSync"
                      onClick={handleSyncZotero}
                      disabled={isSyncing}
                    >
                      {isSyncing ? 'Syncing...' : 'Sync'}
                    </button>
                    <button
                      className="zoteroButton zoteroButtonDisconnect"
                      onClick={handleDisconnectZotero}
                      disabled={isDisconnecting}
                    >
                      {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                    </button>
                  </>
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

          <div className="settingsSection">
            <div className="settingItem zoteroSettingItem">
              <div className="settingContent">
                <div className="settingLabel">Manuscript Data</div>
                <div className="settingDescription">
                  Refresh the cached manuscript file paths used for Word integration
                </div>
                {manuscriptRefreshSuccess && (
                  <div className="manuscriptRefreshSuccess">Refreshed successfully</div>
                )}
                {manuscriptRefreshError && (
                  <div className="manuscriptRefreshError">{manuscriptRefreshError}</div>
                )}
              </div>
              <div className="zoteroAction">
                <button
                  className="zoteroButton zoteroButtonSync"
                  onClick={handleRefreshManuscriptData}
                  disabled={isRefreshingManuscripts}
                >
                  {isRefreshingManuscripts ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>
          </div>

          {currentPreferences.show_experimental_features && (
            <>
              <div className="settingsSectionLabel">Experimental</div>
              <div className="settingsSection">
                <div className="settingItem zoteroSettingItem">
                  <div className="settingContent">
                    <div className="settingLabel">Monitor All Apps</div>
                    <div className="settingDescription">
                      Enable writing feedback across all applications, not just Microsoft Word
                    </div>
                  </div>
                  <div className="zoteroAction">
                    <button
                      className={`zoteroButton ${allAppsMonitorEnabled ? 'zoteroButtonDisconnect' : 'zoteroButtonConnect'}`}
                      onClick={() => window.electronAPI.invoke(IPC_CHANNELS.SET_ALL_APPS_MONITOR_ENABLED, !allAppsMonitorEnabled)}
                    >
                      {allAppsMonitorEnabled ? 'Disable and Restart' : 'Enable and Restart'}
                    </button>
                  </div>
                </div>
                <div className="settingItem zoteroSettingItem">
                  <div className="settingContent">
                    <div className="settingLabel">All Apps Conversations</div>
                    <div className="settingDescription">
                      View conversations from the all apps monitor
                    </div>
                  </div>
                  <div className="zoteroAction">
                    <button
                      className="zoteroButton zoteroButtonConnect"
                      onClick={() => { onViewConversations?.(); }}
                    >
                      View Conversations
                    </button>
                  </div>
                </div>
              </div>

              <div className="settingsSectionLabel">Sandbox</div>
              <div className="settingsSection">
                <div className="settingItem zoteroSettingItem">
                  <div className="settingContent">
                    <div className="settingLabel">Code Sandbox</div>
                    <div className="settingDescription">
                      {sandboxLoading ? (sandboxStatus || 'Starting sandbox...') : sandboxRunning ? 'Sandbox is running' : 'Launch an isolated sandbox with Claude Code, data analysis tools, and a preview server'}
                    </div>
                  </div>
                  <div className="zoteroAction sandboxActions">
                    <button
                      className="zoteroButton zoteroButtonConnect"
                      disabled={sandboxLoading}
                      onClick={async () => {
                        setSandboxLoading(true);
                        setSandboxStatus('Starting sandbox...');
                        try {
                          const result = await window.electronAPI.invoke(IPC_CHANNELS.PODMAN_OPEN_SANDBOX) as { success: boolean; error?: string; logPath?: string };
                          if (result.success) {
                            setSandboxRunning(true);
                            setSandboxStatus(null);
                          } else {
                            setSandboxStatus(`Error: ${result.error}`);
                          }
                        } catch (err: unknown) {
                          setSandboxStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
                        } finally {
                          setSandboxLoading(false);
                        }
                      }}
                    >
                      {sandboxLoading ? 'Starting...' : 'Open Sandbox'}
                    </button>
                    <button
                      className="zoteroButton zoteroButtonConnect"
                      disabled={!sandboxRunning}
                      onClick={() => window.electronAPI.invoke(IPC_CHANNELS.PODMAN_OPEN_PREVIEW)}
                    >
                      Open Preview
                    </button>
                    <button
                      className="zoteroButton zoteroButtonConnect"
                      onClick={() => window.electronAPI.invoke(IPC_CHANNELS.PODMAN_OPEN_FOLDER)}
                    >
                      Open Folder
                    </button>
                    <button
                      className="zoteroButton zoteroButtonDisconnect"
                      disabled={sandboxLoading}
                      onClick={async () => {
                        setSandboxLoading(true);
                        setSandboxStatus('Removing sandbox...');
                        try {
                          const result = await window.electronAPI.invoke(IPC_CHANNELS.PODMAN_UNINSTALL) as { success: boolean; error?: string };
                          if (result.success) {
                            setSandboxRunning(false);
                            setSandboxStatus('Sandbox removed');
                          } else {
                            setSandboxStatus(`Error: ${result.error}`);
                          }
                        } catch (err: unknown) {
                          setSandboxStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
                        } finally {
                          setSandboxLoading(false);
                        }
                      }}
                    >
                      Uninstall
                    </button>
                  </div>
                </div>
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
