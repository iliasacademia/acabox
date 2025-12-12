/**
 * Type exports for @academia/shared-conversations
 */

// API client types
export type {
  ApiCallOptions,
  ConversationsApiClient,
} from './api';

// Conversation types
export type {
  MessageContext,
  Message,
  Conversation,
  ConversationResponse,
  ConversationDetail,
  ListConversationsResponse,
  GetConversationResponse,
  CreateConversationRequest,
  CreateMessageRequest,
  DraftConversation,
} from './conversation';

// Project types (subset needed for conversations)
export type {
  Project,
  LastReview,
  ProjectFile,
  ReviewSuggestion,
  ReviewData,
  AgentRun,
  DiffResponse,
  ProjectStatusResponse,
} from './project';
