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
import { FEEDBACK_FORM_URL } from '../../../shared/constants';
import { useProjectSyncStatus } from '../../hooks/useProjectSyncStatus';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';

interface ConversationsPageWrapperProps {
  selectedProject: Project | null;
  onBack?: () => void;
  initialConversationId?: number | null;
  onConversationNavigated?: () => void;
  initialOpenDiffModal?: boolean;
  onDiffModalOpened?: () => void;
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
  initialOpenDiffModal,
  onDiffModalOpened,
}: ConversationsPageWrapperProps) {
  // Track folder sync status for the current project
  const folderSyncStatus = useProjectSyncStatus(selectedProject?.id || null);

  return (
    <ApiProvider client={electronApiClient}>
      <ConversationsPage
        selectedProject={selectedProject}
        onBack={onBack}
        initialConversationId={initialConversationId}
        onConversationNavigated={onConversationNavigated}
        initialOpenDiffModal={initialOpenDiffModal}
        onDiffModalOpened={onDiffModalOpened}
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
        feedbackFormUrl={FEEDBACK_FORM_URL}
        // Event channel name for file sync
        fileSyncEventName={IPC_CHANNELS.PROJECT_FILE_SYNCED}
        // Folder sync status
        folderSyncStatus={folderSyncStatus}
      />
    </ApiProvider>
  );
}

export default ConversationsPageWrapper;
