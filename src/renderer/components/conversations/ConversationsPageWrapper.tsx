import React from 'react';
import { ConversationsPage, ApiProvider, Project } from '../../../../packages/shared-conversations/src';
import '../../../../packages/shared-conversations/src/styles/conversations.css';
import { electronApiClient } from '../../adapters/ElectronApiClient';
import {
  trackProjectView,
  trackTriggerFullReview,
  trackTriggerDiffReview,
  trackConversationView,
  trackConversationMessageSent,
  trackConversationMessageReceived,
} from '../../utils/analytics';
import { IPC_CHANNELS } from '../../../shared/types';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';

interface ConversationsPageWrapperProps {
  selectedProject: Project | null;
  onBack?: () => void;
  initialConversationId?: number | null;
  onConversationNavigated?: () => void;
}

/**
 * Wrapper component that provides the Electron-specific implementations
 * to the shared ConversationsPage component.
 */
export function ConversationsPageWrapper({
  selectedProject,
  onBack,
  initialConversationId,
  onConversationNavigated,
}: ConversationsPageWrapperProps) {
  // Feedback form URL from environment or default
  const feedbackFormUrl = 'https://docs.google.com/forms/d/e/1FAIpQLSdGK6wGdPRhW6LzF_aBYoU0WJGK2-Sq5lCPgLy3n3Bk0qT1ig/viewform';

  return (
    <ApiProvider client={electronApiClient}>
      <ConversationsPage
        selectedProject={selectedProject}
        onBack={onBack}
        initialConversationId={initialConversationId}
        onConversationNavigated={onConversationNavigated}
        // Analytics callbacks
        onProjectView={trackProjectView}
        onTriggerFullReview={(projectId, fileId) => trackTriggerFullReview('desktop', projectId, fileId)}
        onTriggerDiffReview={(projectId, fileId) => trackTriggerDiffReview('desktop', projectId, fileId)}
        onConversationView={trackConversationView}
        onMessageSent={trackConversationMessageSent}
        onMessageReceived={trackConversationMessageReceived}
        // UI customization
        renderManuscriptIcon={() => (
          <img src={MSWordIcon} alt="Word Document" className="manuscriptIcon" />
        )}
        feedbackFormUrl={feedbackFormUrl}
        // Event channel name for file sync
        fileSyncEventName={IPC_CHANNELS.PROJECT_FILE_SYNCED}
      />
    </ApiProvider>
  );
}

export default ConversationsPageWrapper;
