import React, { useState, useEffect } from 'react';
import {
  Project,
  ProjectFile,
  AgentRun,
  getProjectFiles,
  getProjectStatus,
} from '../services/projectsApi';
import { IPC_CHANNELS } from '../../shared/types';
import { useCoScientistEvents } from '../hooks/useCoScientistEvents';
import AlertDialog from './AlertDialog';
import ConfirmDialog from './ConfirmDialog';

interface ProjectDetailProps {
  project: Project;
  onBack: () => void;
}

const ProjectDetail: React.FC<ProjectDetailProps> = ({ project, onBack }) => {
  const [manuscript, setManuscript] = useState<ProjectFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingReviewAction, setPendingReviewAction] = useState<'full' | 'changes' | null>(null);
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    loadProjectData();
  }, [project.id]);

  // Fetch review status for this project's manuscript
  const fetchReviewStatus = async (fileId?: number) => {
    if (!fileId) {
      console.log('[ProjectDetail] No fileId provided, skipping status fetch');
      return;
    }

    try {
      console.log('[ProjectDetail] Fetching review status:', { projectId: project.id, fileId });

      const statusData = await getProjectStatus(
        project.id,
        'science_agent',
        fileId
      );

      const run = statusData.agent_runs[0];

      if (run) {
        console.log('[ProjectDetail] Review status:', {
          status: run.status,
          running_jobs_count: run.running_jobs_count,
          has_review_data: !!run.review_data,
          suggestions_count: run.review_data?.suggestions?.length || 0,
        });

        setAgentRun(run);

        if (run.status === 'failed') {
          setReviewError('Review generation failed');
        } else {
          setReviewError(null);
        }
      }
    } catch (error) {
      console.error('[ProjectDetail] Failed to fetch review status:', error);
    }
  };

  // Listen for Co-Scientist events
  useCoScientistEvents({
    onReviewCompleted: async (event) => {
      console.log('[ProjectDetail] Review completed event received:', event);

      // Check if this event is for our project
      if (event.project_id === project.id && manuscript) {
        console.log('[ProjectDetail] Event matches current project, refreshing review status');

        // Fetch the latest review status
        await fetchReviewStatus(manuscript.id);

        // If the event includes a conversation_id, navigate to it
        if (event.data?.conversation_id) {
          console.log('[ProjectDetail] Review includes conversation, navigating:', {
            conversationId: event.data.conversation_id,
            projectId: project.id,
          });

          // Navigate to the conversation
          window.electronAPI.invoke(IPC_CHANNELS.NAVIGATE_TO_PAGE, {
            page: 'conversation',
            projectId: project.id,
            conversationId: event.data.conversation_id,
          });
        }
      }
    },
    onReviewFailed: (event) => {
      console.log('[ProjectDetail] Review failed event received:', event);

      // Check if this event is for our project
      if (event.project_id === project.id) {
        setReviewError('Review generation failed');
      }
    },
  });

  const loadProjectData = async () => {
    setLoading(true);
    try {
      const filesData = await getProjectFiles(project.id);

      // Find primary manuscript
      const primaryManuscript =
        filesData.find((f) => f.is_primary_manuscript) || null;

      setManuscript(primaryManuscript);

      // Fetch initial review status if manuscript exists
      if (primaryManuscript) {
        await fetchReviewStatus(primaryManuscript.id);
      }
    } catch (error) {
      console.error('Error loading project data:', error);
    } finally {
      setLoading(false);
    }
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
            onClick={() => fetchReviewStatus(manuscript.id)}
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
      const { summary } = agentRun.review_data;
      const reviewDate = new Date(agentRun.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });

      return (
        <div className="reviewContainer">
          {/* Review Header */}
          <div className="reviewSimpleHeader">
            <h2 className="reviewSimpleHeaderDate">{reviewDate}</h2>
            <h2 className="reviewSimpleHeaderTitle">Full Review</h2>
          </div>

          {/* Review Content */}
          <div className="reviewSimpleContent">
            {summary && (
              <div
                className="reviewSimpleText"
                dangerouslySetInnerHTML={{ __html: summary }}
              />
            )}
          </div>

          {/* Input Section */}
          <div className="reviewInputSection">
            <div className="reviewInputContainer">
              <input
                type="text"
                className="reviewInput"
                placeholder="Or ask anything..."
              />
              <button className="reviewInputButton">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="white"/>
                </svg>
              </button>
            </div>
            <button className="reviewFeedbackLink">
              Provide feedback on this review
            </button>
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

  const handleOpenFile = async () => {
    if (manuscript) {
      try {
        await window.electronAPI.invoke(IPC_CHANNELS.OPEN_FILE, manuscript.file_path);
      } catch (error) {
        console.error('[ProjectDetail] Failed to open file:', error);
      }
    }
  };

  const handleOpenFolder = async () => {
    if (manuscript) {
      try {
        await window.electronAPI.invoke(IPC_CHANNELS.SHOW_FILE_IN_FOLDER, manuscript.file_path);
      } catch (error) {
        console.error('[ProjectDetail] Failed to open folder:', error);
      }
    }
  };

  const runPreCheck = async (): Promise<{ canProceed: boolean; reason?: string; message?: string }> => {
    try {
      return await window.electronAPI.invoke(IPC_CHANNELS.REVIEW_PRE_CHECK);
    } catch (err) {
      console.error('[ProjectDetail] Pre-check error:', err);
      return { canProceed: true }; // fail-open
    }
  };

  const proceedWithReview = async (type: 'full' | 'changes') => {
    if (!manuscript) return;
    if (type === 'full') {
      await fetchReviewStatus(manuscript.id);
    } else {
      console.log('[ProjectDetail] Review changes clicked');
    }
  };

  const handlePreCheckAndReview = async (type: 'full' | 'changes') => {
    console.log('[ProjectDetail] Pre-check and review clicked', type);
    const preCheck = await runPreCheck();
    if (!preCheck.canProceed) {
      if (preCheck.reason === 'duplicate_name') {
        setAlertMessage(preCheck.message || 'Multiple windows have the same name.');
        setShowAlert(true);
        return;
      }
      if (preCheck.reason === 'unsaved_changes') {
        setPendingReviewAction(type);
        setShowSaveConfirm(true);
        return;
      }
    }
    await proceedWithReview(type);
  };

  const handleSaveAndContinue = async () => {
    setIsSaving(true);
    try {
      const result = await window.electronAPI.invoke(IPC_CHANNELS.WORD_SAVE_DOCUMENT);
      if (!result.success) {
        setAlertMessage(result.error || 'Failed to save document.');
        setShowAlert(true);
        setIsSaving(false);
        setShowSaveConfirm(false);
        return;
      }
      setShowSaveConfirm(false);
      setIsSaving(false);
      if (pendingReviewAction) {
        await proceedWithReview(pendingReviewAction);
      }
    } catch (err) {
      console.error('[ProjectDetail] Save error:', err);
      setAlertMessage('Failed to save document.');
      setShowAlert(true);
      setIsSaving(false);
      setShowSaveConfirm(false);
    }
  };

  const handleFullReview = () => handlePreCheckAndReview('full');

  const handleReviewChanges = () => handlePreCheckAndReview('changes');

  return (
    <div className="projectDetail">
      {/* Top Bar */}
      <div className="projectDetailTopBar">
        <div className="projectDetailTopBarLeft">
          <button className="projectDetailBackIcon" onClick={onBack}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" fill="currentColor"/>
            </svg>
          </button>
          {manuscript && (
            <>
              <div className="projectDetailDocIcon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" fill="#0645b1"/>
                </svg>
              </div>
              <h2 className="projectDetailDocName">{manuscript.file_name}</h2>
              <div className="projectDetailDocMeta">
                <span className="projectDetailDocDot">•</span>
                <span className="projectDetailDocTimestamp">
                  Updated: {new Date(manuscript.updated_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </div>
            </>
          )}
        </div>
        <div className="projectDetailTopBarRight">
          <button className="projectDetailLinkButton" onClick={handleOpenFile}>
            Open File
          </button>
          <button className="projectDetailLinkButton" onClick={handleOpenFolder}>
            Open Folder
          </button>
          <button className="projectDetailPrimaryButton" onClick={handleFullReview}>
            Full review XXX
          </button>
          <button className="projectDetailPrimaryButton" onClick={handleReviewChanges}>
            Review changes
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="projectDetailContent">
        {/* Left Panel - Manuscript Feedback List */}
        <div className="projectDetailFeedbackPanel">
          <div className="projectDetailFeedbackHeader">
            <h3 className="projectDetailFeedbackTitle">Manuscript feedback</h3>
            <button className="projectDetailPanelClose">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" fill="currentColor"/>
              </svg>
            </button>
          </div>
          <div className="projectDetailFeedbackList">
            {agentRun && (
              <div className="projectDetailFeedbackItem projectDetailFeedbackItemActive">
                <p className="projectDetailFeedbackItemTitle">
                  {agentRun.review_data?.suggestions?.[0]?.title || 'Full manuscript review'}
                </p>
                <p className="projectDetailFeedbackItemDate">
                  {new Date(agentRun.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                  })}
                </p>
              </div>
            )}
          </div>
        </div>

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

      {/* Save Confirmation Dialog */}
      {showSaveConfirm && (
        <ConfirmDialog
          title="Save Document"
          message="Reviewing requires saving the document."
          confirmLabel={isSaving ? 'Saving...' : 'Save and Continue'}
          cancelLabel="Cancel"
          onConfirm={handleSaveAndContinue}
          onCancel={() => { setShowSaveConfirm(false); setPendingReviewAction(null); }}
        />
      )}
    </div>
  );
};

export default ProjectDetail;
