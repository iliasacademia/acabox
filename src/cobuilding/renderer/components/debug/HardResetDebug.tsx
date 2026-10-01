import React, { useState } from 'react';

export const HardResetDebug: React.FC = () => {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReset = async () => {
    setResetting(true);
    setError(null);
    try {
      // On success the main process relaunches the app into a fresh blank
      // workspace, so this promise usually never settles.
      const res = await window.debugAPI.hardResetWorkspace();
      if (!res.ok) {
        setError(res.error ?? 'Unknown error');
        setResetting(false);
        setConfirming(false);
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
        Deletes the chats, tools and workspace data listed below and relaunches the app with a fresh, empty workspace.
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
            <li>All chats and message history (the databases are recreated empty)</li>
            <li>The list of shared folders, your research profile, file activity and scheduled tasks</li>
            <li>The whole agent workspace: every tool in <code>.applications/</code>, the saved data in <code>tool-data/</code>, notebooks, servers I wrote in <code>.mcp-servers/</code>, and <code>.academia/</code></li>
            <li>Every chat's saved agent transcript (nothing could resume them once the chats are gone)</li>
          </ul>
          <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: '#444' }}>
            These survive:
          </p>
          <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 13, color: '#444', lineHeight: 1.7 }}>
            <li>The files inside your shared folders (they are only forgotten, not touched)</li>
            <li>Your API key, connectors and registered APIs (settings)</li>
            <li>Skills, including edits and imports</li>
            <li>Approved MCP servers (the copies Acabox runs), the Python environment and installed npm packages</li>
            <li>Connector sign-ins and the logs</li>
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
