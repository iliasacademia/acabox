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
   *
   * For 'claims_extraction_started' events (when claim extraction begins):
   * - review_id: number - ID of the review being fact-checked
   *
   * For 'claims_extraction_completed' events (after claims are extracted):
   * - review_id: number - ID of the review
   * - claims_count: number - Number of claims extracted
   *
   * For 'fact_checking_started' events (when per-claim fact-check jobs are enqueued):
   * - review_id: number - ID of the review
   * - claims_count: number - Total number of claims to check
   * - claims: string[] - The claim texts
   *
   * For 'claim_fact_checked' events (fired each time a single claim finishes):
   * - review_id: number - ID of the review
   * - claim_key: string - Unique key for this claim
   * - claim: string - The claim text
   * - verification_status: string - e.g. 'verified', 'partially_verified', 'unverified'
   * - issues_found: string - Description of issues found (empty string if none)
   * - claims_checked: number - How many claims have been checked so far
   * - total_claims: number - Total claims to check (use for progress indicator)
   *
   * For 'fact_check_completed' events (when the full fact-check job finishes):
   * - review_id: number - ID of the review that was fact-checked
   * - status: 'verified' | 'refined' | 'no_claims' - Outcome of the fact check
   * - issues_found: number - Number of issues found (0 when status is 'verified' or 'no_claims')
   *
   * For 'refine_review_started' events (when review refinement begins):
   * - review_id: number - ID of the review being refined
   * - issues_count: number - Number of issues that triggered the refinement
   *
   * For 'refine_review_completed' events (when review refinement finishes):
   * - review_id: number - ID of the refined review
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
