import React, { useMemo } from 'react';
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
import type { UseConversationPollingOptions, MessageCreatedEvent } from '../../../../packages/shared-conversations/src/hooks/useConversationPolling';
import MSWordIcon from '../../../assets/images/MSWordIcon.png';

interface ConversationsPageWrapperProps {
  selectedProject: Project | null;
  onBack?: () => void;
  initialConversationId?: number | null;
  onConversationNavigated?: () => void;
  initialOpenDiffModal?: boolean;
  onDiffModalOpened?: () => void;
  initialView?: 'conversation' | 'supporting-materials';
  nonProjectConversations?: boolean;
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
  initialView,
  nonProjectConversations,
}: ConversationsPageWrapperProps) {
  // Track folder sync status for the current project
  const folderSyncStatus = useProjectSyncStatus(selectedProject?.id || null);

  // Create polling options that use events instead of constant polling
  const pollingOptions = useMemo<UseConversationPollingOptions>(() => ({
    onEventReceived: (handler) => {
      // Create a wrapper that transforms Co-Scientist events to the format expected by the hook
      const eventHandler = (_event: any, coScientistEvent: any) => {
        const { event_name, data } = coScientistEvent;
        if (
          (event_name === 'response_received' || event_name === 'message_sent') &&
          data?.conversation_id
        ) {
          const messageEvent: MessageCreatedEvent = {
            conversation_id: data.conversation_id,
            message_id: data.message_id || 0,
            role: data.role || 'assistant',
            is_final: data.is_final,
          };
          handler(messageEvent);
        }
      };

      // Register IPC listener
      window.electronAPI.on(IPC_CHANNELS.CO_SCIENTIST_EVENT, eventHandler);

      // Return cleanup function
      return () => {
        window.electronAPI.removeListener(IPC_CHANNELS.CO_SCIENTIST_EVENT, eventHandler);
      };
    },
  }), []);

  // Create review state updates callback that listens for review lifecycle events
  const onRegisterReviewStateUpdates = useMemo(() => {
    return (updateFn: (state: 'idle' | 'full-reviewing' | 'diff-reviewing') => void) => {
      console.log('[ConversationsPageWrapper] Registering review state updates');

      // Listen for review_started, review_completed, and review_failed events
      const eventHandler = (_event: any, coScientistEvent: any) => {
        const { event_name, data } = coScientistEvent;

        if (event_name === 'review_started') {
          console.log('[ConversationsPageWrapper] Review started, disabling buttons', data);

          // Determine review type from data.review_type
          const reviewType = data?.review_type;
          if (reviewType?.includes('full')) {
            updateFn('full-reviewing');
          } else if (reviewType?.includes('diff')) {
            updateFn('diff-reviewing');
          } else {
            // Default to full-reviewing if type is unknown
            updateFn('full-reviewing');
          }
        } else if (event_name === 'review_completed' || event_name === 'review_failed') {
          console.log('[ConversationsPageWrapper] Review finished, enabling buttons', event_name);
          updateFn('idle');
        }
      };

      // Register IPC listener
      window.electronAPI.on(IPC_CHANNELS.CO_SCIENTIST_EVENT, eventHandler);

      // Return cleanup function
      return () => {
        console.log('[ConversationsPageWrapper] Unregistering review state updates');
        window.electronAPI.removeListener(IPC_CHANNELS.CO_SCIENTIST_EVENT, eventHandler);
      };
    };
  }, []);

  return (
    <ApiProvider client={electronApiClient}>
      <ConversationsPage
        selectedProject={selectedProject}
        nonProjectConversations={nonProjectConversations}
        onBack={onBack}
        initialConversationId={initialConversationId}
        onConversationNavigated={onConversationNavigated}
        pollingOptions={pollingOptions}
        onRegisterConversationsRefresh={undefined}
        onRegisterReviewStateUpdates={onRegisterReviewStateUpdates}
        initialOpenDiffModal={initialOpenDiffModal}
        onDiffModalOpened={onDiffModalOpened}
        initialView={initialView}
        // Analytics callbacks
        onProjectView={trackProjectView}
        onTriggerFullReview={(projectId, fileId) => trackTriggerFullReview('desktop', projectId, fileId)}
        onTriggerDiffReview={(projectId, fileId) => trackTriggerDiffReview('desktop', projectId, fileId)}
        shouldPrecheck={true}
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
