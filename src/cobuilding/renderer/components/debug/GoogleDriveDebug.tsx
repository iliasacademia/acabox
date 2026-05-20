import React, { useEffect, useState } from 'react';

interface CacheEntry {
  file_id: string;
  workspace_id: string;
  relative_path: string;
  parent_id: string | null;
  name: string;
  mime_type: string;
  modified_time: string | null;
  md5_checksum: string | null;
  downloaded_at: string | null;
}

export const GoogleDriveDebug: React.FC = () => {
  const [entries, setEntries] = useState<CacheEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);

  const loadEntries = () => {
    setLoading(true);
    (window as any).googleDriveAPI?.listCacheEntries?.()
      .then((data: CacheEntry[]) => setEntries(data ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadEntries(); }, []);

  const handleReset = async () => {
    setResetting(true);
    setResetResult(null);
    try {
      const result = await (window as any).googleDriveAPI.resetCache();
      if (result.success) {
        setResetResult('Cache cleared successfully.');
        setEntries([]);
      } else {
        setResetResult(`Error: ${result.error}`);
      }
    } catch (err: any) {
      setResetResult(`Error: ${err?.message ?? String(err)}`);
    } finally {
      setResetting(false);
    }
  };

  const downloaded = entries.filter(e => e.downloaded_at);
  const indexed = entries.filter(e => !e.downloaded_at);

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Google Drive Cache</h3>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          className="debugSection__btn"
          onClick={loadEntries}
          disabled={loading}
        >
          Refresh
        </button>
        <button
          className="debugSection__btn debugSection__btn--danger"
          onClick={handleReset}
          disabled={resetting}
        >
          {resetting ? 'Resetting...' : 'Reset Google Drive Cache'}
        </button>
        <button
          className="debugSection__btn debugSection__btn--danger"
          onClick={async () => {
            setRevoking(true);
            setResetResult(null);
            try {
              await (window as any).googleDocsAPI.disconnect();
              setResetResult('Google auth revoked. Tokens deleted.');
            } catch (err: any) {
              setResetResult(`Error: ${err?.message ?? String(err)}`);
            } finally {
              setRevoking(false);
            }
          }}
          disabled={revoking}
        >
          {revoking ? 'Revoking...' : 'Revoke Google Auth'}
        </button>
      </div>

      {resetResult && (
        <div className="debugSection__progress" style={{ marginBottom: 12 }}>
          {resetResult}
        </div>
      )}

      {loading ? (
        <div className="debugSection__progress">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="debugSection__progress">No Google Drive cache entries.</div>
      ) : (
        <>
          <div className="debugSection__infoRow" style={{ marginBottom: 8 }}>
            <span className="debugSection__infoLabel">Total entries:</span>
            <code className="debugSection__infoValue">{entries.length}</code>
          </div>
          <div className="debugSection__infoRow" style={{ marginBottom: 12 }}>
            <span className="debugSection__infoLabel">Downloaded files:</span>
            <code className="debugSection__infoValue">{downloaded.length}</code>
          </div>

          {downloaded.length > 0 && (
            <>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 6px', color: '#333' }}>Downloaded Files</h4>
              <div className="storageTree">
                {downloaded.map((e) => (
                  <div key={e.file_id} className="storageTree__row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <span className="storageTree__label">{e.relative_path}</span>
                    <span className="storageTree__desc debugSection__mono" style={{ fontSize: 11 }}>
                      {e.mime_type} &middot; modified {e.modified_time?.slice(0, 10) ?? '?'} &middot; downloaded {e.downloaded_at?.slice(0, 10) ?? '?'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {indexed.length > 0 && (
            <>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 6px', color: '#333' }}>Indexed (Not Downloaded)</h4>
              <div className="storageTree">
                {indexed.map((e) => (
                  <div key={e.file_id} className="storageTree__row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <span className="storageTree__label">{e.relative_path}</span>
                    <span className="storageTree__desc debugSection__mono" style={{ fontSize: 11 }}>
                      {e.mime_type} &middot; {e.name}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};
