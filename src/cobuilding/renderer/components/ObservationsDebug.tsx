import React, { useEffect, useState, useCallback } from 'react';

declare global {
  interface Window {
    observationsAPI: {
      getBrowserSessions: () => Promise<any[]>;
      getFileSessions: () => Promise<any[]>;
      getSessionFiles: () => Promise<any[]>;
    };
  }
}

function truncate(str: string | null, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function formatDwell(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export const ObservationsDebug: React.FC = () => {
  const [browserSessions, setBrowserSessions] = useState<any[]>([]);
  const [fileSessions, setFileSessions] = useState<any[]>([]);
  const [sessionFiles, setSessionFiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [browser, files, sFiles] = await Promise.all([
        window.observationsAPI.getBrowserSessions(),
        window.observationsAPI.getFileSessions(),
        window.observationsAPI.getSessionFiles(),
      ]);
      setBrowserSessions(browser);
      setFileSessions(files);
      setSessionFiles(sFiles);
    } catch (err) {
      console.error('Failed to load observations:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 className="debugSection__title" style={{ margin: 0 }}>Observations</h2>
        <button className="debugSection__btn" onClick={refresh} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <h3 className="debugSection__subtitle">Browser Sessions ({browserSessions.length})</h3>
      <div className="debugSection__tableWrap">
        <table className="debugSection__table">
          <thead>
            <tr>
              <th>ID</th>
              <th>URL</th>
              <th>Title</th>
              <th>Date</th>
              <th>Dwell</th>
              <th>Scroll</th>
              <th>Snapshots</th>
              <th>Triage</th>
            </tr>
          </thead>
          <tbody>
            {browserSessions.map((s) => (
              <tr key={s.id ?? s.url}>
                <td>{s.id}</td>
                <td title={s.url}>{truncate(s.url, 50)}</td>
                <td title={s.title}>{truncate(s.title, 40)}</td>
                <td>{s.session_date}</td>
                <td>{formatDwell(s.total_dwell)}</td>
                <td>{(s.max_scroll_depth * 100).toFixed(0)}%</td>
                <td>{s.snapshot_count}</td>
                <td>{s.triage_state}</td>
              </tr>
            ))}
            {browserSessions.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: '#999' }}>No browser sessions</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="debugSection__subtitle">File Sessions ({fileSessions.length})</h3>
      <div className="debugSection__tableWrap">
        <table className="debugSection__table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Document URL</th>
              <th>App</th>
              <th>Window Title</th>
              <th>Date</th>
              <th>Dwell</th>
              <th>Polls</th>
            </tr>
          </thead>
          <tbody>
            {fileSessions.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td title={s.document_url}>{truncate(s.document_url, 50)}</td>
                <td>{s.app_name}</td>
                <td title={s.window_title}>{truncate(s.window_title, 40)}</td>
                <td>{s.session_date}</td>
                <td>{formatDwell(s.total_dwell)}</td>
                <td>{s.poll_count}</td>
              </tr>
            ))}
            {fileSessions.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: '#999' }}>No file sessions</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="debugSection__subtitle">Session Files ({sessionFiles.length})</h3>
      <div className="debugSection__tableWrap">
        <table className="debugSection__table">
          <thead>
            <tr>
              <th>ID</th>
              <th>ULID</th>
              <th>Type</th>
              <th>Session ID</th>
              <th>File Type</th>
              <th>Ext</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {sessionFiles.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td className="debugSection__mono">{s.ulid}</td>
                <td>{s.session_type}</td>
                <td>{s.session_id}</td>
                <td>{s.file_type}</td>
                <td>{s.file_ext}</td>
                <td>{s.created_at}</td>
              </tr>
            ))}
            {sessionFiles.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: '#999' }}>No session files</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
