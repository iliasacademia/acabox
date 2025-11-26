/**
 * Projects API Layer
 *
 * This file provides the API client for the Projects feature.
 * All API calls are made to the backend at /v0/co_scientist/projects endpoints.
 */

import { IPC_CHANNELS } from '../../shared/types';

// ============================================================================
// TYPE DEFINITIONS (Backend Data Models)
// ============================================================================

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

export interface ProjectFolder {
  id: number;
  project_id: number;
  folder_name: string;
  folder_path: string;
  file_count: number;
  created_at: string;
  synced: boolean;
}

export interface Collaborator {
  id: number;
  project_id: number;
  email: string;
  name?: string;
  role: 'owner' | 'editor' | 'viewer';
  invited_at: string;
  joined_at?: string;
  status: 'pending' | 'active' | 'declined';
}

export interface Review {
  id: number;
  project_id: number;
  manuscript_id: number;
  context: string;
  suggestion: string;
  type: 'grammar' | 'clarity' | 'reference' | 'methodology' | 'other';
  location: {
    start: number;
    end: number;
  };
  created_at: string;
  status: 'pending' | 'accepted' | 'rejected';
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

export interface ProjectStatusResponse {
  project_id: number;
  agent_runs: AgentRun[];
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  folder_ids?: number[];
  primary_manuscript_id?: number;
  collaborator_emails?: string[];
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Get all projects for current user
 * GET /v0/co_scientist/projects
 */
export async function getProjects(): Promise<Project[]> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint: 'v0/co_scientist/projects',
  });
  return response.projects || [];
}

/**
 * Get single project by ID
 * GET /v0/co_scientist/projects/:id
 */
export async function getProject(id: number): Promise<Project | null> {
  try {
    const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'GET',
      endpoint: `v0/co_scientist/projects/${id}`,
    });
    return response.project || null;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Create new project
 * POST /v0/co_scientist/projects
 */
export async function createProject(data: CreateProjectRequest): Promise<Project> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: 'v0/co_scientist/projects',
    data: data,
  });
  return response.project;
}

/**
 * Update project
 * PUT /v0/co_scientist/projects/:id
 */
export async function updateProject(id: number, data: Partial<CreateProjectRequest>): Promise<Project | null> {
  try {
    const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'PUT',
      endpoint: `v0/co_scientist/projects/${id}`,
      data: data,
    });
    return response.project || null;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Delete project
 * DELETE /v0/co_scientist/projects/:id
 */
export async function deleteProject(id: number): Promise<boolean> {
  try {
    await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'DELETE',
      endpoint: `v0/co_scientist/projects/${id}`,
    });
    return true;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Get files in project
 * GET /v0/co_scientist/projects/:id/files
 */
export async function getProjectFiles(projectId: number): Promise<ProjectFile[]> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint: `v0/co_scientist/projects/${projectId}/files`,
  });
  return response.files || [];
}

/**
 * Get folders in project
 * GET /v0/co_scientist/projects/:id/folders
 */
export async function getProjectFolders(projectId: number): Promise<ProjectFolder[]> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint: `v0/co_scientist/projects/${projectId}/folders`,
  });
  return response.folders || [];
}

/**
 * Add folder to project
 * POST /v0/co_scientist/projects/:id/folders
 */
export async function addFolderToProject(projectId: number, folderPath: string): Promise<ProjectFolder> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: `v0/co_scientist/projects/${projectId}/folders`,
    data: {
      folder: {
        folder_path: folderPath
      }
    },
  });
  return response.folder;
}

/**
 * Get collaborators in project
 * GET /v0/co_scientist/projects/:id/collaborators
 */
export async function getProjectCollaborators(projectId: number): Promise<Collaborator[]> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint: `v0/co_scientist/projects/${projectId}/collaborators`,
  });
  return response.collaborators || [];
}

/**
 * Add collaborator to project
 * POST /v0/co_scientist/projects/:id/collaborators
 */
export async function addCollaborator(projectId: number, email: string): Promise<Collaborator> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: `v0/co_scientist/projects/${projectId}/collaborators`,
    data: { email, role: 'editor' },
  });
  return response.collaborator;
}

/**
 * Get reviews/suggestions for project
 * GET /v0/co_scientist/projects/:id/reviews
 */
export async function getProjectReviews(projectId: number): Promise<Review[]> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint: `v0/co_scientist/projects/${projectId}/reviews`,
  });
  return response.reviews || [];
}

/**
 * Get project status with agent runs
 * GET /v0/co_scientist/projects/:id/status
 * @param projectId - Project ID
 * @param agentName - Optional: Filter by agent name (e.g., 'science_agent')
 * @param fileId - Optional: Filter by file ID
 */
export async function getProjectStatus(
  projectId: number,
  agentName?: string,
  fileId?: number
): Promise<ProjectStatusResponse> {
  let endpoint = `v0/co_scientist/projects/${projectId}/status`;

  const params = [];
  if (agentName) params.push(`agent_name=${agentName}`);
  if (fileId) params.push(`file_id=${fileId}`);

  if (params.length > 0) {
    endpoint += `?${params.join('&')}`;
  }

  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint,
  });
  return response;
}

/**
 * Update review status
 * PUT /v0/co_scientist/projects/:projectId/reviews/:reviewId
 */
export async function updateReviewStatus(
  projectId: number,
  reviewId: number,
  status: 'accepted' | 'rejected'
): Promise<Review | null> {
  try {
    const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'PUT',
      endpoint: `v0/co_scientist/projects/${projectId}/reviews/${reviewId}`,
      data: { status },
    });
    return response.review || null;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Get file diff (current version vs previous version)
 * GET /v0/co_scientist/projects/:projectId/files/:fileId/diff
 * Returns standard git diff format as a string
 */
export async function getFileDiff(
  projectId: number,
  fileId: number
): Promise<string> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}/diff`,
  });
  // Backend returns git diff as a string
  return response.diff || response;
}

/**
 * Trigger diff review for a file
 * POST /v0/co_scientist/projects/:projectId/files/:fileId/trigger_diff_review
 */
export async function triggerDiffReview(
  projectId: number,
  fileId: number
): Promise<{ agent_run_id: number }> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}/trigger_diff_review`,
  });
  return response;
}

/**
 * Trigger full review for a manuscript file
 * POST /v0/co_scientist/projects/:projectId/files/:fileId/trigger_full_review
 */
export async function triggerFullReview(
  projectId: number,
  fileId: number
): Promise<{ agent_run_id: number; status: string; current_version_id: string }> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: `v0/co_scientist/projects/${projectId}/files/${fileId}/trigger_full_review`,
  });
  return response;
}
