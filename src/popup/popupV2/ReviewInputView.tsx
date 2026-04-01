import React, { useState, useEffect, useRef } from 'react';
import { serverUrl, tokenParam, postBridge, getV4FocusedWid, navigateToPage } from './shared';
import '../ReviewStatusOverlay.css';

export interface ReviewInputViewProps {
  selectedText: string | null;
  reviewType: string | null;
  isAwaitingReviewInput: boolean;
  effectiveWid: string | null;
  onBack: () => void;
  onClose: () => void;
}

export const ReviewInputView: React.FC<ReviewInputViewProps> = ({
  selectedText,
  reviewType,
  isAwaitingReviewInput,
  effectiveWid,
  onBack,
  onClose,
}) => {
  const [progress, setProgress] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showSelectedTextToggle, setShowSelectedTextToggle] = useState(false);
  const selectedTextRef = useRef<HTMLDivElement>(null);

  // Input mode state
  const [userPrompt, setUserPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Save/permission prompt state
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [showPermissionPrompt, setShowPermissionPrompt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const el = selectedTextRef.current;
    if (!el) return;
    setShowSelectedTextToggle(el.scrollHeight > el.clientHeight);
  }, [selectedText, isExpanded]);

  // Auto-focus textarea in input mode
  useEffect(() => {
    if (isAwaitingReviewInput && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isAwaitingReviewInput]);

  // Clear input state when no longer in input/reviewing mode
  useEffect(() => {
    if (!isAwaitingReviewInput && !reviewType) {
      setUserPrompt('');
      setIsSubmitting(false);
      setIsExpanded(false);
    }
  }, [isAwaitingReviewInput, reviewType]);

  // Simulate progress for reviewing mode
  useEffect(() => {
    if (reviewType) {
      setProgress(0);
      const interval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 90) {
            clearInterval(interval);
            return 90;
          }
          return prev + Math.random() * 10;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [reviewType]);

  const triggerReview = async () => {
    const sendWid = effectiveWid ?? getV4FocusedWid();
    if (!sendWid) return;
    setIsSubmitting(true);

    try {
      const res = await fetch(`${serverUrl}/api/selected-text-review/${sendWid}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenParam}`,
        },
        body: JSON.stringify({ userPrompt: userPrompt.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('[ReviewInputView] Review request failed:', data);
        postBridge('showReviewError', { message: data?.message || 'Something went wrong. Please try again.' }, sendWid).catch(() => {});
        setIsSubmitting(false);
        return;
      }
      console.log('[ReviewInputView] Review triggered successfully');
      // Transition to reviewing mode happens via poll data
    } catch (err) {
      console.error('[ReviewInputView] Review request error:', err);
      postBridge('showReviewError', { message: 'Could not connect to the review service. Please check your internet connection and try again.' }, sendWid).catch(() => {});
      setIsSubmitting(false);
    }
  };

  const handleSend = async () => {
    const sendWid = effectiveWid ?? getV4FocusedWid();
    if (!sendWid || isSubmitting) return;
    setIsSubmitting(true);

    // Pre-check: duplicate names and unsaved changes
    try {
      const preCheckRes = await fetch(`${serverUrl}/api/review-pre-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenParam}`,
        },
        body: '{}',
      });
      const preCheck = await preCheckRes.json();
      if (!preCheck.canProceed) {
        if (preCheck.reason === 'duplicate_name') {
          postBridge('showReviewError', { message: preCheck.message }, sendWid).catch(() => {});
          setIsSubmitting(false);
          return;
        }
        if (preCheck.reason === 'unsaved_changes') {
          setShowSavePrompt(true);
          setIsSubmitting(false);
          return;
        }
        if (preCheck.reason === 'permission_denied') {
          setShowPermissionPrompt(true);
          setIsSubmitting(false);
          return;
        }
      }
    } catch (err) {
      console.error('[ReviewInputView] Pre-check error:', err);
      // Fail-open: continue with review
    }

    await triggerReview();
  };

  const doSaveAndContinue = async (alwaysSave: boolean) => {
    setIsSaving(true);
    try {
      const url = alwaysSave ? `${serverUrl}/api/word-save?alwaysSave=true` : `${serverUrl}/api/word-save`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenParam}`,
        },
        body: '{}',
      });
      const data = await res.json();
      if (!data.success) {
        const sendWid = effectiveWid ?? getV4FocusedWid();
        postBridge('showReviewError', { message: data.error || 'Failed to save document.' }, sendWid).catch(() => {});
        setIsSaving(false);
        setShowSavePrompt(false);
        return;
      }
      setShowSavePrompt(false);
      setIsSaving(false);
      await triggerReview();
    } catch (err) {
      console.error('[ReviewInputView] Save error:', err);
      const sendWid = effectiveWid ?? getV4FocusedWid();
      postBridge('showReviewError', { message: 'Failed to save document.' }, sendWid).catch(() => {});
      setIsSaving(false);
      setShowSavePrompt(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isInputMode = isAwaitingReviewInput && !reviewType;

  const getHeaderText = () => {
    if (isInputMode) return 'Review selection';
    switch (reviewType) {
      case 'full-paper':
        return 'Reviewing paper';
      case 'review-changes':
        return 'Reviewing changes';
      case 'selected-text':
      default:
        return 'Reviewing selection';
    }
  };

  return (
    <div className="review-status-card" style={{ boxShadow: 'none', minWidth: 'unset', maxWidth: 'unset', animation: 'none' }}>
      <div className="review-status-header">
        <div className="review-status-header-left">
          <button
            className="review-status-back"
            onClick={onBack}
            aria-label="Back"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M12 4L6 10L12 16"
                stroke="#141413"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className="review-status-title">{getHeaderText()}</div>
        </div>
        <button
          className="review-status-close"
          onClick={onClose}
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M12 4L4 12M4 4L12 12"
              stroke="#141413"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="review-status-content">
        {selectedText ? (
          <>
            <div
              ref={selectedTextRef}
              style={isExpanded
                ? { maxHeight: '100px', overflowY: 'auto' }
                : { display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
              }
            >
              {selectedText}
            </div>
            {showSelectedTextToggle && (
              <button
                className="review-see-more"
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? 'See less' : 'See more'}
              </button>
            )}
          </>
        ) : (
          isInputMode ? 'Selected text' : 'Reviewing...'
        )}
      </div>

      {isInputMode && showPermissionPrompt ? (
        <div className="review-save-prompt">
          <div className="review-save-prompt-text">Unable to check for unsaved changes. Remember to save before reviewing.</div>
          <div className="review-save-prompt-buttons">
            <button
              className="review-save-button-secondary"
              onClick={() => setShowPermissionPrompt(false)}
            >
              Cancel
            </button>
            <button
              className="review-save-button-secondary"
              onClick={() => {
                navigateToPage({ page: 'external', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation' }, tokenParam);
              }}
            >
              Enable Permissions
            </button>
            <button
              className="review-save-button-primary"
              onClick={() => {
                setShowPermissionPrompt(false);
                triggerReview();
              }}
            >
              Continue Review
            </button>
          </div>
        </div>
      ) : isInputMode && showSavePrompt ? (
        <div className="review-save-prompt">
          <div className="review-save-prompt-text">Reviewing requires saving the document.</div>
          <div className="review-save-prompt-buttons">
            <button
              className="review-save-button-secondary"
              onClick={() => setShowSavePrompt(false)}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              className="review-save-button-secondary"
              onClick={() => doSaveAndContinue(false)}
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Save and Continue'}
            </button>
            <button
              className="review-save-button-primary"
              onClick={() => doSaveAndContinue(true)}
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Always Save and Continue'}
            </button>
          </div>
        </div>
      ) : isInputMode ? (
        <div className="review-input-section">
          <textarea
            ref={textareaRef}
            className="review-input-area"
            placeholder="Add instructions (optional)"
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
            rows={2}
          />
          <button
            className="review-send-button"
            onClick={handleSend}
            disabled={isSubmitting}
            aria-label="Send"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 9L15 9M15 9L10 4M15 9L10 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      ) : (
        <div className="review-status-progress">
          <div className="review-progress-bar">
            <div className="review-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="review-progress-footer">
            <span className="review-progress-text">{Math.round(progress)}%</span>
          </div>
        </div>
      )}
    </div>
  );
};
