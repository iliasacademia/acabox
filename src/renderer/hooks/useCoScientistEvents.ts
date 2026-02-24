import { useEffect, useCallback } from 'react';
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
  onAllEvents?: (event: CoScientistEvent) => void;
}

/**
 * Hook to listen for Co-Scientist events from the main process
 *
 * @param handlers - Object with event-specific callbacks
 * @param dependencies - Dependencies array for handlers (optional)
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
export function useCoScientistEvents(
  handlers: EventHandlers,
  dependencies: React.DependencyList = []
): void {
  // Memoize the event handler
  const handleEvent = useCallback((event: any, coScientistEvent: CoScientistEvent) => {
    console.log('[useCoScientistEvents] Received event:', {
      event_name: coScientistEvent.event_name,
      project_id: coScientistEvent.project_id,
      user_id: coScientistEvent.user_id,
      timestamp: coScientistEvent.timestamp,
      data: coScientistEvent.data,
    });

    // Call generic handler if provided
    if (handlers.onAllEvents) {
      handlers.onAllEvents(coScientistEvent);
    }

    // Call specific handlers based on event_name
    switch (coScientistEvent.event_name) {
      case 'review_started':
        if (handlers.onReviewStarted) {
          handlers.onReviewStarted(coScientistEvent);
        }
        break;

      case 'review_completed':
        if (handlers.onReviewCompleted) {
          handlers.onReviewCompleted(coScientistEvent);
        }
        break;

      case 'review_failed':
        if (handlers.onReviewFailed) {
          handlers.onReviewFailed(coScientistEvent);
        }
        break;

      case 'message_sent':
        if (handlers.onMessageSent) {
          handlers.onMessageSent(coScientistEvent);
        }
        break;

      case 'response_received':
        if (handlers.onResponseReceived) {
          handlers.onResponseReceived(coScientistEvent);
        }
        break;

      case 'conversation_added':
        if (handlers.onConversationAdded) {
          handlers.onConversationAdded(coScientistEvent);
        }
        break;

      case 'file_upload_started':
        if (handlers.onFileUploadStarted) {
          handlers.onFileUploadStarted(coScientistEvent);
        }
        break;

      case 'file_upload_completed':
        if (handlers.onFileUploadCompleted) {
          handlers.onFileUploadCompleted(coScientistEvent);
        }
        break;

      case 'file_upload_failed':
        if (handlers.onFileUploadFailed) {
          handlers.onFileUploadFailed(coScientistEvent);
        }
        break;

      default:
        console.log('[useCoScientistEvents] Unknown event type:', coScientistEvent.event_name);
        break;
    }
  }, [handlers.onReviewStarted, handlers.onReviewCompleted, handlers.onReviewFailed, handlers.onMessageSent, handlers.onResponseReceived, handlers.onConversationAdded, handlers.onFileUploadStarted, handlers.onFileUploadCompleted, handlers.onFileUploadFailed, handlers.onAllEvents, ...dependencies]);

  useEffect(() => {
    // Register event listener
    window.electronAPI.on(IPC_CHANNELS.CO_SCIENTIST_EVENT, handleEvent);

    console.log('[useCoScientistEvents] Registered event listener');

    // Cleanup on unmount
    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.CO_SCIENTIST_EVENT, handleEvent);
      console.log('[useCoScientistEvents] Unregistered event listener');
    };
  }, [handleEvent]);
}
