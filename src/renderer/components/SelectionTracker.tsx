import React, { useState, useEffect } from 'react';

const SelectionTracker: React.FC = () => {
  const [isEnabled, setIsEnabled] = useState(false);
  const [status, setStatus] = useState('Disabled');
  const [error, setError] = useState<string | null>(null);
  const [currentSelection, setCurrentSelection] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (isEnabled) {
        stopTracking();
      }
    };
  }, [isEnabled]);

  const startTracking = async () => {
    try {
      setStatus('Starting selection tracking...');
      setError(null);

      const result = await window.electronAPI.invoke('start-selection-tracking');

      if (!result.success) {
        setError(result.error || 'Failed to start selection tracking');
        setStatus('Error');
        setIsEnabled(false);
        return;
      }

      setIsEnabled(true);
      setStatus('Selection tracking enabled - Select text in Microsoft Word');
    } catch (error) {
      console.error('Error starting selection tracking:', error);
      setError(`Exception: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      setStatus('Error');
      setIsEnabled(false);
    }
  };

  const stopTracking = async () => {
    try {
      await window.electronAPI.invoke('stop-selection-tracking');
      setIsEnabled(false);
      setStatus('Disabled');
      setError(null);
      setCurrentSelection(null);
    } catch (error) {
      console.error('Error stopping selection tracking:', error);
    }
  };

  const toggleTracking = async () => {
    if (isEnabled) {
      await stopTracking();
    } else {
      await startTracking();
    }
  };

  // Listen for selection updates from main process
  useEffect(() => {
    const handleSelectionUpdate = (_event: any, selection: string) => {
      setCurrentSelection(selection);
      setStatus(`Selection detected: "${selection.substring(0, 50)}${selection.length > 50 ? '...' : ''}"`);
    };

    window.electronAPI.on('selection-updated', handleSelectionUpdate);

    return () => {
      window.electronAPI.removeAllListeners('selection-updated');
    };
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h1>Word Selection Tracker</h1>
      <p>
        This feature tracks text selection in Microsoft Word and displays an interactive button when text is selected.
      </p>

      <div style={{ marginTop: '20px' }}>
        <button
          onClick={toggleTracking}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: isEnabled ? '#dc3545' : '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
          }}
        >
          {isEnabled ? 'Disable' : 'Enable'} Selection Tracking
        </button>
      </div>

      <div style={{ marginTop: '20px' }}>
        <strong>Status:</strong> {status}
      </div>

      {error && (
        <div
          style={{
            marginTop: '15px',
            padding: '15px',
            backgroundColor: '#f8d7da',
            border: '1px solid #f5c2c7',
            borderRadius: '5px',
            color: '#842029',
          }}
        >
          <strong>Error:</strong>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
            fontFamily: 'monospace',
            fontSize: '13px',
            margin: '10px 0 0 0',
            padding: '10px',
            backgroundColor: 'rgba(0,0,0,0.05)',
            borderRadius: '4px',
            maxHeight: '300px',
            overflowY: 'auto'
          }}>
            {error}
          </pre>
          {error.includes('permission') && (
            <div style={{ marginTop: '10px' }}>
              <button
                onClick={() => {
                  window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
                }}
                style={{
                  padding: '8px 16px',
                  fontSize: '14px',
                  backgroundColor: '#842029',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Open System Settings
              </button>
            </div>
          )}
        </div>
      )}

      {currentSelection && (
        <div style={{ marginTop: '20px' }}>
          <h2>Current Selection:</h2>
          <div
            style={{
              marginTop: '10px',
              padding: '15px',
              backgroundColor: '#e8f4f8',
              border: '1px solid #bee5eb',
              borderRadius: '5px',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              maxHeight: '200px',
              overflowY: 'auto',
            }}
          >
            {currentSelection}
          </div>
        </div>
      )}
    </div>
  );
};

export default SelectionTracker;
