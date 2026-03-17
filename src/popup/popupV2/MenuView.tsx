import React, { useState } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import {
  NotificationData,
  ReviewState,
  styles,
  ArrowForwardIcon,
  CloseIcon,
  LoadingSpinner,
  postBridge,
  formatNotificationDate,
} from './shared';

// ─── Menu View ──────────────────────────────────────────────────────

interface MenuViewProps {
  recentReviewNotifications: NotificationData[];
  isLoading: boolean;
  projectId: number | null;
  fileId: number | null;
  reviewState: ReviewState;
  reviewErrorMessage?: string | null;
  onClose: () => void;
  onViewReviewFeedback: (notification: NotificationData) => void;
  onViewPreviousFeedback: () => void;
  onGenerateShortReview: () => void;
  onGenerateFullReview: () => void;
}

export const MenuView: React.FC<MenuViewProps> = ({
  recentReviewNotifications,
  isLoading,
  projectId,
  fileId,
  reviewState,
  reviewErrorMessage,
  onClose,
  onViewReviewFeedback,
  onViewPreviousFeedback,
  onGenerateShortReview,
  onGenerateFullReview,
}) => {
  const isReviewing = reviewState === 'reviewing';
  const showFailedMessage = reviewState === 'failed';
  const buttonsDisabled = isLoading || !projectId || !fileId || isReviewing;

  return (
    <>
      {/* Close Button */}
      <button
        style={styles.closeButton}
        onClick={onClose}
        aria-label="Close"
        title="Close"
      >
        <CloseIcon />
      </button>

      {/* Section 1: Feedback (always visible) */}
      <div>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionHeaderText}>Feedback</span>
        </div>
        <div style={styles.feedbackContent}>
          {/* Notification cards (up to 2 most recent) */}
          {recentReviewNotifications.map((notification) => {
            const isSelectionReview = notification.review_type === 'selected-text';

            return (
              <button
                key={notification.id}
                style={styles.notificationCard}
                onClick={() => onViewReviewFeedback(notification)}
                aria-label="View review feedback"
              >
                {!notification.isRead && <div style={styles.blueDot} />}
                <div style={styles.notificationContent as React.CSSProperties}>
                  <span style={styles.notificationDate}>
                    {formatNotificationDate(notification.created_at)}
                  </span>
                  <span style={styles.notificationTitle}>
                    {notification.isInProgress && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                        <LoadingSpinner />
                        <span>Selection review</span>
                      </span>
                    )}
                    {!notification.isInProgress && isSelectionReview && 'Selection review'}
                    {!notification.isInProgress && !isSelectionReview && (
                      <span
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(notification.body_html || notification.conversation_title || notification.title || 'Feedback on your manuscript')
                        }}
                      />
                    )}
                  </span>
                </div>
                <div style={styles.arrowIcon}>
                  <ArrowForwardIcon />
                </div>
              </button>
            );
          })}
          {/* View previous feedback row (always visible) */}
          <button
            style={styles.viewPreviousRow}
            onClick={onViewPreviousFeedback}
            aria-label="View previous feedback"
          >
            <span style={styles.viewPreviousText}>View previous feedback</span>
            <div style={styles.arrowIcon}>
              <ArrowForwardIcon />
            </div>
          </button>
        </div>
      </div>

      {/* Section 2: Get Feedback Actions */}
      <div>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionHeaderText}>Get feedback</span>
        </div>
        <div style={styles.feedbackButtonsRow}>
          <button
            style={{
              ...styles.feedbackButton,
              ...(buttonsDisabled ? styles.feedbackButtonDisabled : {}),
            }}
            onClick={onGenerateShortReview}
            disabled={buttonsDisabled}
            aria-label="Generate review on recent changes"
          >
            <span style={styles.feedbackButtonText}>
              {isReviewing ? 'Reviewing...' : 'On recent changes'}
            </span>
            <div style={styles.arrowIcon}>
              <ArrowForwardIcon />
            </div>
          </button>
          <button
            style={{
              ...styles.feedbackButton,
              ...(buttonsDisabled ? styles.feedbackButtonDisabled : {}),
            }}
            onClick={onGenerateFullReview}
            disabled={buttonsDisabled}
            aria-label="Generate review on full manuscript"
          >
            <span style={styles.feedbackButtonText}>
              {isReviewing ? 'Reviewing...' : 'On the full manuscript'}
            </span>
            <div style={styles.arrowIcon}>
              <ArrowForwardIcon />
            </div>
          </button>
        </div>
      </div>

      {/* Review error message from review button */}
      {reviewErrorMessage && (
        <div style={styles.errorMessage}>
          {reviewErrorMessage}
        </div>
      )}

      {/* Error Message (if any) */}
      {showFailedMessage && (
        <div style={styles.errorMessage}>
          Review failed. Please try again.
        </div>
      )}
    </>
  );
};

// ─── Enable Feedback View ───────────────────────────────────────────

interface EnableFeedbackViewProps {
  isUnsavedDocument: boolean;
}

export const EnableFeedbackView: React.FC<EnableFeedbackViewProps> = ({
  isUnsavedDocument,
}) => {
  const [isEnableFeedbackLoading, setIsEnableFeedbackLoading] = useState(false);
  const [enableFeedbackError, setEnableFeedbackError] = useState<string | null>(null);

  const handleShareToEnableFeedback = async () => {
    setIsEnableFeedbackLoading(true);
    setEnableFeedbackError(null);
    try {
      console.log('[AcademiaNotificationsPopupV2] Share to enable feedback clicked');
      const response = await postBridge('shareToEnableFeedback');
      const data = await response.json();
      if (!data.success) {
        setEnableFeedbackError(data.error || 'Failed to enable feedback');
        setIsEnableFeedbackLoading(false);
      }
      // On success, the popup will be closed by the service
    } catch (err) {
      setEnableFeedbackError('Something went wrong. Please try again.');
      setIsEnableFeedbackLoading(false);
    }
  };

  return (
    <>
      <button
        style={styles.closeButton}
        onClick={() => postBridge('closeWindow').catch(() => {})}
        aria-label="Close popup"
      >
        <CloseIcon />
      </button>
      {isUnsavedDocument ? (
        <>
          <div style={styles.enableFeedbackTitle}>
            Save your document first
          </div>
          <div style={styles.enableFeedbackDescription}>
            Please save your document before enabling feedback. Once saved, you can share it with Writing Agent.
          </div>
        </>
      ) : (
        <>
          <div style={styles.enableFeedbackTitle}>
            {isEnableFeedbackLoading ? 'Setting up...' : 'Share this document for feedback?'}
          </div>
          <div style={styles.enableFeedbackDescription}>
            {isEnableFeedbackLoading
              ? 'Creating project and uploading your document. This may take a moment.'
              : "This document hasn't been shared with Writing Agent yet. Share it to start getting feedback."}
          </div>
          {enableFeedbackError && (
            <div style={styles.enableFeedbackError}>{enableFeedbackError}</div>
          )}
          <button
            style={{
              ...styles.enableFeedbackShareButton,
              ...(isEnableFeedbackLoading ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
            }}
            onClick={handleShareToEnableFeedback}
            disabled={isEnableFeedbackLoading}
          >
            <span style={styles.enableFeedbackShareButtonText}>
              {isEnableFeedbackLoading ? 'Setting up...' : 'Share to enable feedback'}
            </span>
          </button>
        </>
      )}
    </>
  );
};
