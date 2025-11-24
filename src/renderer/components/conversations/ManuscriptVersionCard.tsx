import React, { useState, useEffect } from 'react';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';
import { triggerDiffReview, triggerFullReview, getProjectStatus } from '../../services/projectsApi';
import DiffModal from './DiffModal';

/**
 * ManuscriptVersionCard Component
 *
 * Displays the primary manuscript file for a project in a styled card.
 * Shows the document icon, filename, last review info, and buttons to review changes or trigger full review.
 */

import { ProjectFile, LastReview } from '../../services/projectsApi';

interface ManuscriptVersionCardProps {
  fileName: string;
  isLoading?: boolean;
  projectId?: number;
  manuscriptId?: number;
  lastReview?: LastReview | null;
  fileUpdatedAt?: string;
  onReviewComplete?: () => void;
}

const ManuscriptVersionCard: React.FC<ManuscriptVersionCardProps> = ({
  fileName,
  isLoading = false,
  projectId,
  manuscriptId,
  lastReview,
  fileUpdatedAt,
  onReviewComplete,
}) => {
  const [isReviewing, setIsReviewing] = useState(false);
  const [isFullReviewing, setIsFullReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<number | null>(null);
  const [fullReviewAgentRunId, setFullReviewAgentRunId] = useState<number | null>(null);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [pollInterval]);

  // Poll for review completion
  const startPolling = (runId: number, isFullReview = false) => {
    const interval = setInterval(async () => {
      try {
        const status = await getProjectStatus(projectId!, undefined, manuscriptId);

        // Find the agent run we're polling for
        const run = status.agent_runs.find(r => r.agent_run_id === runId);

        if (run) {
          if (run.status === 'completed') {
            clearInterval(interval);
            setPollInterval(null);
            if (isFullReview) {
              setIsFullReviewing(false);
              setFullReviewAgentRunId(null);
            } else {
              setIsReviewing(false);
              setAgentRunId(null);
            }

            // Refresh manuscript file data to get updated last_review timestamp
            if (onReviewComplete) {
              onReviewComplete();
            }
          } else if (run.status === 'failed') {
            clearInterval(interval);
            setPollInterval(null);
            if (isFullReview) {
              setIsFullReviewing(false);
              setFullReviewAgentRunId(null);
            } else {
              setIsReviewing(false);
              setAgentRunId(null);
            }
            setReviewError('Review failed');
          }
        }
      } catch (error) {
        // Silent fail - polling will retry
      }
    }, 3000); // Poll every 3 seconds

    setPollInterval(interval);
  };

  const handleReviewChanges = async () => {
    if (!projectId || !manuscriptId) {
      setReviewError('No manuscript file found');
      return;
    }

    setIsReviewing(true);
    setReviewError(null);

    try {
      const response = await triggerDiffReview(projectId, manuscriptId);
      setAgentRunId(response.agent_run_id);

      // Start polling for completion
      startPolling(response.agent_run_id, false);

    } catch (error: any) {

      // Handle specific error cases
      if (error.status === 422) {
        const errorMsg = error.data?.error || error.message;

        if (errorMsg.includes('No previous review')) {
          setReviewError('This manuscript has not been reviewed yet. A full review will be triggered automatically on next upload.');
        } else if (errorMsg.includes('not available for manuscript files')) {
          setReviewError('Diff review is only available for manuscript files.');
        } else if (errorMsg.includes('no longer available')) {
          setReviewError('Previous version is no longer available. Please upload a new version to trigger a full review.');
        } else {
          setReviewError(errorMsg);
        }
      } else {
        setReviewError(error.message || 'Failed to trigger review');
      }

      setIsReviewing(false);
    }
  };

  const handleFullReview = async () => {
    if (!projectId || !manuscriptId) {
      setReviewError('No manuscript file found');
      return;
    }

    setIsFullReviewing(true);
    setReviewError(null);

    try {
      const response = await triggerFullReview(projectId, manuscriptId);
      setFullReviewAgentRunId(response.agent_run_id);

      // Start polling for completion
      startPolling(response.agent_run_id, true);

    } catch (error: any) {

      // Handle specific error cases
      if (error.status === 422) {
        const errorMsg = error.data?.error || error.message;

        if (errorMsg.includes('Full review only available for manuscript files')) {
          setReviewError('Full review is only available for manuscript files.');
        } else if (errorMsg.includes('S3 versioning not enabled')) {
          setReviewError('S3 versioning is not enabled for this file.');
        } else {
          setReviewError(errorMsg);
        }
      } else if (error.status === 403) {
        setReviewError('You must be the project owner to trigger a full review.');
      } else if (error.status === 500) {
        const errorMsg = error.data?.error || error.message;
        if (errorMsg.includes('S3 service error')) {
          setReviewError('S3 service error occurred. Please try again later.');
        } else {
          setReviewError('Failed to trigger full review. Please try again.');
        }
      } else {
        setReviewError(error.message || 'Failed to trigger full review');
      }

      setIsFullReviewing(false);
    }
  };

  // Format last review timestamp
  const formatReviewTimestamp = () => {
    if (!lastReview) {
      return null;
    }

    const reviewDate = new Date(lastReview.reviewed_at);
    return reviewDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Check if file has changes since last review
  const hasChangesSinceReview = () => {
    if (!lastReview) {
      // No previous review - can't do diff review, hide button
      // (Full review will be triggered automatically on next upload)
      return false;
    }

    if (!fileUpdatedAt) {
      // No file update timestamp, assume file might have changes
      return true;
    }

    const reviewDate = new Date(lastReview.reviewed_at);
    const fileUpdateDate = new Date(fileUpdatedAt);

    // Show Review Changes only if file was updated after the last review
    return fileUpdateDate > reviewDate;
  };

  if (isLoading) {
    return (
      <div className="manuscriptVersionContainer">
        <div className="manuscriptVersionContent">
          <div className="manuscriptVersionHeader">
            <p className="manuscriptVersionTitle">Latest manuscript version</p>
          </div>
          <div className="manuscriptVersionCard">
            <div className="manuscriptFileRow">
              <span className="manuscriptFileLoading">Loading...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="manuscriptVersionContainer">
        <div className="manuscriptVersionContent">
          <div className="manuscriptVersionHeader">
            <div className="manuscriptHeaderLeft">
              <span className="manuscriptLabel">Manuscript:</span>
              <div className="manuscriptFileIcon">
                <img src={MSWordIcon} alt="Word document" />
              </div>
              <span className="manuscriptFileName">{fileName}</span>
            </div>
            <div className="manuscriptActionButtons">
              {hasChangesSinceReview() && (
                <button
                  className="reviewChangesButton"
                  onClick={handleReviewChanges}
                  disabled={!manuscriptId || isReviewing || isFullReviewing}
                >
                  {isReviewing ? 'Reviewing...' : 'Review Changes'}
                </button>
              )}
              <button
                className="fullReviewButton"
                onClick={handleFullReview}
                disabled={!manuscriptId || isFullReviewing || isReviewing}
              >
                {isFullReviewing ? 'Reviewing...' : 'Trigger Full Review'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Review Error */}
      {reviewError && (
        <div style={{ padding: '8px 24px', color: '#d32f2f', fontSize: '13px' }}>
          {/* Sanitized error message - rendered as text only, truncated to prevent injection */}
          {String(reviewError).substring(0, 200)}
        </div>
      )}
    </>
  );
};

export default ManuscriptVersionCard;
