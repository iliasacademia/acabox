import React, { useState, useEffect, useCallback } from 'react';

export const OfficeAddinDebug: React.FC = () => {
  const [status, setStatus] = useState<{ word: boolean; powerpoint: boolean; excel: boolean; certTrusted: boolean; certExists: boolean }>({ word: false, powerpoint: false, excel: false, certTrusted: false, certExists: false });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await window.officeAddinAPI.status();
      setStatus(s);
    } catch {
      setStatus({ word: false, powerpoint: false, excel: false, certTrusted: false, certExists: false });
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSideload = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await window.officeAddinAPI.sideload();
      if (result.success) {
        setMessage('Sideloaded successfully. Restart Office apps to activate.');
      } else {
        setMessage(`Error: ${result.error}`);
      }
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  const handleRemove = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await window.officeAddinAPI.remove();
      if (result.success) {
        setMessage('Removed. Restart Office apps to take effect.');
      } else {
        setMessage(`Error: ${result.error}`);
      }
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  const apps = [
    { key: 'word' as const, label: 'Word' },
    { key: 'powerpoint' as const, label: 'PowerPoint' },
    { key: 'excel' as const, label: 'Excel' },
  ];

  const anyInstalled = status.word || status.powerpoint || status.excel;

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', color: '#888', marginBottom: 16, letterSpacing: '0.05em' }}>
        Office Add-in
      </div>

      <div style={{ marginBottom: 16 }}>
        {apps.map(({ key, label }) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              backgroundColor: status[key] ? '#22c55e' : '#ef4444',
              flexShrink: 0,
            }} />
            <span style={{ fontSize: '0.875rem', color: '#333' }}>
              {label}: {status[key] ? 'Installed' : 'Not installed'}
            </span>
          </div>
        ))}
      </div>

      <button
        onClick={handleSideload}
        disabled={loading}
        style={{
          width: '100%',
          padding: '6px 12px',
          fontSize: '0.8125rem',
          border: '1px solid #ddd',
          borderRadius: 4,
          background: '#fff',
          cursor: loading ? 'not-allowed' : 'pointer',
          color: '#333',
          opacity: loading ? 0.6 : 1,
          marginBottom: 8,
        }}
      >
        {loading ? '...' : 'Sideload Add-in'}
      </button>

      {anyInstalled && (
        <button
          onClick={handleRemove}
          disabled={loading}
          style={{
            width: '100%',
            padding: '6px 12px',
            fontSize: '0.8125rem',
            border: '1px solid #ddd',
            borderRadius: 4,
            background: '#fff',
            cursor: loading ? 'not-allowed' : 'pointer',
            color: '#c00',
            opacity: loading ? 0.6 : 1,
            marginBottom: 8,
          }}
        >
          Remove Add-in
        </button>
      )}

      <div style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', color: '#888', marginTop: 20, marginBottom: 12, letterSpacing: '0.05em' }}>
        Certificate
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          backgroundColor: status.certTrusted ? '#22c55e' : '#ef4444', flexShrink: 0,
        }} />
        <span style={{ fontSize: '0.875rem', color: '#333' }}>
          {status.certTrusted ? 'Trusted' : 'Not trusted'}
        </span>
      </div>

      <button
        onClick={async () => {
          setLoading(true);
          setMessage(null);
          try {
            const result = await window.officeAddinAPI.trustCert();
            setMessage(result.success ? 'Certificate trusted.' : `Error: ${result.error}`);
            await fetchStatus();
          } finally { setLoading(false); }
        }}
        disabled={loading || status.certTrusted}
        style={{
          width: '100%', padding: '6px 12px', fontSize: '0.8125rem',
          border: '1px solid #ddd', borderRadius: 4, background: '#fff',
          cursor: loading || status.certTrusted ? 'not-allowed' : 'pointer',
          color: '#333', opacity: loading || status.certTrusted ? 0.6 : 1, marginBottom: 8,
        }}
      >
        Trust Certificate
      </button>

      <button
        onClick={async () => {
          setLoading(true);
          setMessage(null);
          try {
            const result = await window.officeAddinAPI.removeCert();
            setMessage(result.success ? 'Certificate removed.' : `Error: ${result.error}`);
            await fetchStatus();
          } finally { setLoading(false); }
        }}
        disabled={loading || !status.certTrusted}
        style={{
          width: '100%', padding: '6px 12px', fontSize: '0.8125rem',
          border: '1px solid #ddd', borderRadius: 4, background: '#fff',
          cursor: loading || !status.certTrusted ? 'not-allowed' : 'pointer',
          color: '#c00', opacity: loading || !status.certTrusted ? 0.6 : 1, marginBottom: 8,
        }}
      >
        Untrust Certificate
      </button>

      {status.certExists && (
        <button
          onClick={async () => {
            setLoading(true);
            setMessage(null);
            try {
              const result = await window.officeAddinAPI.deleteCert();
              setMessage(result.success ? 'Certificate files deleted.' : `Error: ${result.error}`);
              await fetchStatus();
            } finally { setLoading(false); }
          }}
          disabled={loading}
          style={{
            width: '100%', padding: '6px 12px', fontSize: '0.8125rem',
            border: '1px solid #ddd', borderRadius: 4, background: '#fff',
            cursor: loading ? 'not-allowed' : 'pointer',
            color: '#c00', opacity: loading ? 0.6 : 1, marginBottom: 8,
          }}
        >
          Delete Certificate Files
        </button>
      )}

      {message && (
        <div style={{ fontSize: '0.75rem', color: '#666', marginTop: 6 }}>
          {message}
        </div>
      )}
    </div>
  );
};
