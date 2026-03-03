/**
 * Event from the Co-Scientist events polling API
 */
export interface CoScientistEvent {
  project_id: number | null;
  user_id: number;
  event_name: string;
  /**
   * Event-specific data payload
   *
   * For 'review_started' events:
   * - review_id: number - ID of the review
   * - file_id: number - ID of the file being reviewed
   * - review_type: 'full_auto' | 'full_manual' | 'diff_auto' | 'diff_manual' - Type of review
   *
   * For 'review_completed' events:
   * - conversation_id: number - ID of the conversation created with the review
   * - review_id: number - ID of the review
   * - status: string - Status of the review
   * - file_id: number - ID of the file that was reviewed
   * - review_type: 'full_auto' | 'full_manual' | 'diff_auto' | 'diff_manual' - Type of review
   *
   * For 'review_failed' events:
   * - error: string - Error message
   * - file_id: number - ID of the file that failed
   *
   * For 'message_sent' events (when user sends a message):
   * - conversation_id: number - ID of the conversation
   * - message_id: number - ID of the sent message
   *
   * For 'response_received' events (when AI response is received):
   * - conversation_id: number - ID of the conversation
   * - message_id: number - ID of the received message
   * - role: string - Message role (typically 'assistant')
   * - is_final: boolean - Whether this is the final message in the AI response
   *
   * For 'conversation_added' events (when new conversation is created):
   * - conversation_id: number - ID of the newly created conversation
   *
   * For 'file_upload_started' events (when file upload job starts):
   * - file_id: number - ID of the file being uploaded
   * - file_name: string - Name of the file
   *
   * For 'file_upload_completed' events (when file upload completes):
   * - file_id: number - ID of the uploaded file
   * - file_name: string - Name of the file
   *
   * For 'file_upload_failed' events (when file upload fails):
   * - file_id: number - ID of the file that failed
   * - file_name: string - Name of the file
   * - error: string - Error message describing the failure
   *
   * For 'zotero_file_synced' events (when a file is synced from Zotero):
   * - file_id: number - ID of the synced file
   * - file_name: string - Name of the file
   * - url: string - Zotero URL of the file
   *
   * For 'zotero_disconnected' events (when Zotero account is disconnected):
   * (no additional data)
   */
  data: Record<string, any>;
  timestamp: string; // ISO 8601 format
}

/**
 * Response from GET /v0/co_scientist/events/poll
 */
export interface PollEventsResponse {
  events: CoScientistEvent[];
  server_timestamp: string; // ISO 8601 format - server's current time
}
