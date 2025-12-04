import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useNativeEvent, useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';

// Initialize bridge early
getBridgeInstance('text-side-popup');

console.log('[TextSidePopup] Initializing...');
console.log('[TextSidePopup] Platform:', window.__messageBridge?.getPlatform());

interface Reference {
  id: string;
  title: string;
  citations: number;
  relevance: number;
  expanded: boolean;
}

interface CitationData {
  claim: string;
  location: string;
  explanation: string;
  references: Reference[];
}

const TextSidePopup: React.FC = () => {
  const [citationData, setCitationData] = useState<CitationData>({
    claim: '"Here we identify SWIFT, an Ig-like domain within the mSWI/SNF core module, as a conserved binding platform that links remodeler activity to lineage-specific TF engagement."',
    location: 'Introduction > Paragraph 1',
    explanation: 'This statement claims significant improvements in quality, productivity, and efficiency from integrating new technologies. Several sentences exceed 40 words, making them harder to follow...',
    references: [
      {
        id: '1',
        title: 'Pan, J. et al. Interrogation of Mammalian Protein Complex Structure, Function, and Membership Using Genome-Scale Fitness Screens. Cell Syst. 6, 555–568.e7 (2018). 509 citations',
        citations: 509,
        relevance: 91,
        expanded: false
      },
      {
        id: '2',
        title: 'Smith, A.B. et al. Uncovering the Dynamics of Cellular Signaling Networks through Integrative Approaches. Nature Rev. Mol. Cell Biol. 20, 1-17 (2019). 345 citations',
        citations: 345,
        relevance: 81,
        expanded: false
      },
      {
        id: '3',
        title: 'Lee, C. et al. The Role of Epigenetics in Cancer Progression and Therapy Resistance. Cancer Res. 79, 123-134 (2019). 678 citations',
        citations: 678,
        relevance: 59,
        expanded: false
      }
    ]
  });

  const [expandedExplanation, setExpandedExplanation] = useState(false);

  const { sendRequest, loading } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[TextSidePopup] Render');

  // Listen for content updates from native
  useNativeEvent('updateContent', (msg) => {
    logJSON('[TextSidePopup] Content update received:', msg.payload);

    if (msg.payload?.citationData) {
      setCitationData(msg.payload.citationData);
    }
  });

  const handleClose = async () => {
    console.log('[TextSidePopup] Close button clicked');

    try {
      const result = await sendRequest('buttonClick', {
        action: 'close'
      });

      logJSON('[TextSidePopup] Close response:', result);
    } catch (err) {
      console.error('[TextSidePopup] Close failed:', err);
    }
  };

  const getRelevanceBadgeStyle = (relevance: number): React.CSSProperties => {
    if (relevance >= 80) {
      return {
        backgroundColor: '#f0f8f1',
        color: '#000000'
      };
    } else {
      return {
        backgroundColor: '#f8f8f8',
        color: '#000000'
      };
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>Citation suggestion</h1>

          {/* Close button */}
          <button
            className="close-button"
            style={styles.closeButton}
            onClick={handleClose}
            disabled={loading || !isReady}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5L15 15" stroke="#141413" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Content area */}
        <div style={styles.contentArea}>
          {/* White content box */}
          <div style={styles.contentBox}>
            {/* Claim section */}
            <div style={styles.section}>
              <div style={styles.sectionHeader}>
                <h2 style={styles.sectionTitle}>A citation could strength this claim:</h2>
              </div>

              <p style={styles.location}>{citationData.location}</p>

              <div style={styles.quoteContainer}>
                <p style={styles.quoteText}>{citationData.claim}</p>
              </div>
            </div>

            {/* Explanation section */}
            <div style={styles.section}>
              <h2 style={styles.sectionTitle}>Explanation</h2>
              <p style={styles.explanationText}>
                {expandedExplanation ? citationData.explanation : citationData.explanation.slice(0, 150) + '... '}
                <button
                  className="read-more-button"
                  style={styles.readMoreButton}
                  onClick={() => setExpandedExplanation(!expandedExplanation)}
                >
                  {expandedExplanation ? 'Read less' : 'Read more'}
                </button>
              </p>
            </div>

            {/* Suggested citations section */}
            <div style={styles.section}>
              <h2 style={styles.sectionTitle}>Suggested citations</h2>

              <div style={styles.referencesList}>
                {citationData.references.map((ref) => (
                  <div key={ref.id} style={styles.referenceItem}>
                    <div style={styles.referenceHeader}>
                      <p style={styles.referenceTitle}>{ref.title}</p>
                      <div style={styles.relevanceBadge}>
                        <div style={{
                          ...styles.relevanceBadgeInner,
                          ...getRelevanceBadgeStyle(ref.relevance)
                        }}>
                          <span style={styles.relevanceText}>{ref.relevance}% relevant</span>
                        </div>
                      </div>
                    </div>

                    <div style={styles.referenceActions}>
                      <button className="action-link" style={styles.actionLink}>See abstract</button>
                      <button className="action-link" style={styles.actionLink}>Why this paper</button>
                      <button className="action-link" style={styles.actionLink}>Download</button>
                      <button className="action-link" style={styles.actionLink}>DOI</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
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
  modal: {
    backgroundColor: '#F9F8F6', // Figma: background-beige-light
    border: '1px solid #CCC9BC', // Figma: stroke-beige-light
    borderRadius: '16px',
    overflow: 'hidden',
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  header: {
    padding: '40px 24px 0 24px',
    position: 'relative',
    paddingBottom: '24px',
  },
  title: {
    fontSize: '28px',
    fontWeight: 400,
    lineHeight: '34px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  closeButton: {
    position: 'absolute',
    top: '12px',
    right: '16px',
    width: '20px',
    height: '20px',
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    zIndex: 10,
  } as React.CSSProperties,
  contentArea: {
    flex: 1,
    overflow: 'auto',
    padding: '0 24px 24px 24px',
  },
  contentBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: '16px',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  sectionHeader: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-start',
  },
  sectionTitle: {
    fontSize: '20px',
    fontWeight: 600,
    lineHeight: '32px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  location: {
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    paddingLeft: '0',
  },
  quoteContainer: {
    borderLeft: '3px solid #c8c8cf',
    paddingLeft: '24px',
  },
  quoteText: {
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  explanationText: {
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  readMoreButton: {
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    textDecoration: 'underline',
    cursor: 'pointer',
    outline: 'none',
  } as React.CSSProperties,
  referencesList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  referenceItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingBottom: '24px',
    borderBottom: 'none',
  },
  referenceHeader: {
    display: 'flex',
    gap: '24px',
    alignItems: 'flex-start',
    paddingBottom: '4px',
  },
  referenceTitle: {
    flex: 1,
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
    minWidth: 0,
  },
  relevanceBadge: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: '8px 0 0 0',
  },
  relevanceBadgeInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px 8px',
    borderRadius: '8px',
  },
  relevanceText: {
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: '20px',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  referenceActions: {
    display: 'flex',
    gap: '16px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  actionLink: {
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    textDecoration: 'underline',
    cursor: 'pointer',
    outline: 'none',
  } as React.CSSProperties,
};

// Add hover styles dynamically
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    .close-button:hover {
      opacity: 0.7;
    }

    .read-more-button:hover {
      opacity: 0.7;
    }

    .action-link:hover {
      opacity: 0.7;
    }
  `;
  document.head.appendChild(styleElement);
}

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<TextSidePopup />);
  console.log('[TextSidePopup] React app initialized');
} else {
  console.error('[TextSidePopup] Root container not found!');
}

// Wait for bridge to be ready
const checkReady = setInterval(() => {
  const bridge = window.__messageBridge;
  if (bridge && bridge.isConnected()) {
    console.log('[TextSidePopup] Bridge connected and ready');
    clearInterval(checkReady);
  }
}, 100);

// Timeout after 5 seconds
setTimeout(() => {
  const bridge = window.__messageBridge;
  if (!bridge || !bridge.isConnected()) {
    console.error('[TextSidePopup] Bridge connection timeout - native bridge may not be initialized');
    clearInterval(checkReady);
  }
}, 5000);

export default TextSidePopup;
