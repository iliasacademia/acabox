import React, { useState, useEffect, useCallback } from 'react';

type Status = 'connected' | 'extension-inactive' | 'server-stopped';

export const BrowserExtensionDebug: React.FC = () => {
  const [status, setStatus] = useState<Status>('server-stopped');
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const { serverRunning, extensionConnected } = await window.browserMonitorAPI.status();
      if (!serverRunning) {
        setStatus('server-stopped');
      } else if (extensionConnected) {
        setStatus('connected');
      } else {
        setStatus('extension-inactive');
      }
    } catch {
      setStatus('server-stopped');
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleStart = useCallback(async () => {
    setLoading(true);
    try {
      await window.browserMonitorAPI.start();
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    try {
      await window.browserMonitorAPI.stop();
      await fetchStatus();
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  const statusConfig = {
    connected: { color: '#22c55e', label: 'Connected' },
    'extension-inactive': { color: '#eab308', label: 'Browser Extension Inactive' },
    'server-stopped': { color: '#ef4444', label: 'Server Stopped' },
  } as const;

  const { color, label } = statusConfig[status];
  const serverRunning = status !== 'server-stopped';

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', color: '#888', marginBottom: 16, letterSpacing: '0.05em' }}>
        Browser Extension
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          backgroundColor: color,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: '0.875rem', color: '#333' }}>{label}</span>
      </div>

      <div style={{ fontSize: '0.75rem', color: '#999', marginBottom: 12 }}>
        Connection status can take up to 5 seconds to update.
      </div>

      <button
        onClick={serverRunning ? handleStop : handleStart}
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
        }}
      >
        {loading ? '...' : serverRunning ? 'Stop Server' : 'Start Server'}
      </button>
    </div>
  );
};
