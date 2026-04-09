import React, { useState, useEffect, useCallback } from 'react';

function formatDwell(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString();
}

export const FileMonitorDebug: React.FC = () => {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<TodayFileSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const { running: r } = await window.fileMonitorAPI.status();
      setRunning(r);
    } catch {
      setRunning(false);
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const data = await window.fileMonitorAPI.getTodaySessions();
      setSessions(data);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchSessions();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchSessions]);

  const handleToggle = useCallback(async () => {
    setLoading(true);
    try {
      if (running) {
        await window.fileMonitorAPI.stop();
      } else {
        await window.fileMonitorAPI.start();
      }
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }, [running, fetchStatus]);

  return (
    <div className="debugSection">
      <div className="debugSection__title">File Monitor</div>

      <div className="debugSection__status">
        <div className={`debugSection__indicator ${running ? 'debugSection__indicator--running' : 'debugSection__indicator--stopped'}`} />
        <span>{running ? 'Started' : 'Stopped'}</span>
      </div>

      <div style={{ marginTop: 12, marginBottom: 20 }}>
        <button
          className={`debugSection__btn ${running ? 'debugSection__btn--stop' : 'debugSection__btn--start'}`}
          onClick={handleToggle}
          disabled={loading}
        >
          {loading ? '...' : running ? 'Stop File Monitor' : 'Start File Monitor'}
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="debugSection__subtitle" style={{ marginBottom: 6 }}>Supported Apps</div>
        <div style={{ fontSize: '0.8125rem', color: '#555', lineHeight: 1.6 }}>
          Microsoft Word, Microsoft Excel, Microsoft PowerPoint, Apple Preview
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div className="debugSection__subtitle">Today&apos;s Sessions</div>
        <button
          className="debugSection__btnInline"
          onClick={fetchSessions}
          disabled={sessionsLoading}
        >
          {sessionsLoading ? '...' : 'Refresh'}
        </button>
      </div>

      {sessions.length === 0 ? (
        <div style={{ fontSize: '0.8125rem', color: '#888' }}>
          No file sessions recorded today.
        </div>
      ) : (
        <div className="debugSection__tableWrap">
          <table className="debugSection__table">
            <thead>
              <tr>
                <th>App</th>
                <th>Document</th>
                <th>Dwell</th>
                <th>First Seen</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.app_name}</td>
                  <td>
                    <a
                      href="#"
                      title={s.document_url}
                      style={{ color: '#1a73e8', textDecoration: 'none', cursor: 'pointer' }}
                      onClick={(e) => { e.preventDefault(); window.fileMonitorAPI.openFile(s.document_url, s.app_bundle_id); }}
                    >
                      {s.document_url}
                    </a>
                  </td>
                  <td className="debugSection__mono">{formatDwell(s.total_dwell)}</td>
                  <td className="debugSection__mono">{formatTime(s.first_seen)}</td>
                  <td className="debugSection__mono">{formatTime(s.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
