import React, { useState, useEffect } from 'react';

interface PopupProps {
  onUpdateCallback: (callback: (text: string) => void) => void;
}

const Popup: React.FC<PopupProps> = ({ onUpdateCallback }) => {
  const [text, setText] = useState('');

  useEffect(() => {
    // Register update callback
    onUpdateCallback((newText: string) => {
      setText(newText);
    });
  }, [onUpdateCallback]);

  const handleButtonClick = (action: string) => {
    console.log('Button clicked:', action);

    // Send message to native code via WKWebView message handler
    if (window.webkit?.messageHandlers?.buttonClick) {
      window.webkit.messageHandlers.buttonClick.postMessage({
        action: action,
        text: text
      });
    } else {
      console.warn('WKWebView message handler not available');
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.textContainer}>
          <div style={styles.textContent}>
            {text || 'No text selected'}
          </div>
        </div>

        <div style={styles.buttonContainer}>
          <button
            style={styles.button}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.backgroundColor = '#0056b3';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.backgroundColor = '#007bff';
            }}
            onClick={() => handleButtonClick('lookup')}
          >
            Lookup
          </button>

          <button
            style={{...styles.button, ...styles.secondaryButton}}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.backgroundColor = '#5a6268';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.backgroundColor = '#6c757d';
            }}
            onClick={() => handleButtonClick('copy')}
          >
            Copy
          </button>
        </div>
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
  secondaryButton: {
    backgroundColor: '#6c757d',
  },
};

export default Popup;
