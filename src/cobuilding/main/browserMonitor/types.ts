export interface SnapshotPayload {
  url: string;
  title: string;
  referrer: string;
  meta_tags: Record<string, string>;
  full_text: string | null;
  text_hash: string;
  dwell_seconds: number;
  scroll: { depth: number };
  timestamp: string | number;
}

export interface ReadingSession {
  id?: number;
  url: string;
  title: string;
  referrer: string;
  meta_tags: Record<string, string>;
  full_text: string | null;
  text_hash: string;
  first_seen: string | number;
  last_snapshot: string | number;
  total_dwell: number;
  max_scroll_depth: number;
  snapshot_count: number;
  triage_state: 'pending' | 'triaged' | 'reacting' | 'reacted' | 'skipped';
  app_version: string;
  session_date: string;
}
