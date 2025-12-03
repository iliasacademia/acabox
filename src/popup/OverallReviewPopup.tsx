import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useNativeEvent, useSendMessage, useBridgeReady, getBridgeInstance } from './hooks/useBridge';
import { logJSON } from './utils/logger';

// Initialize bridge early
getBridgeInstance('overall-review-popup');

console.log('[OverallReviewPopup] Initializing...');
console.log('[OverallReviewPopup] Platform:', window.__messageBridge?.getPlatform());

// Parse serverUrl from query params (passed by native bridge)
const urlParams = new URLSearchParams(window.location.search);
const serverUrl = urlParams.get('serverUrl') || 'http://127.0.0.1:23111';

interface Comment {
  id: string;
  title: string;
  content: string;
  expanded: boolean;
  model?: string;
}

type TabType = 'major' | 'minor' | 'strengths' | 'figure';

// API Response interfaces
interface ReviewItem {
  title: string;
  critique: string;
  review_item_type: string;
  review_item_id: number;
  review_item_created_at: string;
  batch?: string;
  priority?: boolean;
  selected?: boolean;
  llm_model?: string;
  citations?: any[];
  follow_up_questions?: string[];
  framework_to_address?: string;
  individual_critiques?: any[];
  other_model_critiques?: any[];
}

interface ApiResponse {
  document: any;
  document_id: number;
  document_created_at: string;
  metadata: any;
  peer_review: {
    suggestions: ReviewItem[];
  };
}

// List documents API interfaces
interface Document {
  id: number;
  title: string;
  updated_at: string;
  review_status: 'completed' | 'generating' | null;
  file_type: string;
  work_id: string | null;
}

interface ListDocumentsResponse {
  documents: Document[];
  pagination: {
    current_page: number;
    per_page: number;
    total_count: number;
    total_pages: number;
    has_more: boolean;
  };
}


