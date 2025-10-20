import React, { useState, useRef, useEffect } from 'react';

interface WordDocument {
  name: string;
  content: string;
}

const WordReader: React.FC = () => {
  const [isEnabled, setIsEnabled] = useState(false);
  const [status, setStatus] = useState('Disabled');
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<WordDocument[]>([]);
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
      setStatus('Requesting permission to access Microsoft Word...');
      setError(null);

      // Try to access Word first to trigger permission request
      const testResult = await window.electronAPI.invoke('get-word-text');

      if (!testResult.success) {
        // Check for automation permission errors (AppleScript control)
        if (testResult.isPermissionError || (testResult.error && (
          testResult.error.toLowerCase().includes('not authorized') ||
          testResult.error.toLowerCase().includes('not allowed') ||
          testResult.error.includes('-1743') ||
          testResult.error.toLowerCase().includes('apple event')
        ))) {
          const errorMsg = 'Automation permission required.\n\nPlease grant permission:\n1. Open System Settings (System Preferences on older macOS)\n2. Go to Privacy & Security > Automation\n3. Enable "Microsoft Word" under this app\n4. Restart this app and try again';
          setError(errorMsg);
          setStatus('Permission required');
          setIsEnabled(false);
          return;
        }

        // Check for accessibility permission errors
        if (testResult.error && (
          testResult.error.includes('accessibility') ||
          testResult.error.includes('is not allowed assistive access')
        )) {
          const errorMsg = 'Accessibility permission required. Please go to System Preferences > Privacy & Security > Accessibility and enable this app.';
          setError(errorMsg);
          setStatus('Permission required');
          setIsEnabled(false);
          return;
        }

        // Check if Word is not running
        if (!testResult.isRunning) {
          setError(testResult.error);
          setStatus('Word not running');
          setIsEnabled(false);
          return;
        }

        // Check if no documents are open
        if (testResult.error && testResult.error.includes('No documents are open')) {
          const errorMsg = 'No Word documents are open. Please open a document in Microsoft Word and try again.';
          setError(errorMsg);
          setStatus('No documents open');
          setIsEnabled(false);
          return;
        }

        // Other errors - show the actual error message with raw result
        let errorMsg = `Failed to connect: ${testResult.error || 'Could not connect to Microsoft Word'}`;
        if (testResult.rawResult) {
          errorMsg += `\n\nRaw AppleScript output:\n${testResult.rawResult}`;
        }
        setError(errorMsg);
        setStatus('Connection failed');
        setIsEnabled(false);
        console.error('Full test result:', testResult);
        return;
      }

      // Successfully connected
      setIsEnabled(true);
      setDocuments(testResult.documents || []);
      setLastReadTime(new Date().toLocaleTimeString());
      const docCount = testResult.documents?.length || 0;
      setStatus(`Word reader enabled - Reading from ${docCount} Word document${docCount !== 1 ? 's' : ''}`);

      // Start polling every 5 seconds
      pollingIntervalRef.current = setInterval(() => {
        fetchWordText();
      }, 5000);

    } catch (error) {
      console.error('Error starting Word reader:', error);
      const errorMsg = `Exception: ${error instanceof Error ? error.message : JSON.stringify(error)}`;
      setError(errorMsg);
      setStatus('Error');
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
    setError(null);
    setDocuments([]);
    setLastReadTime(null);
  };

  const fetchWordText = async () => {
    try {
      const result = await window.electronAPI.invoke('get-word-text');

      if (!result.success) {
        // Check if Word is not running
        if (!result.isRunning) {
          setStatus(result.error);
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
      setDocuments(result.documents || []);
      setLastReadTime(new Date().toLocaleTimeString());

      const docCount = result.documents?.length || 0;
      if (result.isFrontmost) {
        setStatus(`Word reader enabled - Reading from ${docCount} Word document${docCount !== 1 ? 's' : ''}`);
      } else {
        setStatus(`Word reader enabled - Word is in background (${docCount} document${docCount !== 1 ? 's' : ''})`);
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
          {(error.includes('System Settings') || error.includes('System Preferences') || error.includes('permission required')) && (
            <div style={{ marginTop: '10px' }}>
              <button
                onClick={() => {
                  if (error.toLowerCase().includes('automation') || error.toLowerCase().includes('apple event')) {
                    window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
                  } else if (error.toLowerCase().includes('accessibility')) {
                    window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
                  }
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

      {lastReadTime && (
        <div style={{ marginTop: '10px' }}>
          <strong>Last updated:</strong> {lastReadTime}
        </div>
      )}

      {documents.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <h2>Document{documents.length > 1 ? 's' : ''} Content:</h2>
          {documents.map((doc, docIndex) => (
            <div key={docIndex} style={{ marginTop: '20px' }}>
              <h3 style={{
                fontSize: '18px',
                fontWeight: 'bold',
                marginBottom: '10px',
                color: '#495057'
              }}>
                {doc.name}
              </h3>
              <div
                style={{
                  marginTop: '10px',
                  padding: '15px',
                  backgroundColor: '#f8f9fa',
                  border: '1px solid #dee2e6',
                  borderRadius: '5px',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  maxHeight: '400px',
                  overflowY: 'auto',
                }}
              >
                {doc.content.split(/\r\n|\r|\n/).map((line, index) => (
                  <p key={index} style={{ margin: '0 0 1em 0' }}>
                    {line || '\u00A0'}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default WordReader;
