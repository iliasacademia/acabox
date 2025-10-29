import React, { useState } from 'react';
import { useNativeEvent, useSendMessage, useBridgeReady } from './hooks/useBridge';

interface Suggestion {
  id: string;
  title: string;
  content: string;
}

const SuggestionsContainer: React.FC = () => {
  const [count, setCount] = useState(0);
  const { sendRequest, loading, error } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[SuggestionsContainer] Render - count:', count);

  // Listen for content updates from native
  useNativeEvent('updateContent', (msg) => {
    console.log('[SuggestionsContainer] Content update received:', msg.payload);

    if (msg.payload?.count !== undefined) {
      const newCount = msg.payload.count;
      console.log('[SuggestionsContainer] Setting count:', newCount);
      setCount(newCount);
    }
  });

  // Placeholder suggestions data
  const suggestions: Suggestion[] = [
    {
      id: '1',
      title: 'Grammar Suggestion',
      content: 'Consider revising this sentence for better clarity and conciseness.'
    },
    {
      id: '2',
      title: 'Style Improvement',
      content: 'This paragraph could benefit from more active voice construction.'
    },
    {
      id: '3',
      title: 'Vocabulary Enhancement',
      content: 'Try using a more specific word to convey your meaning more precisely.'
    }
  ];

  const handleSeeMore = async () => {
    console.log('[SuggestionsContainer] See more button clicked');

    try {
      const result = await sendRequest('buttonClick', {
        action: 'seeMore',
        count: count
      });

      console.log('[SuggestionsContainer] See more response:', result);
    } catch (err) {
      console.error('[SuggestionsContainer] See more failed:', err);
    }
  };

  const handleDismiss = async () => {
    console.log('[SuggestionsContainer] Dismiss button clicked');

    try {
      const result = await sendRequest('buttonClick', {
        action: 'dismiss',
        count: count
      });

      console.log('[SuggestionsContainer] Dismiss response:', result);
    } catch (err) {
      console.error('[SuggestionsContainer] Dismiss failed:', err);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {/* Connection status indicator */}
        {!isReady && (
          <div style={styles.statusBar}>
            Connecting to native...
          </div>
        )}

        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Suggestions</h2>
          <div style={styles.badge}>{count}</div>
        </div>

        {/* Suggestions list */}
        <div style={styles.suggestionsContainer}>
          {suggestions.map((suggestion) => (
            <div key={suggestion.id} style={styles.suggestionCard}>
              <h3 style={styles.suggestionTitle}>{suggestion.title}</h3>
              <p style={styles.suggestionContent}>{suggestion.content}</p>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div style={styles.buttonContainer}>
          <button
            style={{
              ...styles.button,
              ...styles.primaryButton,
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
            onClick={handleSeeMore}
            disabled={loading || !isReady}
          >
            {loading ? 'Loading...' : 'See more'}
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
            onClick={handleDismiss}
            disabled={loading || !isReady}
          >
            {loading ? 'Loading...' : 'Dismiss'}
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
  header: {
    padding: '16px',
    backgroundColor: '#f8f9fa',
    borderBottom: '1px solid #e9ecef',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
    color: '#212529',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  badge: {
    backgroundColor: '#007bff',
    color: '#ffffff',
    borderRadius: '12px',
    padding: '4px 10px',
    fontSize: '12px',
    fontWeight: 600,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  suggestionsContainer: {
    flex: 1,
    overflow: 'auto',
    padding: '12px',
    backgroundColor: '#ffffff',
  },
  suggestionCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: '8px',
    padding: '12px',
    marginBottom: '8px',
    border: '1px solid #e9ecef',
  },
  suggestionTitle: {
    margin: '0 0 8px 0',
    fontSize: '14px',
    fontWeight: 600,
    color: '#495057',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  suggestionContent: {
    margin: 0,
    fontSize: '13px',
    lineHeight: '1.5',
    color: '#6c757d',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
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
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease-in-out',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    outline: 'none',
  },
  primaryButton: {
    backgroundColor: '#007bff',
  },
  secondaryButton: {
    backgroundColor: '#6c757d',
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
    cursor: 'not-allowed',
    opacity: 0.6,
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

export default SuggestionsContainer;
