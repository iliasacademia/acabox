import React, { useState } from 'react';
import { useNativeEvent, useSendMessage, useBridgeReady } from './hooks/useBridge';

const Popup: React.FC = () => {
  const [text, setText] = useState('');
  const { sendRequest, loading, error } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[Popup] Render - text state:', text ? text.substring(0, 50) : '(empty)');

  // Listen for content updates from native
  useNativeEvent('updateContent', (msg) => {
    console.log('[Popup] Content update received:', msg.payload);
    console.log('[Popup] Payload type:', typeof msg.payload);

    let newText = '';
    if (typeof msg.payload === 'string') {
      newText = msg.payload;
      console.log('[Popup] Setting text from string payload:', newText.substring(0, 50));
    } else if (msg.payload?.text) {
      newText = msg.payload.text;
      console.log('[Popup] Setting text from payload.text:', newText.substring(0, 50));
    } else {
      console.log('[Popup] Payload format not recognized');
      return;
    }

    console.log('[Popup] Calling setText with:', newText.substring(0, 50));
    setText(newText);
    console.log('[Popup] setText called, should trigger re-render');
  });

  const handleButtonClick = async (action: string) => {
    console.log('[Popup] Button clicked:', action);

    try {
      // Send request to native and await response
      const result = await sendRequest('buttonClick', {
        action: action,
        text: text
      });

      console.log('[Popup] Native response:', result);

      // Handle specific actions
      if (action === 'copy' && result?.success) {
        // Show temporary feedback
        console.log('[Popup] Text copied successfully');
      }
    } catch (err) {
      console.error('[Popup] Button click failed:', err);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {/* Connection status indicator (only show when not ready) */}
        {!isReady && (
          <div style={styles.statusBar}>
            Connecting to native...
          </div>
        )}

        <div style={styles.textContainer}>
          <div style={styles.textContent}>
            {text || 'No text selected'}
          </div>
        </div>

        <div style={styles.buttonContainer}>
          <button
            style={{
              ...styles.button,
              ...(loading ? styles.buttonDisabled : {})
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                (e.target as HTMLElement).style.backgroundColor = '#0056b3';
              }
            }}
            onMouseLeave={(e) => {
              if (!loading) {
                (e.target as HTMLElement).style.backgroundColor = '#007bff';
              }
            }}
            onClick={() => handleButtonClick('lookup')}
            disabled={loading || !isReady}
          >
            {loading ? 'Loading...' : 'Lookup'}
          </button>

          <button
            style={{
              ...styles.button,
              ...styles.secondaryButton,
              ...(loading ? styles.buttonDisabled : {})
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                (e.target as HTMLElement).style.backgroundColor = '#5a6268';
              }
            }}
            onMouseLeave={(e) => {
              if (!loading) {
                (e.target as HTMLElement).style.backgroundColor = '#6c757d';
              }
            }}
            onClick={() => handleButtonClick('copy')}
            disabled={loading || !isReady}
          >
            {loading ? 'Loading...' : 'Copy'}
          </button>
        </div>

        {/* Error display */}
        {error && (
          <div style={styles.errorBar}>
            Error: {error.message}
          </div>
        )}
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: '12px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15), 0 2px 6px rgba(0, 0, 0, 0.1)',
    overflow: 'hidden',
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  statusBar: {
    padding: '8px 16px',
    backgroundColor: '#fff3cd',
    color: '#856404',
    fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    borderBottom: '1px solid #ffeaa7',
    textAlign: 'center',
  },
  textContainer: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
    backgroundColor: '#f8f9fa',
  },
  textContent: {
    fontSize: '14px',
    lineHeight: '1.6',
    color: '#212529',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
  },
  buttonContainer: {
    display: 'flex',
    gap: '8px',
    padding: '12px 16px',
    backgroundColor: '#ffffff',
    borderTop: '1px solid #e9ecef',
  },
  button: {
    flex: 1,
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: 500,
    color: '#ffffff',
    backgroundColor: '#007bff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease-in-out',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    outline: 'none',
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  secondaryButton: {
    backgroundColor: '#6c757d',
  },
  errorBar: {
    padding: '8px 16px',
    backgroundColor: '#f8d7da',
    color: '#721c24',
    fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    borderTop: '1px solid #f5c6cb',
    textAlign: 'center',
  },
};

export default Popup;
