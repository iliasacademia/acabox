/**
 * Conversations API Layer
 *
 * This file provides the API client for the Conversations feature.
 * All API calls are made to the backend at /v0/co_scientist/ endpoints.
 */

import { IPC_CHANNELS } from '../../shared/types';

// ============================================================================
// TYPE DEFINITIONS (Backend Data Models)
// ============================================================================

export interface MessageContext {
  id: number;
  target_type: string | null;
  target_id: number | null;
  target_name: string | null;
  created_at: string;
}

export interface Message {
  id: number;
  role: string; // 'user' | 'assistant' | 'tool'
  content: string;
  format?: 'markdown' | 'html'; // Content format, defaults to markdown if not specified
  data: Record<string, any> | null; // tool_call data, final flag, etc.
  created_at: string;
  contexts: MessageContext[];
}

export interface Conversation {
  id: number;
  agent_name: string;
  title: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  parent_id?: number | null;
  parent_type?: string | null;
}

export interface ConversationResponse {
  conversation: Conversation;
  messages: Message[];
}
export interface ConversationDetail extends Conversation {
  messages: Message[];
}

export interface ListConversationsResponse {
  conversations: Conversation[];
  has_more: boolean;
  total_count: number;
}

export interface GetConversationResponse {
  conversation: ConversationDetail;
}

export interface CreateConversationRequest {
  content: string;
  agent_name: string;
  parent_id?: number;
  parent_type?: string;
}

export interface CreateMessageRequest {
  content: string;
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * List conversations (project-scoped)
 * GET /v0/co_scientist/list_conversations?offset=0&parent_id=123&parent_type=Project
 */
export async function listConversations(
  offset: number = 0,
  projectId: number
): Promise<ListConversationsResponse> {
  const params = new URLSearchParams({
    offset: offset.toString(),
    parent_id: projectId.toString(),
    parent_type: 'Project',
  });

  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'GET',
    endpoint: `v0/co_scientist/list_conversations?${params.toString()}`,
  });

  return {
    conversations: response.conversations || [],
    has_more: response.has_more || false,
    total_count: response.total_count || 0,
  };
}

/**
 * Get single conversation with messages (project-scoped)
 * GET /v0/co_scientist/get_conversation?conversation_id=123&parent_id=456&parent_type=Project
 */
export async function getConversation(
  conversationId: number,
  projectId: number
): Promise<ConversationResponse | null> {
  try {
    const params = new URLSearchParams({
      conversation_id: conversationId.toString(),
      parent_id: projectId.toString(),
      parent_type: 'Project',
    });

    const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
      method: 'GET',
      endpoint: `v0/co_scientist/get_conversation?${params.toString()}`,
    });
    return response;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Create new conversation (project-scoped)
 * POST /v0/co_scientist/create_conversation
 */
export async function createConversation(
  content: string,
  agentName: string,
  projectId: number
): Promise<ConversationDetail> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: 'v0/co_scientist/create_conversation',
    data: {
      content,
      agent_name: agentName,
      parent_id: projectId,
      parent_type: 'Project',
    },
  });
  return response.conversation;
}

/**
 * Create new message in conversation (project-scoped)
 * POST /v0/co_scientist/create_message
 */
export async function createMessage(
  conversationId: number,
  content: string,
  projectId: number
): Promise<Message> {
  const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
    method: 'POST',
    endpoint: 'v0/co_scientist/create_message',
    data: {
      conversation_id: conversationId,
      content,
      parent_id: projectId,
      parent_type: 'Project',
    },
  });
  return response.message;
}
