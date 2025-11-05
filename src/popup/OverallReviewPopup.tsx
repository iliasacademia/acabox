import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useNativeEvent, useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';

// Initialize bridge early
getBridgeInstance('overall-review-popup');

console.log('[OverallReviewPopup] Initializing...');
console.log('[OverallReviewPopup] Platform:', window.__messageBridge?.getPlatform());

interface Suggestion {
  id: string;
  title: string;
  content: string;
}

interface SearchResult {
  found: boolean;
  text?: string;
  charIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

const OverallReviewPopup: React.FC = () => {
  const [count, setCount] = useState(0);
  const [searchText, setSearchText] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const { sendRequest, loading, error } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[OverallReviewPopup] Render - count:', count);

  // Listen for content updates from native
  useNativeEvent('updateContent', (msg) => {
    logJSON('[OverallReviewPopup] Content update received:', msg.payload);

    if (msg.payload?.count !== undefined) {
      const newCount = msg.payload.count;
      console.log('[OverallReviewPopup] Setting count:', newCount);
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
    console.log('[OverallReviewPopup] See more button clicked');

    try {
      const result = await sendRequest('buttonClick', {
        action: 'seeMore',
        count: count
      });

      logJSON('[OverallReviewPopup] See more response:', result);
    } catch (err) {
      console.error('[OverallReviewPopup] See more failed:', err);
    }
  };

  const handleDismiss = async () => {
    console.log('[OverallReviewPopup] Dismiss button clicked');

    try {
      const result = await sendRequest('buttonClick', {
        action: 'dismiss',
        count: count
      });

      logJSON('[OverallReviewPopup] Dismiss response:', result);
    } catch (err) {
      console.error('[OverallReviewPopup] Dismiss failed:', err);
    }
  };

  const handleSearch = async () => {
    if (!searchText.trim()) {
      return;
    }

    console.log('[OverallReviewPopup] Searching for text:', searchText);
    setIsSearching(true);
    setSearchResult(null);

    try {
      const result = await sendRequest('searchTextPosition', {
        text: searchText
      });

      console.log('[OverallReviewPopup] Search response:', JSON.stringify(result, null, 2));
      console.log('[OverallReviewPopup] Payload:', JSON.stringify(result.payload, null, 2));
      setSearchResult(result.payload as SearchResult);
    } catch (err) {
      console.error('[OverallReviewPopup] Search failed:', err);
      setSearchResult({ found: false });
    } finally {
      setIsSearching(false);
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

        {/* Note: Header removed - now rendered as native NSView above WKWebView */}

        {/* Text Search */}
        <div style={styles.searchContainer}>
          <div style={styles.searchInputContainer}>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleSearch();
                }
              }}
              placeholder="Search text in document..."
              style={styles.searchInput}
              disabled={isSearching || !isReady}
            />
            <button
              style={{
                ...styles.searchButton,
                ...(isSearching || !isReady ? styles.buttonDisabled : {})
              }}
              onClick={handleSearch}
              disabled={isSearching || !isReady}
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </div>

          {/* Search Result Display */}
          {searchResult && (
            <div style={searchResult.found ? styles.searchResultSuccess : styles.searchResultError}>
              {searchResult.found ? (
                <>
                  <div style={styles.searchResultTitle}>✓ Found "{searchResult.text}"</div>
                  <div style={styles.searchResultDetails}>
                    <div>Character index: {searchResult.charIndex}</div>
                    <div>Position: ({searchResult.x?.toFixed(1)}, {searchResult.y?.toFixed(1)})</div>
                    <div>Size: {searchResult.width?.toFixed(1)} × {searchResult.height?.toFixed(1)}</div>
                  </div>
                </>
              ) : (
                <div style={styles.searchResultTitle}>✗ "{searchResult.text || searchText}" not found</div>
              )}
            </div>
          )}
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
  suggestionsContainer: {
    flex: 1,
    overflow: 'auto',
    padding: '12px',
    backgroundColor: '#ffffff',
  },
  suggestionCard: {
    backgroundColor: '#f8f9fa',
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
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,
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
  searchContainer: {
    padding: '12px 16px',
    backgroundColor: '#f8f9fa',
    borderBottom: '1px solid #e9ecef',
  },
  searchInputContainer: {
    display: 'flex',
    gap: '8px',
    marginBottom: '8px',
  },
  searchInput: {
    flex: 1,
    padding: '8px 12px',
    fontSize: '13px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    border: '1px solid #ced4da',
    borderRadius: '4px',
    outline: 'none',
  } as React.CSSProperties,
  searchButton: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 500,
    color: '#ffffff',
    backgroundColor: '#28a745',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    outline: 'none',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  searchResultSuccess: {
    padding: '10px',
    backgroundColor: '#d4edda',
    border: '1px solid #c3e6cb',
    borderRadius: '4px',
    fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  searchResultError: {
    padding: '10px',
    backgroundColor: '#f8d7da',
    border: '1px solid #f5c6cb',
    borderRadius: '4px',
    fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  searchResultTitle: {
    fontWeight: 600,
    marginBottom: '6px',
    color: '#155724',
  },
  searchResultDetails: {
    fontSize: '11px',
    color: '#155724',
    fontFamily: 'monospace',
    lineHeight: '1.6',
  },
};

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<OverallReviewPopup />);
  console.log('[OverallReviewPopup] React app initialized');
} else {
  console.error('[OverallReviewPopup] Root container not found!');
}

// Wait for bridge to be ready
const checkReady = setInterval(() => {
  const bridge = window.__messageBridge;
  if (bridge && bridge.isConnected()) {
    console.log('[OverallReviewPopup] Bridge connected and ready');
    clearInterval(checkReady);
  }
}, 100);

// Timeout after 5 seconds
setTimeout(() => {
  const bridge = window.__messageBridge;
  if (!bridge || !bridge.isConnected()) {
    console.error('[OverallReviewPopup] Bridge connection timeout - native bridge may not be initialized');
    clearInterval(checkReady);
  }
}, 5000);

export default OverallReviewPopup;
