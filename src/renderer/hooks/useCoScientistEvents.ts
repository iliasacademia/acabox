import { useEffect, useRef } from 'react';
import { IPC_CHANNELS } from '../../shared/types';
import { CoScientistEvent } from '../../types/events';

export type EventHandler = (event: CoScientistEvent) => void;

interface EventHandlers {
  onReviewStarted?: (event: CoScientistEvent) => void;
  onReviewCompleted?: (event: CoScientistEvent) => void;
  onReviewFailed?: (event: CoScientistEvent) => void;
  onMessageSent?: (event: CoScientistEvent) => void;
  onResponseReceived?: (event: CoScientistEvent) => void;
  onConversationAdded?: (event: CoScientistEvent) => void;
  onFileUploadStarted?: (event: CoScientistEvent) => void;
  onFileUploadCompleted?: (event: CoScientistEvent) => void;
  onFileUploadFailed?: (event: CoScientistEvent) => void;
  onZoteroFileSynced?: (event: CoScientistEvent) => void;
  onZoteroDisconnected?: (event: CoScientistEvent) => void;
  onClaimsExtractionStarted?: (event: CoScientistEvent) => void;
  onClaimsExtractionCompleted?: (event: CoScientistEvent) => void;
  onFactCheckingStarted?: (event: CoScientistEvent) => void;
  onClaimFactChecked?: (event: CoScientistEvent) => void;
  onFactCheckCompleted?: (event: CoScientistEvent) => void;
  onRefineReviewStarted?: (event: CoScientistEvent) => void;
  onRefineReviewCompleted?: (event: CoScientistEvent) => void;
  onAllEvents?: (event: CoScientistEvent) => void;
}

/**
 * Hook to listen for Co-Scientist events from the main process
 *
 * @param handlers - Object with event-specific callbacks
 *
 * @example
 * useCoScientistEvents({
 *   onReviewStarted: (event) => {
 *     // event.data includes:
 *     // - review_id: number - ID of the review
 *     // - file_id: number - ID of the file being reviewed
 *     // - review_type: 'full_auto' | 'full_manual' | 'diff_auto' | 'diff_manual'
 *   },
 *   onReviewCompleted: async (event) => {
 *     console.log('Review completed:', event.data);
 *     // event.data includes:
 *     // - conversation_id: number - Navigate to this conversation
 *     // - review_id: number - ID of the review
 *     // - file_id: number - ID of the reviewed file
 *     // - review_type: 'full_auto' | 'full_manual' | 'diff_auto' | 'diff_manual'
 *
 *     // Fetch latest review status
 *     await fetchReviewStatus(event.data.file_id);
 *
 *     // Navigate to conversation if available
 *     if (event.data.conversation_id) {
 *       window.electronAPI.invoke('navigate-to-page', {
 *         page: 'conversation',
 *         projectId: event.project_id,
 *         conversationId: event.data.conversation_id,
 *       });
 *     }
 *   },
 *   onReviewFailed: (event) => {
 *     console.error('Review failed:', event.data);
 *     // event.data includes:
 *     // - error: string - Error message
 *     // - file_id: number - ID of the file that failed
 *   },
 *   onMessageSent: (event) => {
 *     // event.data includes:
 *     // - conversation_id: number
 *     // - message_id: number
 *   },
 *   onResponseReceived: (event) => {
 *     // event.data includes:
 *     // - conversation_id: number
 *     // - message_id: number
 *     // - role: string (typically 'assistant')
 *     // - is_final: boolean - true if this is the final message in the response
 *   },
 *   onConversationAdded: (event) => {
 *     // event.data includes:
 *     // - conversation_id: number - ID of newly created conversation
 *   }
 * });
 */
export function useCoScientistEvents(handlers: EventHandlers): void {
  // Store handlers in a ref so the IPC listener always sees the latest callbacks
  // without needing to re-register on every render
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleEvent = (_event: any, coScientistEvent: CoScientistEvent) => {
      const h = handlersRef.current;

      console.log('[useCoScientistEvents] Received event:', {
        event_name: coScientistEvent.event_name,
        project_id: coScientistEvent.project_id,
        user_id: coScientistEvent.user_id,
        timestamp: coScientistEvent.timestamp,
        data: coScientistEvent.data,
      });

      // Call generic handler if provided
      if (h.onAllEvents) {
        h.onAllEvents(coScientistEvent);
      }

      // Call specific handlers based on event_name
      switch (coScientistEvent.event_name) {
        case 'review_started':
          h.onReviewStarted?.(coScientistEvent);
          break;

        case 'review_completed':
          h.onReviewCompleted?.(coScientistEvent);
          break;

        case 'review_failed':
          h.onReviewFailed?.(coScientistEvent);
          break;

        case 'message_sent':
          h.onMessageSent?.(coScientistEvent);
          break;

        case 'response_received':
          h.onResponseReceived?.(coScientistEvent);
          break;

        case 'conversation_added':
          h.onConversationAdded?.(coScientistEvent);
          break;

        case 'file_upload_started':
          h.onFileUploadStarted?.(coScientistEvent);
          break;

        case 'file_upload_completed':
          h.onFileUploadCompleted?.(coScientistEvent);
          break;

        case 'file_upload_failed':
          h.onFileUploadFailed?.(coScientistEvent);
          break;

        case 'zotero_file_synced':
          h.onZoteroFileSynced?.(coScientistEvent);
          break;

        case 'zotero_disconnected':
          h.onZoteroDisconnected?.(coScientistEvent);
          break;

        case 'claims_extraction_started':
          h.onClaimsExtractionStarted?.(coScientistEvent);
          break;

        case 'claims_extraction_completed':
          h.onClaimsExtractionCompleted?.(coScientistEvent);
          break;

        case 'fact_checking_started':
          h.onFactCheckingStarted?.(coScientistEvent);
          break;

        case 'claim_fact_checked':
          h.onClaimFactChecked?.(coScientistEvent);
          break;

        case 'fact_check_completed':
          h.onFactCheckCompleted?.(coScientistEvent);
          break;

        case 'refine_review_started':
          h.onRefineReviewStarted?.(coScientistEvent);
          break;

        case 'refine_review_completed':
          h.onRefineReviewCompleted?.(coScientistEvent);
          break;

        default:
          console.log('[useCoScientistEvents] Unknown event type:', coScientistEvent.event_name);
          break;
      }
    };

    // Register event listener once
    window.electronAPI.on(IPC_CHANNELS.CO_SCIENTIST_EVENT, handleEvent);
    console.log('[useCoScientistEvents] Registered event listener');

    // Cleanup on unmount
    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.CO_SCIENTIST_EVENT, handleEvent);
      console.log('[useCoScientistEvents] Unregistered event listener');
    };
  }, []);
}
