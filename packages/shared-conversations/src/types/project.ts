/**
 * Project Types
 *
 * Subset of project type definitions needed for the conversations feature.
 * Extracted from src/renderer/services/projectsApi.ts
 */

export interface Project {
  id: number;
  name: string;
  description: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  file_count: number;
  folder_count: number;
  collaborator_count: number;
  primary_manuscript_id?: number;
}

export interface LastReview {
  reviewed_version_id: string;
  reviewed_at: string;
  review_type: 'diff_review' | 'full_review';
}

export interface ProjectFile {
  id: number;
  project_id: number;
  file_name: string;
  file_type: 'manuscript' | 'data' | 'image' | 'other';
  file_path: string;
  size: number;
  created_at: string;
  updated_at: string;
  is_primary_manuscript: boolean;
  last_review: LastReview | null;
}

export interface ReviewSuggestion {
  title: string;
  critique: string; // HTML content
  review_item_type: string; // e.g., "strength", "weakness"
  review_item_id: number;
  review_item_created_at: string;
  priority?: boolean;
  major?: boolean; // Major vs minor critique classification
  llm_model?: string;
  framework_to_address?: string; // HTML content
  batch?: number;
}

export interface ReviewData {
  suggestions: ReviewSuggestion[];
  summary: string;
  triggered_by?: string; // 'auto_scheduler' for auto reviews, other values for manual
}

export interface AgentRun {
  agent_run_id: number;
  agent_name: string;
  file_id: number;
  file_name: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  running_jobs_count: number;
  created_at: string;
  review_data: ReviewData | null;
}

export interface DiffResponse {
  diff: string; // Plain text diff with line prefixes (space, -, +, ~)
  modified_date: string; // ISO 8601 format
  manuscript_name: string;
  title: string;
}

export interface ProjectStatusResponse {
  project_id: number;
  agent_runs: AgentRun[];
}
