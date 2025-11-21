import React, { useState, useEffect } from 'react';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';
import { triggerDiffReview, getProjectStatus } from '../../services/projectsApi';
import DiffModal from './DiffModal';

/**
 * ManuscriptVersionCard Component
 *
 * Displays the primary manuscript file for a project in a styled card.
 * Shows the document icon, filename, last review info, and a button to review changes.
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
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<number | null>(null);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);

  // Debug: Log props when they change
  useEffect(() => {
    console.log('========================================');
    console.log('[ManuscriptVersionCard] Props updated:');
    console.log('  - fileName:', fileName);
    console.log('  - manuscriptId:', manuscriptId);
    console.log('  - fileUpdatedAt:', fileUpdatedAt);
    console.log('  - lastReview:', lastReview);
    console.log('  - projectId:', projectId);
    console.log('========================================');
  }, [fileName, manuscriptId, fileUpdatedAt, lastReview, projectId]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [pollInterval]);

  // Poll for review completion
  const startPolling = (runId: number) => {
    const interval = setInterval(async () => {
      try {
        const status = await getProjectStatus(projectId!, undefined, manuscriptId);

        // Find the agent run we're polling for
        const run = status.agent_runs.find(r => r.agent_run_id === runId);

        if (run) {
          if (run.status === 'completed') {
            clearInterval(interval);
            setPollInterval(null);
            setIsReviewing(false);
            setAgentRunId(null);
            console.log('Review completed successfully');

            // Refresh manuscript file data to get updated last_review timestamp
            if (onReviewComplete) {
              onReviewComplete();
            }
          } else if (run.status === 'failed') {
            clearInterval(interval);
            setPollInterval(null);
            setIsReviewing(false);
            setAgentRunId(null);
            setReviewError('Review failed');
          }
        }
      } catch (error) {
        console.error('Error polling review status:', error);
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
      console.log('Diff review started, agent_run_id:', response.agent_run_id);

      // Start polling for completion
      startPolling(response.agent_run_id);

    } catch (error: any) {
      console.error('Failed to trigger diff review:', error);

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
    console.log('========================================');
    console.log('[ManuscriptVersionCard] hasChangesSinceReview() called');
    console.log('[ManuscriptVersionCard] Input values:');
    console.log('  - lastReview:', lastReview);
    console.log('  - fileUpdatedAt:', fileUpdatedAt);

    if (!lastReview) {
      // No previous review - can't do diff review, hide button
      // (Full review will be triggered automatically on next upload)
      console.log('[ManuscriptVersionCard] ✗ Decision: HIDE button (no last review - need full review first)');
      console.log('========================================');
      return false;
    }

    if (!fileUpdatedAt) {
      // No file update timestamp, assume file might have changes
      console.log('[ManuscriptVersionCard] ⚠ Warning: No fileUpdatedAt');
      console.log('[ManuscriptVersionCard] ✓ Decision: SHOW button (to be safe)');
      console.log('========================================');
      return true;
    }

    const reviewDate = new Date(lastReview.reviewed_at);
    const fileUpdateDate = new Date(fileUpdatedAt);

    console.log('[ManuscriptVersionCard] Date comparison:');
    console.log('  - reviewDate (raw):', lastReview.reviewed_at);
    console.log('  - reviewDate (parsed):', reviewDate.toISOString());
    console.log('  - fileUpdateDate (raw):', fileUpdatedAt);
    console.log('  - fileUpdateDate (parsed):', fileUpdateDate.toISOString());
    console.log('  - reviewDate timestamp:', reviewDate.getTime());
    console.log('  - fileUpdateDate timestamp:', fileUpdateDate.getTime());
    console.log('  - Difference (ms):', fileUpdateDate.getTime() - reviewDate.getTime());

    const fileIsNewer = fileUpdateDate > reviewDate;
    console.log('  - File is newer than review:', fileIsNewer);

    if (fileIsNewer) {
      console.log('[ManuscriptVersionCard] ✓ Decision: SHOW button (file updated after review)');
    } else {
      console.log('[ManuscriptVersionCard] ✗ Decision: HIDE button (file is up to date)');
    }
    console.log('========================================');

    // Show Review Changes only if file was updated after the last review
    return fileIsNewer;
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
            <div className="manuscriptVersionLeft">
              <p className="manuscriptVersionTitle">Latest manuscript version</p>
              <div className="manuscriptVersionCard">
                <div className="manuscriptFileRow">
                  <div className="manuscriptFileIcon">
                    <img src={MSWordIcon} alt="Word document" />
                  </div>
                  <div className="manuscriptFileInfo">
                    <span className="manuscriptFileName">{fileName}</span>
                    {lastReview && (
                      <span className="manuscriptReviewMeta">
                        Reviewed: {formatReviewTimestamp()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {hasChangesSinceReview() && (
              <button
                className="reviewChangesButton"
                onClick={handleReviewChanges}
                disabled={!manuscriptId || isReviewing}
              >
                {isReviewing ? 'Reviewing...' : 'Review Changes'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Review Error */}
      {reviewError && (
        <div style={{ padding: '8px 24px', color: '#d32f2f', fontSize: '13px' }}>
          {reviewError}
        </div>
      )}
    </>
  );
};

export default ManuscriptVersionCard;
