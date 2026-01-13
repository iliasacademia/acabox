/**
 * Event from the Co-Scientist events polling API
 */
export interface CoScientistEvent {
  project_id: number;
  user_id: number;
  event_name: string;
  data: Record<string, any>;
  timestamp: string; // ISO 8601 format
}

/**
 * Response from GET /v0/co_scientist/events/poll
 */
export interface PollEventsResponse {
  events: CoScientistEvent[];
}