const OverallReviewPopup: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('major');
  const [apiData, setApiData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [majorComments, setMajorComments] = useState<Comment[]>([]);
  const [strengthsComments, setStrengthsComments] = useState<Comment[]>([]);

  const { sendRequest, loading: sendLoading } = useSendMessage();
  const isReady = useBridgeReady();

  console.log('[OverallReviewPopup] Render - activeTab:', activeTab);

  // Helper function to parse HTML and extract strength items
  const parseStrengthsHTML = (htmlContent: string): Comment[] => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');

    const strengthItems: Comment[] = [];

    // Look for div elements with class "strength-item"
    const strengthDivs = doc.querySelectorAll('div.strength-item');

    strengthDivs.forEach((div, index) => {
      // Find the h2 with class "strength-title" for the title
      const titleEl = div.querySelector('h2.strength-title');
      const title = titleEl?.textContent?.trim() || `Strength ${index + 1}`;

      // Find the div with class "strength-content" for the content
      const contentEl = div.querySelector('div.strength-content');
      const content = contentEl?.innerHTML || '';

      strengthItems.push({
        id: `strength-${index + 1}`,
        title: title,
        content: content,
        expanded: false
      });
    });

    return strengthItems;
  };

  // Helper function to transform API data to comments
  const transformReviewItems = (items: ReviewItem[]): { major: Comment[], strengths: Comment[] } => {
    const major: Comment[] = [];
    let strengths: Comment[] = [];

    items.forEach((item, index) => {
      if (item.review_item_type === 'strength') {
        // Parse the strengths HTML to extract individual strength items
        strengths = parseStrengthsHTML(item.critique);
        // Add model info to all strength items
        strengths = strengths.map(s => ({ ...s, model: item.llm_model }));
      } else {
        // All non-strength items go to major tab
        major.push({
          id: `major-${index + 1}`,
          title: item.title,
          content: item.critique,
          expanded: false,
          model: item.llm_model
        });
      }
    });

    return { major, strengths };
  };

  // Helper function to format date in user's timezone
  const formatReviewDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
  };

  // Fetch data from API
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        console.log('[OverallReviewPopup] Starting API fetch...');

        // Step 1: Fetch list of documents
        console.log('[OverallReviewPopup] Fetching list of documents...');
        const listResponse = await fetch(
          `${serverUrl}/proxy-api/v0/writing_agent/list_documents?subdomain_param=api&page=1&per_page=10`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            },
          }
        );

        console.log('[OverallReviewPopup] List response received:', listResponse.status, listResponse.statusText);

        if (!listResponse.ok) {
          const errorText = await listResponse.text();
          console.error('[OverallReviewPopup] Error response:', errorText);
          throw new Error(`HTTP ${listResponse.status}: ${listResponse.statusText}`);
        }

        const listData: ListDocumentsResponse = await listResponse.json();
        console.log('[OverallReviewPopup] List data parsed successfully', {
          totalDocuments: listData.documents.length,
          completedCount: listData.documents.filter(d => d.review_status === 'completed').length
        });

        // Step 2: Find the latest completed review
        const completedDocuments = listData.documents.filter(d => d.review_status === 'completed');

        if (completedDocuments.length === 0) {
          throw new Error('No completed reviews available');
        }

        // Sort by updated_at descending to get the latest
        completedDocuments.sort((a, b) => {
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });

        const latestDocument = completedDocuments[0];
        console.log('[OverallReviewPopup] Latest completed document:', {
          id: latestDocument.id,
          title: latestDocument.title,
          updated_at: latestDocument.updated_at
        });

        // Step 3: Fetch the document details
        console.log('[OverallReviewPopup] Fetching document details...');
        const response = await fetch(
          `${serverUrl}/proxy-api/v0/writing_agent/get_document?subdomain_param=api&document_id=${latestDocument.id}`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            },
          }
        );

        console.log('[OverallReviewPopup] Document response received:', response.status, response.statusText);

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[OverallReviewPopup] Error response:', errorText);
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data: ApiResponse = await response.json();
        console.log('[OverallReviewPopup] Data parsed successfully');
        setApiData(data);

        // Transform the data
        const { major, strengths } = transformReviewItems(data.peer_review.suggestions);
        setMajorComments(major);
        setStrengthsComments(strengths);

        console.log('[OverallReviewPopup] Data loaded successfully', {
          documentId: latestDocument.id,
          majorCount: major.length,
          strengthsCount: strengths.length
        });
      } catch (err) {
        console.error('[OverallReviewPopup] Failed to fetch data:', err);
        const errorMessage = err instanceof Error ? err.message : 'Failed to load review data';
        console.error('[OverallReviewPopup] Error details:', {
          name: err instanceof Error ? err.name : 'Unknown',
          message: errorMessage,
          stack: err instanceof Error ? err.stack : undefined
        });
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  // Listen for content updates from native
  useNativeEvent('updateContent', (msg) => {
    logJSON('[OverallReviewPopup] Content update received:', msg.payload);

    if (msg.payload?.comments) {
      // This would override API data if needed
      // setComments(msg.payload.comments);
    }
  });

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
    // Toggle based on which tab is active
    if (activeTab === 'major') {
      setMajorComments(majorComments.map(comment =>
        comment.id === id ? { ...comment, expanded: !comment.expanded } : comment
      ));
    } else if (activeTab === 'strengths') {
      setStrengthsComments(strengthsComments.map(comment =>
        comment.id === id ? { ...comment, expanded: !comment.expanded } : comment
      ));
    }
  };

  const getTabComments = (tab: TabType): Comment[] => {
    switch (tab) {
      case 'major':
        return majorComments;
      case 'strengths':
        return strengthsComments;
      case 'minor':
      case 'figure':
        return []; // Empty for now as per requirements
      default:
        return [];
    }
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
          <h1 style={styles.title}>
            Overall review{apiData ? ` | ${formatReviewDate(apiData.document_created_at)}` : ''}
          </h1>

          {/* Close button */}
          <button
            className="close-button"
            style={styles.closeButton}
            onClick={handleClose}
            disabled={sendLoading || !isReady}
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
              {loading && (
                <div style={styles.emptyState}>
                  <p style={styles.emptyStateText}>Loading review data...</p>
                </div>
              )}

              {error && (
                <div style={styles.emptyState}>
                  <p style={styles.emptyStateText}>Error: {error}</p>
                </div>
              )}

              {!loading && !error && tabComments.length === 0 && (
                <div style={styles.emptyState}>
                  <p style={styles.emptyStateText}>
                    {activeTab === 'minor' || activeTab === 'figure'
                      ? 'No items in this category'
                      : 'No comments available'}
                  </p>
                </div>
              )}

              {!loading && !error && tabComments.map((comment, index) => (
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
                      <span style={styles.commentNumber}>{index + 1}.</span>
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
                      <div
                        style={styles.commentText}
                        dangerouslySetInnerHTML={{ __html: comment.content }}
                      />
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
  emptyState: {
    padding: '40px 24px',
    textAlign: 'center',
  },
  emptyStateText: {
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#6B6B6B',
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, sans-serif',
    margin: 0,
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
};

// Add hover styles dynamically
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
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
