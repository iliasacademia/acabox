import React, { useState } from 'react';

export const HardResetDebug: React.FC<{ onRestartOnboarding?: () => void }> = ({ onRestartOnboarding }) => {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReset = async () => {
    setResetting(true);
    setError(null);
    try {
      const res = await window.debugAPI.hardResetWorkspace();
      if (!res.ok) {
        setError(res.error ?? 'Unknown error');
        setResetting(false);
        setConfirming(false);
        return;
      }
      await window.debugAPI.restartOnboarding();
      if (onRestartOnboarding) {
        onRestartOnboarding();
      } else {
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResetting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Hard Reset</h3>

      <div style={{
        marginBottom: 20,
        padding: '10px 12px',
        background: '#fff8ed',
        border: '1px solid #f5c26b',
        borderRadius: 6,
        fontSize: 13,
        color: '#7d4e00',
        lineHeight: 1.5,
      }}>
        <strong>Warning: This action is permanent and cannot be undone.</strong>
        <br />
        Deletes all data for the current workspace and returns to onboarding.
      </div>

      {!confirming ? (
        <div className="debugSection__actions">
          <button
            className="debugSection__btn debugSection__btn--stop"
            onClick={() => setConfirming(true)}
          >
            Hard Reset Workspace
          </button>
        </div>
      ) : (
        <div style={{
          padding: '14px 16px',
          background: '#fff0f0',
          border: '1px solid #fcc',
          borderRadius: 8,
        }}>
          <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: '#c00' }}>
            The following will be permanently deleted:
          </p>
          <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 13, color: '#444', lineHeight: 1.7 }}>
            <li>All chats and message history</li>
            <li>All briefings</li>
            <li>All calendar events, plans, and resources</li>
            <li>All applications in <code>.applications/</code></li>
            <li>All workspace configuration in <code>.academia/</code></li>
          </ul>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="debugSection__btn debugSection__btn--stop"
              onClick={handleReset}
              disabled={resetting}
              style={{ fontWeight: 600 }}
            >
              {resetting ? 'Resetting...' : 'Yes, Delete Everything'}
            </button>
            <button
              className="debugSection__btn"
              onClick={() => setConfirming(false)}
              disabled={resetting}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="debugSection__error" style={{ marginTop: 12 }}>
          Error: {error}
        </div>
      )}
    </div>
  );
};
