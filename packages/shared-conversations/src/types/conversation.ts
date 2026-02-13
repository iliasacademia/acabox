/**
 * Conversation Types
 *
 * Type definitions for conversations, messages, and related data structures.
 * Extracted from src/renderer/services/conversationsApi.ts
 */

export interface MessageContext {
  id: number;
  target_type: string | null;
  target_id: number | null;
  target_name: string | null;
  created_at: string;
}

export interface FollowUpQuestion {
  type: 'fact_check_review' | 'text_prompt';
  // For fact_check_review
  label?: string;
  description?: string;
  review_id?: number;
  // For text_prompt
  text?: string;
}

export interface Message {
  id: number;
  role: string; // 'user' | 'assistant' | 'tool'
  content: string;
  format?: 'markdown' | 'html'; // Content format, defaults to markdown if not specified
  data: {
    extracted_questions?: FollowUpQuestion[];
    [key: string]: unknown;
  } | null; // tool_call data, final flag, extracted_questions, etc.
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

/**
 * Extended conversation type to support draft conversations
 * (conversations that haven't been created on the server yet)
 */
export interface DraftConversation extends Conversation {
  isDraft: true;
}
