import React, { useState, useEffect, useMemo } from 'react';
import { ConversationDetail, ApiProvider, useProjectsApi } from '../../../packages/shared-conversations/src';
import type { Conversation } from '../../../packages/shared-conversations/src/types/conversation';
import type { ProjectFile } from '../../../packages/shared-conversations/src/types/project';
import '../../../packages/shared-conversations/src/styles/conversations.css';

// Inject popup-specific CSS overrides *after* the shared CSS import above,
// guaranteeing they appear later in the DOM and win by cascade order.
if (typeof document !== 'undefined' && !document.getElementById('popup-conversation-overrides')) {
  const style = document.createElement('style');
  style.id = 'popup-conversation-overrides';
  style.textContent = `
    .conversationDetail {
      position: relative;
      overflow: hidden;
      padding: 0;
      height: calc(100vh - 77px);
    }
    .conversationMessages {
      overflow-y: auto;
      padding-bottom: 16px;
    }
    .conversationInput {
      position: sticky;
      bottom: 0;
      background-color: #ffffff;
      padding-top: 8px;
      z-index: 1;
    }
  `;
  document.head.appendChild(style);
}

import { FEEDBACK_FORM_URL } from '../../shared/constants';
import { PopupApiClient } from './PopupApiClient';
import {
  NotificationData,
  styles,
  ArrowBackIcon,


  serverUrl,
  tokenParam,
} from './shared';

interface ConversationViewProps {
  activeNotification: NotificationData;
  projectId: number;
  onBack: () => void;
  onClose: () => void;
  setRecentReviewNotifications: React.Dispatch<React.SetStateAction<NotificationData[]>>;
}

function ConversationViewInner({
  activeNotification,
  projectId,
  onBack,
  onClose,
}: Omit<ConversationViewProps, 'setRecentReviewNotifications'>) {
  const [primaryManuscriptId, setPrimaryManuscriptId] = useState<number | undefined>(undefined);
  const [manuscriptFile, setManuscriptFile] = useState<ProjectFile | null>(null);
  const { getProjectFiles } = useProjectsApi();
  // Fetch primary manuscript on mount
  useEffect(() => {
    let cancelled = false;
    getProjectFiles(projectId).then((files) => {
      if (cancelled) return;
      const primary = files.find((f) => f.is_primary_manuscript);
      if (primary) {
        setPrimaryManuscriptId(primary.id);
        setManuscriptFile(primary);
      }
    }).catch((err) => {
      console.error('[ConversationView] Failed to fetch project files:', err);
    });
    return () => { cancelled = true; };
  }, [projectId, getProjectFiles]);

  // Construct a Conversation object from the notification data
  const conversation: Conversation = useMemo(() => ({
    id: activeNotification.conversation_id,
    agent_name: 'science_agent',
    title: activeNotification.conversation_title || activeNotification.title || 'Review',
    summary: null,
    created_at: new Date(activeNotification.created_at).toISOString(),
    updated_at: new Date(activeNotification.created_at).toISOString(),
    parent_id: activeNotification.project_id,
    parent_type: 'Project',
    selected_text: activeNotification.selected_text || null,
  }), [activeNotification]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header with Back and Close */}
      <div style={styles.reviewHeader}>
        <button
          style={styles.backButton}
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowBackIcon />
          <span style={styles.backButtonText}>Back</span>
        </button>
      </div>

      {/* Conversation Detail */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ConversationDetail
          conversation={conversation}
          projectId={projectId}
          primaryManuscriptId={primaryManuscriptId}
          manuscriptFile={manuscriptFile}
          feedbackFormUrl={FEEDBACK_FORM_URL}
        />
      </div>
    </div>
  );
}

export const ConversationView: React.FC<ConversationViewProps> = ({
  activeNotification,
  projectId,
  onBack,
  onClose,
  setRecentReviewNotifications: _setRecentReviewNotifications,
}) => {
  const popupApiClient = useMemo(
    () => new PopupApiClient(serverUrl, tokenParam),
    []
  );

  return (
    <ApiProvider client={popupApiClient}>
      <ConversationViewInner
        activeNotification={activeNotification}
        projectId={projectId}
        onBack={onBack}
        onClose={onClose}
      />
    </ApiProvider>
  );
};
