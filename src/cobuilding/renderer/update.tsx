import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

type UpdateState = 'prompt' | 'downloading' | 'error';

function UpdateWindow() {
  const [state, setState] = useState<UpdateState>('prompt');
  const [version, setVersion] = useState('');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    const onInit = (_: any, data: { version: string }) => {
      setVersion(data.version);
    };
    const onProgress = (_: any, data: { percent: number }) => {
      setDownloadPercent(Math.round(data.percent));
      setState('downloading');
    };
    const onError = (_: any, data: { message: string }) => {
      setErrorMessage(data.message);
      setState('error');
    };

    api.on('cobuild:update-init', onInit);
    api.on('cobuild:download-progress', onProgress);
    api.on('cobuild:update-error', onError);

    return () => {
      api.removeListener('cobuild:update-init', onInit);
      api.removeListener('cobuild:download-progress', onProgress);
      api.removeListener('cobuild:update-error', onError);
    };
  }, []);

  const downloadAndRestart = useCallback(() => {
    setState('downloading');
    setDownloadPercent(0);
    (window as any).electronAPI?.invoke('cobuild:download-and-restart');
  }, []);

  const cancel = useCallback(() => {
    (window as any).electronAPI?.invoke('cobuild:cancel-update');
  }, []);

  const retry = useCallback(() => {
    setState('downloading');
    setDownloadPercent(0);
    setErrorMessage('');
    (window as any).electronAPI?.invoke('cobuild:download-and-restart');
  }, []);

  const renderContent = () => {
    switch (state) {
      case 'prompt':
        return (
          <>
            <p>Update {version ? `v${version} ` : ''}is available.</p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={downloadAndRestart} style={buttonStyle}>Download & Restart</button>
              <button onClick={cancel} style={{ ...buttonStyle, background: '#666' }}>Cancel</button>
            </div>
          </>
        );
      case 'downloading':
        return (
          <>
            <p>Downloading update... {downloadPercent}%</p>
            <div style={{ width: '100%', height: '6px', background: '#333', borderRadius: '3px' }}>
              <div style={{ width: `${downloadPercent}%`, height: '100%', background: '#4a9eff', borderRadius: '3px', transition: 'width 0.3s' }} />
            </div>
          </>
        );
      case 'error':
        return (
          <>
            <p style={{ color: '#ff6b6b' }}>Update error: {errorMessage}</p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={retry} style={buttonStyle}>Retry</button>
              <button onClick={cancel} style={{ ...buttonStyle, background: '#666' }}>Cancel</button>
            </div>
          </>
        );
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', padding: '20px', boxSizing: 'border-box', textAlign: 'center' }}>
      {renderContent()}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: '8px 16px',
  border: 'none',
  borderRadius: '4px',
  background: '#4a9eff',
  color: 'white',
  cursor: 'pointer',
  fontSize: '14px',
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<UpdateWindow />);
}
