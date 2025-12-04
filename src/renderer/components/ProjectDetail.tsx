import React, { useState, useEffect } from 'react';
import {
  Project,
  ProjectFile,
  ProjectFolder,
  Collaborator,
  ReviewSuggestion,
  getProjectFiles,
  getProjectFolders,
  getProjectCollaborators,
  addFolderToProject,
  addCollaborator,
} from '../services/projectsApi';
import { IPC_CHANNELS } from '../../shared/types';
import { useReviewPolling } from '../hooks/useReviewPolling';
import ProjectSidebar from './ProjectSidebar';
import AlertDialog from './AlertDialog';
import AddCollaboratorModal from './AddCollaboratorModal';

interface ProjectDetailProps {
  project: Project;
  onBack: () => void;
}

type ReviewTab = 'summary' | 'strengths' | 'major' | 'minor';

const ProjectDetail: React.FC<ProjectDetailProps> = ({ project, onBack }) => {
  const [manuscript, setManuscript] = useState<ProjectFile | null>(null);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [showCollaboratorModal, setShowCollaboratorModal] = useState(false);
  const [activeTab, setActiveTab] = useState<ReviewTab>('summary');
  const [expandedReviews, setExpandedReviews] = useState<Set<number>>(new Set());

  // Review polling hook
  const { agentRun, error: reviewError, startPolling } = useReviewPolling();

  useEffect(() => {
    loadProjectData();
  }, [project.id]);

  const loadProjectData = async () => {
    setLoading(true);
    try {
      const [filesData, foldersData, collaboratorsData] =
        await Promise.all([
          getProjectFiles(project.id),
          getProjectFolders(project.id),
          getProjectCollaborators(project.id),
        ]);

      // Find primary manuscript
      const primaryManuscript =
        filesData.find((f) => f.is_primary_manuscript) || null;

      setManuscript(primaryManuscript);
      setFolders(foldersData);
      setCollaborators(collaboratorsData);

      // Start polling for reviews if manuscript exists
      if (primaryManuscript) {
        startPolling(project.id, primaryManuscript.id);
      }
    } catch (error) {
      console.error('Error loading project data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddFolder = async () => {
    try {
      // Open folder selection dialog
      const folderPath = await window.electronAPI.invoke(IPC_CHANNELS.SELECT_FOLDER);

      if (!folderPath) {
        return; // User cancelled
      }

      // Add folder to project via API
      const newFolder = await addFolderToProject(project.id, folderPath);

      // Start syncing files from this folder
      const syncResult = await window.electronAPI.invoke(
        'start-project-folder-sync',
        project.id,
        newFolder.id,
        folderPath
      );

      if (!syncResult.success) {
        setAlertMessage(`Folder added but sync failed: ${syncResult.error}`);
        setShowAlert(true);
      } else {
        // Reload folders list
        const foldersData = await getProjectFolders(project.id);
        setFolders(foldersData);

        setAlertMessage('Folder added and syncing started successfully');
        setShowAlert(true);
      }
    } catch (error: any) {
      console.error('Error adding folder:', error);
      setAlertMessage(`Failed to add folder: ${error.message || 'Unknown error'}`);
      setShowAlert(true);
    }
  };

  const handleAddCollaborator = () => {
    setShowCollaboratorModal(true);
  };

  const handleAddCollaborators = async (emails: string[]) => {
    setShowCollaboratorModal(false);

    if (emails.length === 0) {
      return; // No emails to add
    }

    try {
      let successCount = 0;
      let failCount = 0;

      // Add each collaborator via API
      for (const email of emails) {
        try {
          await addCollaborator(project.id, email);
          successCount++;
        } catch (error: any) {
          console.error(`Error adding collaborator ${email}:`, error);
          failCount++;
        }
      }

      // Reload collaborators list
      const collaboratorsData = await getProjectCollaborators(project.id);
      setCollaborators(collaboratorsData);

      // Show result message
      if (successCount > 0 && failCount === 0) {
        setAlertMessage(
          `Successfully added ${successCount} collaborator${successCount !== 1 ? 's' : ''}`
        );
      } else if (successCount > 0 && failCount > 0) {
        setAlertMessage(
          `Added ${successCount} collaborator${successCount !== 1 ? 's' : ''}, ${failCount} failed`
        );
      } else {
        setAlertMessage('Failed to add collaborators');
      }
      setShowAlert(true);
    } catch (error: any) {
      console.error('Error adding collaborators:', error);
      setAlertMessage(`Failed to add collaborators: ${error.message || 'Unknown error'}`);
      setShowAlert(true);
    }
  };


  const toggleReviewExpansion = (reviewId: number) => {
    setExpandedReviews(prev => {
      const newSet = new Set(prev);
      if (newSet.has(reviewId)) {
        newSet.delete(reviewId);
      } else {
        newSet.add(reviewId);
      }
      return newSet;
    });
  };

  interface StrengthItem {
    title: string;
    content: string;
  }

  const extractStrengthItems = (html: string): StrengthItem[] => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    // Look for strength-item divs
    const strengthItems = tempDiv.querySelectorAll('.strength-item');

    if (strengthItems.length === 0) {
      // Fallback: look for h2 headings and split content
      const headings = tempDiv.querySelectorAll('h2');
      if (headings.length === 0) {
        return [];
      }

      const items: StrengthItem[] = [];
      headings.forEach((heading, index) => {
        const title = heading.textContent || '';

        // Get content between this heading and the next
        let content = '';
        let currentNode = heading.nextSibling;
        const nextHeading = headings[index + 1];

        while (currentNode && currentNode !== nextHeading) {
          if (currentNode.nodeType === Node.ELEMENT_NODE) {
            content += (currentNode as Element).outerHTML;
          } else if (currentNode.nodeType === Node.TEXT_NODE) {
            const text = currentNode.textContent?.trim();
            if (text) content += text;
          }
          currentNode = currentNode.nextSibling;
        }

        items.push({ title, content });
      });

      return items;
    }

    // Extract strength items with their titles and content
    const items: StrengthItem[] = [];
    strengthItems.forEach(item => {
      const titleEl = item.querySelector('.strength-title, h2, h3, h4');
      const contentEl = item.querySelector('.strength-content');

      const title = titleEl?.textContent || 'Strength';
      const content = contentEl?.innerHTML || item.innerHTML;

      items.push({ title, content });
    });

    return items;
  };

  const filterReviews = (suggestions: ReviewSuggestion[]): ReviewSuggestion[] => {
    switch (activeTab) {
      case 'summary':
        return []; // Summary shows the review_data.summary text, not individual items
      case 'major':
        return suggestions.filter(s => s.review_item_type !== 'strength' && s.major === true);
      case 'minor':
        return suggestions.filter(s => s.review_item_type !== 'strength' && s.major === false);
      case 'strengths':
        return suggestions.filter(s => s.review_item_type === 'strength');
      default:
        return suggestions;
    }
  };

  const getTabLabel = (tab: ReviewTab): string => {
    switch (tab) {
      case 'summary': return 'Summary';
      case 'major': return 'Major comments';
      case 'minor': return 'Minor comments';
      case 'strengths': return 'Strengths';
    }
  };

  const getTabDescription = (tab: ReviewTab): string => {
    switch (tab) {
      case 'summary':
        return 'An overall assessment of the manuscript\'s contributions, strengths, and areas for improvement.';
      case 'major':
        return 'Substantive issues that affect how the paper communicates its main scientific contribution or argument. These comments focus on framing, logic, or completeness — the kinds of revisions that would strengthen the overall story.';
      case 'minor':
        return 'Surface-level improvements such as typos, formatting inconsistencies, or minor phrasing adjustments that don\'t change the core argument.';
      case 'strengths':
        return 'What the paper does well — areas that effectively support the research goals and should be preserved or emphasized.';
    }
  };

  const formatReviewDate = (dateString: string): string => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Check if it's today
    if (date.toDateString() === today.toDateString()) {
      return `Today, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }

    // Check if it's yesterday
    if (date.toDateString() === yesterday.toDateString()) {
      return `Yesterday, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }

    // Otherwise, show full date
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
  };

  const renderReviewSection = () => {
    // No manuscript
    if (!manuscript) {
      return (
        <div className="projectDetailEmpty">
          <p>Upload a manuscript to receive AI-powered reviews</p>
        </div>
      );
    }

    // Polling error or timeout
    if (reviewError) {
      return (
        <div className="projectDetailEmpty projectDetailError">
          <p className="errorMessage">{reviewError}</p>
          <button
            className="wizardButtonPrimary"
            onClick={() => startPolling(project.id, manuscript.id)}
          >
            Retry
          </button>
        </div>
      );
    }

    // No agent run yet or processing
    if (!agentRun || agentRun.status === 'processing') {
      return (
        <div className="projectDetailEmpty">
          <div className="loadingSpinner"></div>
          <p>Analyzing manuscript... This may take 5-15 minutes.</p>
          {agentRun && agentRun.running_jobs_count !== undefined && agentRun.running_jobs_count > 0 && (
            <p className="progressText">
              {agentRun.running_jobs_count} analysis tasks remaining...
            </p>
          )}
        </div>
      );
    }

    // Completed
    if (agentRun.status === 'completed' && agentRun.review_data) {
      const { suggestions, summary } = agentRun.review_data;
      const suggestionsList = suggestions || [];
      const filteredReviews = filterReviews(suggestionsList);

      console.log('[ProjectDetail] Review data:', {
        summary,
        suggestionsCount: suggestionsList.length,
        activeTab,
        filteredCount: filteredReviews.length,
      });

      const tabs: ReviewTab[] = ['summary', 'strengths', 'major', 'minor'];
      const reviewDate = formatReviewDate(agentRun.created_at);

      return (
        <div className="reviewContainer">
          {/* Feedback Header */}
          <div className="reviewFeedbackHeader">
            <h2 className="reviewFeedbackTitle">Feedback & suggestions</h2>
            <p className="reviewFeedbackTimestamp">{reviewDate}</p>
          </div>

          {/* Overall Review Section Header */}
          <div className="reviewOverallHeader">
            <span className="reviewOverallLabel">Overall review</span>
            <span className="reviewOverallSeparator">|</span>
            <span className="reviewOverallDate">
              {new Date(agentRun.created_at).toLocaleDateString('en-US', {
                weekday: 'short',
                day: 'numeric',
                month: 'short'
              })}
            </span>
          </div>

          <div className="reviewTabbedLayout">
          {/* Tab Sidebar */}
          <div className="reviewTabSidebar">
            {tabs.map(tab => (
              <button
                key={tab}
                className={`reviewTab ${activeTab === tab ? 'reviewTabActive' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {getTabLabel(tab)}
              </button>
            ))}
          </div>

          {/* Main Content */}
          <div className="reviewTabContent">
            {/* Tab Header */}
            <div className="reviewTabHeader">
              <h3 className="reviewTabTitle">{getTabLabel(activeTab)}</h3>
              <p className="reviewTabDescription">{getTabDescription(activeTab)}</p>
            </div>

            {/* Summary Tab Content */}
            {activeTab === 'summary' && summary && (
              <div className="reviewSummaryContent">
                <p>{summary}</p>
              </div>
            )}

            {/* Other Tabs - Collapsible Items */}
            {activeTab !== 'summary' && (
              <div className="reviewItemsList">
                {filteredReviews.length > 0 ? (
                  <>
                    {activeTab === 'strengths' ? (
                      // For strengths, split into multiple items based on HTML structure
                      filteredReviews.flatMap((review) => {
                        const strengthItems = extractStrengthItems(review.critique || '');

                        if (strengthItems.length === 0) {
                          // Fallback to showing the whole review as one item
                          const isExpanded = expandedReviews.has(review.review_item_id);
                          return (
                            <div key={review.review_item_id} className="reviewItemCard">
                              <div
                                className="reviewItemHeader"
                                onClick={() => toggleReviewExpansion(review.review_item_id)}
                              >
                                <p className="reviewItemTitle">
                                  {review.title || 'Strength'}
                                </p>
                                <button className="reviewItemToggle">
                                  <span className={`reviewItemArrow ${isExpanded ? 'expanded' : ''}`}>
                                    ▼
                                  </span>
                                </button>
                              </div>
                              {isExpanded && (
                                <div className="reviewItemBody">
                                  <div
                                    className="reviewItemCritique"
                                    dangerouslySetInnerHTML={{ __html: review.critique || '' }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        }

                        return strengthItems.map((strengthItem, idx) => {
                          // Use a composite key: review_item_id + index
                          const itemKey = `${review.review_item_id}-${idx}`;
                          const itemId = review.review_item_id * 1000 + idx; // Unique ID for expansion tracking
                          const isExpanded = expandedReviews.has(itemId);

                          return (
                            <div key={itemKey} className="reviewItemCard">
                              <div
                                className="reviewItemHeader"
                                onClick={() => toggleReviewExpansion(itemId)}
                              >
                                <p className="reviewItemTitle">
                                  {strengthItem.title}
                                </p>
                                <button className="reviewItemToggle">
                                  <span className={`reviewItemArrow ${isExpanded ? 'expanded' : ''}`}>
                                    ▼
                                  </span>
                                </button>
                              </div>
                              {isExpanded && (
                                <div className="reviewItemBody">
                                  <div
                                    className="reviewItemCritique"
                                    dangerouslySetInnerHTML={{ __html: strengthItem.content }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        });
                      })
                    ) : (
                      // For major/minor comments, show numbered items
                      filteredReviews.map((review, index) => {
                        const isExpanded = expandedReviews.has(review.review_item_id);
                        const displayTitle = `${index + 1}. ${review.title}`;

                        return (
                          <div key={review.review_item_id} className="reviewItemCard">
                            <div
                              className="reviewItemHeader"
                              onClick={() => toggleReviewExpansion(review.review_item_id)}
                            >
                              <p className="reviewItemTitle">
                                {displayTitle}
                              </p>
                              <button className="reviewItemToggle">
                                <span className={`reviewItemArrow ${isExpanded ? 'expanded' : ''}`}>
                                  ▼
                                </span>
                              </button>
                            </div>
                            {isExpanded && (
                              <div className="reviewItemBody">
                                {review.critique && (
                                  <div
                                    className="reviewItemCritique"
                                    dangerouslySetInnerHTML={{ __html: review.critique }}
                                  />
                                )}
                                {review.framework_to_address && (
                                  <div className="reviewItemFramework">
                                    <div className="reviewItemFrameworkLabel">
                                      Suggested Framework to Address:
                                    </div>
                                    <div
                                      dangerouslySetInnerHTML={{ __html: review.framework_to_address }}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </>
                ) : (
                  <div className="projectDetailEmpty">
                    <p>No {getTabLabel(activeTab).toLowerCase()} available.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        </div>
      );
    }

    return null;
  };

  if (loading) {
    return (
      <div className="projectDetail">
        <div className="projectDetailLoading">
          <div className="loadingSpinner"></div>
          <p>Loading project...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="projectDetail">
      {/* Header */}
      <div className="projectDetailHeader">
        <button className="projectDetailBack" onClick={onBack}>
          ← Back
        </button>
        <h2 className="projectDetailTitle">{project.name}</h2>
      </div>

      {/* Main Content Area */}
      <div className="projectDetailContent">
        {/* Sidebar */}
        <ProjectSidebar
          manuscript={manuscript}
          folders={folders}
          collaborators={collaborators}
          onAddFolder={handleAddFolder}
          onAddCollaborator={handleAddCollaborator}
        />

        {/* Main Panel with Reviews */}
        <div className="projectDetailMain">
          <div className="projectDetailReviews">
            {renderReviewSection()}
          </div>
        </div>
      </div>

      {/* Alert Dialog */}
      {showAlert && (
        <AlertDialog
          title="Notice"
          message={alertMessage}
          onClose={() => setShowAlert(false)}
        />
      )}

      {/* Add Collaborator Modal */}
      {showCollaboratorModal && (
        <AddCollaboratorModal
          onClose={() => setShowCollaboratorModal(false)}
          onAdd={handleAddCollaborators}
        />
      )}
    </div>
  );
};

export default ProjectDetail;
