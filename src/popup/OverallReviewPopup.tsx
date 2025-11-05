import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useNativeEvent, useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';

// Initialize bridge early
getBridgeInstance('overall-review-popup');

console.log('[OverallReviewPopup] Initializing...');
console.log('[OverallReviewPopup] Platform:', window.__messageBridge?.getPlatform());

interface Comment {
  id: string;
  title: string;
  content: string;
  expanded: boolean;
}

type TabType = 'major' | 'minor' | 'strengths' | 'figure';

const OverallReviewPopup: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('major');
  const [comments, setComments] = useState<Comment[]>([
    {
      id: '1',
      title: 'Main contribution not clearly distinguished from prior work',
      content: 'The paper should clearly distinguish its novel contributions from previous work in the field. Consider adding a dedicated section that outlines what specific advances this work makes beyond existing literature.',
      expanded: false
    },
    {
      id: '2',
      title: 'Results presented out of logical order — consider re-sequencing',
      content: 'The flow of results could be improved by reorganizing sections to follow a more logical progression. Consider presenting foundational results before building to more complex analyses.',
      expanded: false
    },
    {
      id: '3',
      title: 'Statistical tests not specified for key comparisons',
      content: 'Please specify which statistical tests were used for the main comparisons presented in Figures 3-5. Include information about correction for multiple comparisons if applicable.',
      expanded: false
    },
    {
      id: '4',
      title: 'Over-reliance on older or self-citations',
      content: 'The reference list shows a heavy reliance on older citations and self-citations. Consider incorporating more recent work from other groups in the field to provide better context.',
      expanded: false
    }
  ]);

  const { sendRequest, loading } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[OverallReviewPopup] Render - activeTab:', activeTab);

  // Listen for content updates from native
  useNativeEvent('updateContent', (msg) => {
    logJSON('[OverallReviewPopup] Content update received:', msg.payload);

    if (msg.payload?.comments) {
      setComments(msg.payload.comments);
    }
  });

  const handleDismiss = async () => {
    console.log('[OverallReviewPopup] Dismiss button clicked');

    try {
      const result = await sendRequest('buttonClick', {
        action: 'dismiss'
      });

      logJSON('[OverallReviewPopup] Dismiss response:', result);
    } catch (err) {
      console.error('[OverallReviewPopup] Dismiss failed:', err);
    }
  };

  const handleClose = async () => {
    console.log('[OverallReviewPopup] Close button clicked');

    try {
      const result = await sendRequest('buttonClick', {
        action: 'close'
      });

      logJSON('[OverallReviewPopup] Close response:', result);
    } catch (err) {
      console.error('[OverallReviewPopup] Close failed:', err);
    }
  };

  const toggleComment = (id: string) => {
    setComments(comments.map(comment =>
      comment.id === id ? { ...comment, expanded: !comment.expanded } : comment
    ));
  };

  const getTabComments = (tab: TabType): Comment[] => {
    // For now, showing the same comments for all tabs
    // In real implementation, filter based on tab type
    return comments;
  };

  const getTabLabel = (tab: TabType): string => {
    switch (tab) {
      case 'major': return 'Major comments';
      case 'minor': return 'Minor comments';
      case 'strengths': return 'Strengths';
      case 'figure': return 'Figure critique';
    }
  };

  const getTabDescription = (tab: TabType): string => {
    switch (tab) {
      case 'major':
        return 'Substantive issues that affect how the paper communicates its main scientific contribution or argument. These comments focus on framing, logic, or completeness — the kinds of revisions that would strengthen the overall story.';
      case 'minor':
        return 'Smaller issues with presentation, clarity, or technical details that should be addressed for publication quality.';
      case 'strengths':
        return 'Notable strengths of the manuscript that reviewers found particularly compelling or well-executed.';
      case 'figure':
        return 'Specific feedback on figures, including clarity, labeling, and presentation of visual data.';
    }
  };

  const tabComments = getTabComments(activeTab);

  return (
    <div style={styles.container}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerContent}>
            <h1 style={styles.title}>Overall review | Wed, 29 Oct</h1>
            <button
              className="dismiss-button"
              style={{
                ...styles.dismissButton,
                ...(loading ? styles.buttonDisabled : {})
              }}
              onClick={handleDismiss}
              disabled={loading || !isReady}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={styles.deleteIcon}>
                <path d="M15 3H5V5H15V3Z" fill="#ffffff"/>
                <path d="M16 6H4V17C4 17.5523 4.44772 18 5 18H15C15.5523 18 16 17.5523 16 17V6Z" fill="#ffffff"/>
                <path d="M8 9V15H10V9H8Z" fill="#0645B1"/>
                <path d="M12 9V15H14V9H12Z" fill="#0645B1"/>
              </svg>
              Dismiss
            </button>
          </div>

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
          {/* Sidebar */}
          <div style={styles.sidebar}>
            {(['major', 'minor', 'strengths', 'figure'] as TabType[]).map((tab) => (
              <button
                key={tab}
                className={`tab-button ${activeTab === tab ? 'active' : ''}`}
                style={{
                  ...styles.tabButton,
                  ...(activeTab === tab ? styles.tabButtonActive : {})
                }}
                onClick={() => setActiveTab(tab)}
              >
                {getTabLabel(tab)}
              </button>
            ))}
          </div>

          {/* Main content */}
          <div style={styles.mainContent}>
            {/* Tab header */}
            <div style={styles.tabHeader}>
              <h2 style={styles.tabTitle}>{getTabLabel(activeTab)}</h2>
              <p style={styles.tabDescription}>{getTabDescription(activeTab)}</p>
            </div>

            {/* Comments list */}
            <div style={styles.commentsList}>
              {tabComments.map((comment) => (
                <div
                  key={comment.id}
                  className="comment-item"
                  style={styles.commentItem}
                >
                  <button
                    className="comment-header"
                    style={styles.commentHeader}
                    onClick={() => toggleComment(comment.id)}
                  >
                    <div style={styles.commentHeaderContent}>
                      <span style={styles.commentNumber}>{comment.id}.</span>
                      <span style={styles.commentTitle}>{comment.title}</span>
                    </div>
                    <div style={styles.expandIconContainer}>
                      <svg
                        width="28.8"
                        height="28.8"
                        viewBox="0 0 24 24"
                        fill="none"
                        style={{
                          ...styles.expandIcon,
                          transform: comment.expanded ? 'rotate(180deg)' : 'rotate(0deg)'
                        }}
                      >
                        <path d="M7 10L12 15L17 10" stroke="#141413" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </button>

                  {comment.expanded && (
                    <div style={styles.commentContent}>
                      <p style={styles.commentText}>{comment.content}</p>
                    </div>
                  )}
                </div>
              ))}
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
  statusBar: {
    padding: '8px 16px',
    backgroundColor: '#fff3cd',
    color: '#856404',
    fontSize: '12px',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    borderBottom: '1px solid #ffeaa7',
    textAlign: 'center',
  },
  header: {
    padding: '40px 24px 0 24px',
    position: 'relative',
  },
  headerContent: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    paddingBottom: '0',
  },
  title: {
    flex: 1,
    fontSize: '28px',
    fontWeight: 400,
    lineHeight: '34px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  dismissButton: {
    backgroundColor: '#0645B1', // Figma: button-primary-fill
    color: '#ffffff',
    border: 'none',
    borderRadius: '16px',
    padding: '0 20px',
    height: '48px',
    fontSize: '16px',
    fontWeight: 600,
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    transition: 'background-color 0.15s ease-in-out',
    outline: 'none',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,
  deleteIcon: {
    flexShrink: 0,
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
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,
  contentArea: {
    flex: 1,
    display: 'flex',
    gap: '40px',
    overflow: 'hidden',
    paddingTop: '8px',
  },
  sidebar: {
    width: '148px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '24px 0 0 24px',
    flexShrink: 0,
  },
  tabButton: {
    backgroundColor: '#FFFFFF', // Figma: background-white
    border: 'none',
    borderRadius: '8px',
    padding: '4px 12px',
    height: '40px',
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: '18px',
    color: '#141413', // Figma: text-primary
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background-color 0.15s ease-in-out',
    outline: 'none',
    whiteSpace: 'pre-wrap',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,
  tabButtonActive: {
    backgroundColor: '#E6ECF7', // Figma: blue-300
    border: '1px solid #0645B1', // Figma: button-primary-stroke
    fontWeight: 600,
  },
  mainContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    padding: '24px 24px 0 0',
    overflow: 'auto',
    minWidth: 0,
  },
  tabHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  tabTitle: {
    fontSize: '20px',
    fontWeight: 600,
    lineHeight: '32px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  tabDescription: {
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#000000',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  commentsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  commentItem: {
    backgroundColor: '#FFFFFF', // Figma: background-white
    borderRadius: '16px',
    overflow: 'hidden',
  },
  commentHeader: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '16px 16px 16px 24px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    outline: 'none',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties,
  commentHeaderContent: {
    flex: 1,
    display: 'flex',
    gap: '4px',
    alignItems: 'flex-start',
    minWidth: 0,
  },
  commentNumber: {
    fontSize: '16px',
    fontWeight: 600,
    lineHeight: '20px',
    color: '#141413', // Figma: text-primary
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    flexShrink: 0,
  },
  commentTitle: {
    fontSize: '16px',
    fontWeight: 600,
    lineHeight: '20px',
    color: '#141413', // Figma: text-primary
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  expandIconContainer: {
    backgroundColor: '#EEF2F9', // Figma: background-light-blue
    borderRadius: '104px',
    width: '28.8px',
    height: '28.8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  expandIcon: {
    transition: 'transform 0.2s ease-in-out',
  },
  commentContent: {
    padding: '0 24px 24px 24px',
  },
  commentText: {
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413', // Figma: text-primary
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
    cursor: 'not-allowed',
    opacity: 0.6,
  },
};

// Add hover styles dynamically
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    .dismiss-button:hover:not(:disabled) {
      background-color: #053a8f !important;
    }

    .tab-button:hover:not(.active) {
      background-color: #f5f5f5 !important;
    }

    .comment-header:hover {
      background-color: #f9f9f9 !important;
    }

    .comment-item {
      transition: box-shadow 0.15s ease-in-out;
    }

    .close-button:hover {
      opacity: 0.7;
    }
  `;
  document.head.appendChild(styleElement);
}

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
