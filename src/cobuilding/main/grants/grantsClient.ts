import { callBackendApi } from '../../../apiCall';

const BASE = 'v0/grants_ai';

export interface OnboardingResponse {
  question: string;
  response: string;
}

export interface GrantProject {
  id: number;
  name: string;
  research_summary: string;
  seed_draft_id: number | null;
  user_id: number;
  created_at: string;
  updated_at: string;
}

export interface GrantOpportunity {
  id: number;
  name: string;
  funding_organization: string;
  funder_type: string;
  experience_level: string;
  description: string;
  deadline: string | null;
  source_url: string;
  award_amount: string | null;
  score: number;
  rationale: string;
  how_to_improve: string | null;
  last_visited: string | null;
  favorite: boolean;
  hidden: boolean;
  hidden_reason: string | null;
  left_to_right_ratio: number | null;
}

export interface GrantProjectDetail {
  id: number;
  name: string;
  research_summary: string;
  created_at: string;
  grant_proposals: any[];
  seed_draft: any;
  grant_opportunities: GrantOpportunity[];
  saved_grant_opportunities: GrantOpportunity[];
}

export async function saveUserContext(data: OnboardingResponse[]): Promise<{ success: boolean }> {
  return callBackendApi({
    method: 'POST',
    endpoint: `${BASE}/create_grant_onboarding_responses`,
    data: { data },
  });
}

export async function createProject(
  researchSummary: string,
  name?: string,
): Promise<{ project: GrantProject }> {
  return callBackendApi({
    method: 'POST',
    endpoint: `${BASE}/create_project`,
    data: { research_summary: researchSummary, ...(name ? { name } : {}) },
  });
}

export async function getProject(id: number): Promise<GrantProjectDetail> {
  return callBackendApi({
    method: 'GET',
    endpoint: `${BASE}/get_project?id=${encodeURIComponent(id)}`,
  });
}

export async function listProjects(): Promise<{ projects: GrantProject[] }> {
  return callBackendApi({
    method: 'GET',
    endpoint: `${BASE}/get_projects`,
  });
}

export async function setFavoriteOpportunity(
  projectId: number,
  grantOpportunityId: number,
  favorite: boolean,
): Promise<{ success: boolean }> {
  return callBackendApi({
    method: 'PATCH',
    endpoint: `${BASE}/set_favorite_grant_opportunity`,
    data: { project_id: projectId, grant_opportunity_id: grantOpportunityId, favorite },
  });
}

export async function setHiddenOpportunity(
  projectId: number,
  grantOpportunityId: number,
  hidden: boolean,
): Promise<{ success: boolean }> {
  return callBackendApi({
    method: 'PATCH',
    endpoint: `${BASE}/set_hidden_grant_opportunity`,
    data: { project_id: projectId, grant_opportunity_id: grantOpportunityId, hidden },
  });
}

export async function setHiddenReason(
  projectId: number,
  grantOpportunityId: number,
  hiddenReason: string,
): Promise<{ success: boolean }> {
  return callBackendApi({
    method: 'PATCH',
    endpoint: `${BASE}/set_grant_opportunity_hidden_reason`,
    data: { project_id: projectId, grant_opportunity_id: grantOpportunityId, hidden_reason: hiddenReason },
  });
}

export async function visitOpportunity(
  projectId: number,
  grantOpportunityId: number,
): Promise<{ success: boolean }> {
  return callBackendApi({
    method: 'PATCH',
    endpoint: `${BASE}/visit_grant_opportunity`,
    data: { project_id: projectId, grant_opportunity_id: grantOpportunityId },
  });
}

export async function updateProject(
  id: number,
  updates: { name?: string; research_summary?: string },
): Promise<{ success: boolean; project_id: number }> {
  return callBackendApi({
    method: 'PATCH',
    endpoint: `${BASE}/update_project`,
    data: { id, ...updates },
  });
}
