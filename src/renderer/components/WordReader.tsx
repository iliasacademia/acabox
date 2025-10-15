import React, { useState, useRef, useEffect } from 'react';

const WordReader: React.FC = () => {
  const [isEnabled, setIsEnabled] = useState(false);
  const [status, setStatus] = useState('Disabled');
  const [textContent, setTextContent] = useState<string>('');
  const [lastReadTime, setLastReadTime] = useState<string | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      stopWordReader();
    };
  }, []);

  const toggleWordReader = async () => {
    if (isEnabled) {
      stopWordReader();
    } else {
      await startWordReader();
    }
  };

  const startWordReader = async () => {
    try {
      setStatus('Connecting to Microsoft Word...');
      setIsEnabled(true);

      // Initial fetch
      await fetchWordText();

      // Start polling every 5 seconds
      pollingIntervalRef.current = setInterval(() => {
        fetchWordText();
      }, 5000);

    } catch (error) {
      console.error('Error starting Word reader:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsEnabled(false);
    }
  };

  const stopWordReader = () => {
    // Stop the polling interval
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    setIsEnabled(false);
    setStatus('Disabled');
    setTextContent('');
    setLastReadTime(null);
  };

  const fetchWordText = async () => {
    try {
      const result = await window.electronAPI.invoke('get-word-text');

      if (!result.success) {
        // Check if Word is not running
        if (!result.isRunning) {
          setStatus('Microsoft Word is not running');
          stopWordReader();
          return;
        }

        // Check if Word window was closed
        if (result.error && result.error.includes('No documents are open')) {
          setStatus('No Word documents are open');
          stopWordReader();
          return;
        }

        setStatus(`Error: ${result.error || 'Could not get Word content'}`);
        return;
      }

      // Successfully got content
      setTextContent(result.content);
      setLastReadTime(new Date().toLocaleTimeString());

      if (result.isFrontmost) {
        setStatus('Word reader enabled - Reading from active Word document');
      } else {
        setStatus('Word reader enabled - Word is in background');
      }

    } catch (error) {
      console.error('Error fetching Word text:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>Word Reader</h1>
      <p>
        This feature reads text content from your Microsoft Word documents and updates every 5 seconds.
      </p>

      <div style={{ marginTop: '20px' }}>
        <button
          onClick={toggleWordReader}
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
          {isEnabled ? 'Disable' : 'Enable'} Word Reader
        </button>
        {isEnabled && (
          <button
            onClick={fetchWordText}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer',
              marginLeft: '10px',
            }}
          >
            Refresh Now
          </button>
        )}
      </div>

      <div style={{ marginTop: '20px' }}>
        <strong>Status:</strong> {status}
      </div>

      {lastReadTime && (
        <div style={{ marginTop: '10px' }}>
          <strong>Last updated:</strong> {lastReadTime}
        </div>
      )}

      {textContent && (
        <div style={{ marginTop: '20px' }}>
          <h2>Document Content:</h2>
          <div
            style={{
              marginTop: '10px',
              padding: '15px',
              backgroundColor: '#f8f9fa',
              border: '1px solid #dee2e6',
              borderRadius: '5px',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              maxHeight: '500px',
              overflowY: 'auto',
            }}
          >
            {textContent.split(/\r\n|\r|\n/).map((line, index) => (
              <p key={index} style={{ margin: '0 0 1em 0' }}>
                {line || '\u00A0'}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default WordReader;
