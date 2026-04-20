import { APIclient } from '../../apiClient';
import log from 'electron-log';

export interface ServerProject {
  id: number;
  name: string;
  description: string;
  file_count: number;
  primary_manuscript_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ServerProjectFile {
  id: number;
  project_id: number;
  file_name: string;
  file_type: string;
  file_path?: string;
  is_primary_manuscript: boolean;
  size: number;
  tag?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerConversation {
  id: number;
  agent_name: string;
  title: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  parent_id?: number | null;
  parent_type?: string | null;
}

export interface ServerMessage {
  id: number;
  role: string;
  content: string;
  format?: string | null;
  data: Record<string, any> | null;
  created_at: string;
}

export interface ConversationDetailResponse {
  conversation: ServerConversation;
  messages: ServerMessage[];
}

export interface ListConversationsResponse {
  conversations: ServerConversation[];
  has_more: boolean;
  total_count: number;
}

export async function checkWritingAgentAccess(): Promise<boolean> {
  try {
    const client = await APIclient();
    const response = await client.get('v0/co_scientist/projects', {
      validateStatus: (status) => status >= 200 && status < 600,
    });
    return response.status === 200;
  } catch (error) {
    log.error('[WritingAgent] Error checking access:', error);
    return false;
  }
}

export async function fetchProjects(): Promise<ServerProject[]> {
  const client = await APIclient();
  const response = await client.get('v0/co_scientist/projects');
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data?.projects && Array.isArray(data.projects)) return data.projects;
  return [];
}

export async function fetchProjectFiles(projectId: number): Promise<ServerProjectFile[]> {
  const client = await APIclient();
  const response = await client.get(`v0/co_scientist/projects/${projectId}/files`);
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data?.files && Array.isArray(data.files)) return data.files;
  return [];
}

export async function fetchConversations(
  projectId: number,
  offset = 0,
  limit = 50,
): Promise<ListConversationsResponse> {
  const client = await APIclient();
  const response = await client.get('v0/co_scientist/list_conversations', {
    params: {
      parent_id: projectId,
      parent_type: 'Project',
      offset,
      limit,
    },
  });
  return response.data;
}

export async function fetchSupportingFiles(): Promise<ServerProjectFile[]> {
  const client = await APIclient();
  const allFiles: ServerProjectFile[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await client.get('v0/co_scientist/files', {
      params: { is_primary_manuscript: false, limit: 50, page },
    });
    const files = response.data?.files || [];
    allFiles.push(...files);
    hasMore = response.data?.pagination?.has_more ?? false;
    page += 1;
  }

  return allFiles;
}

export async function fetchConversationDetail(
  conversationId: number,
  projectId: number,
): Promise<ConversationDetailResponse> {
  const client = await APIclient();
  const response = await client.get('v0/co_scientist/get_conversation', {
    params: {
      conversation_id: conversationId,
      parent_id: projectId,
      parent_type: 'Project',
    },
  });
  return response.data;
}
