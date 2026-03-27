import React, { useState } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import {
  ConversationItem,
  NotificationData,
  ReviewState,
  styles,
  ArrowForwardIcon,
  LoadingSpinner,
  postBridge,
  formatNotificationDate,
  formatConversationDate,
} from './shared';

// ─── Menu View ──────────────────────────────────────────────────────

interface MenuViewProps {
  recentReviewNotifications: NotificationData[];
  conversations: ConversationItem[];
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
  conversations,
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

  // Map conversation_id -> notification for badge/behavior lookup
  const notificationByConvId = new Map(recentReviewNotifications.map(n => [n.conversation_id, n]));

  // In-progress reviews whose conversation isn't in the list yet (show at top)
  const convIds = new Set(conversations.map(c => c.id));
  const inProgressExtras = recentReviewNotifications.filter(n => n.isInProgress && !convIds.has(n.conversation_id));

  return (
    <>
      {/* Section 1: Feedback and Conversations */}
      <div>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionHeaderText}>Feedback and Conversations</span>
        </div>
        <div style={styles.feedbackContent}>
          {/* In-progress reviews not yet in the conversations list */}
          {inProgressExtras.map((notification) => (
            <button
              key={`notif-${notification.id}`}
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                    <LoadingSpinner />
                    <span>Selection review</span>
                  </span>
                </span>
              </div>
              <div style={styles.arrowIcon}>
                <ArrowForwardIcon />
              </div>
            </button>
          ))}

          {/* Conversations from list_conversations (up to 5), with badge if a review notification matches */}
          {conversations.slice(0, 5).map((conversation) => {
            const notification = notificationByConvId.get(conversation.id);
            const isSelectionReview = notification?.review_type === 'selected-text';

            return (
              <button
                key={conversation.id}
                style={styles.notificationCard}
                onClick={() => onViewReviewFeedback(notification ?? {
                  id: 0,
                  project_id: projectId!,
                  conversation_id: conversation.id,
                  created_at: new Date(conversation.created_at).getTime(),
                  title: conversation.title || conversation.summary || 'Conversation',
                  conversation_title: conversation.title || conversation.summary || undefined,
                  isRead: true,
                })}
                aria-label={notification ? 'View review feedback' : 'View conversation'}
              >
                {notification && !notification.isRead && <div style={styles.blueDot} />}
                <div style={styles.notificationContent as React.CSSProperties}>
                  <span style={styles.notificationDate}>
                    {notification
                      ? formatNotificationDate(notification.created_at)
                      : formatConversationDate(conversation.created_at)
                    }
                  </span>
                  <span style={styles.notificationTitle}>
                    {notification?.isInProgress && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                        <LoadingSpinner />
                        <span>Selection review</span>
                      </span>
                    )}
                    {notification && !notification.isInProgress && isSelectionReview && 'Selection review'}
                    {notification && !notification.isInProgress && !isSelectionReview && (
                      <span
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(notification.body_html || notification.conversation_title || notification.title || 'Feedback on your manuscript')
                        }}
                      />
                    )}
                    {!notification && (conversation.title || conversation.summary || 'Conversation')}
                  </span>
                </div>
                <div style={styles.arrowIcon}>
                  <ArrowForwardIcon />
                </div>
              </button>
            );
          })}

          {/* View all row */}
          <button
            style={styles.viewPreviousRow}
            onClick={onViewPreviousFeedback}
            aria-label="View all feedback and conversations"
          >
            <span style={styles.viewPreviousText}>View all feedback and conversations</span>
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
