import { useMemo } from 'react';
import { useApiClient } from '../context/ApiContext';
import {
  ListConversationsResponse,
  ConversationResponse,
  ConversationDetail,
  Message,
} from '../types/conversation';

/**
 * Hook that provides conversation-related API functions.
 * Uses the injected API client from context.
 *
 * @example
 * function MyComponent() {
 *   const { listConversations, createMessage } = useConversationsApi();
 *
 *   const loadConversations = async () => {
 *     const result = await listConversations(0, projectId, 20);
 *     console.log(result.conversations);
 *   };
 * }
 */
export function useConversationsApi() {
  const client = useApiClient();

  return useMemo(() => ({
    /**
     * List conversations (project-scoped)
     * GET /v0/co_scientist/list_conversations?offset=0&parent_id=123&parent_type=Project
     */
    listConversations: async (
      offset: number = 0,
      projectId?: number | null,
      limit: number = 20
    ): Promise<ListConversationsResponse> => {
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: limit.toString(),
      });
      if (projectId) {
        params.set('parent_id', projectId.toString());
        params.set('parent_type', 'Project');
      }

      const response = await client.invoke<{
        conversations?: ConversationResponse['conversation'][];
        has_more?: boolean;
        total_count?: number;
      }>({
        method: 'GET',
        endpoint: `v0/co_scientist/list_conversations?${params.toString()}`,
      });

      return {
        conversations: response.conversations || [],
        has_more: response.has_more || false,
        total_count: response.total_count || 0,
      };
    },

    /**
     * Get single conversation with messages (project-scoped)
     * GET /v0/co_scientist/get_conversation?conversation_id=123&parent_id=456&parent_type=Project
     */
    getConversation: async (
      conversationId: number,
      projectId?: number | null
    ): Promise<ConversationResponse | null> => {
      try {
        const params = new URLSearchParams({
          conversation_id: conversationId.toString(),
        });
        if (projectId) {
          params.set('parent_id', projectId.toString());
          params.set('parent_type', 'Project');
        }

        const response = await client.invoke<ConversationResponse>({
          method: 'GET',
          endpoint: `v0/co_scientist/get_conversation?${params.toString()}`,
        });
        return response;
      } catch (error: unknown) {
        const err = error as { response?: { status?: number } };
        if (err.response?.status === 404) {
          return null;
        }
        throw error;
      }
    },

    /**
     * Create new conversation (project-scoped)
     * POST /v0/co_scientist/create_conversation (multipart/form-data)
     */
    createConversation: async (
      content: string,
      agentName: string,
      projectId?: number | null,
      title?: string,
      projectFileIds?: number[],
      filePath?: string
    ): Promise<ConversationDetail> => {
      const data: Record<string, unknown> = {
        content,
        agent_name: agentName,
        ...(title ? { title } : {}),
      };
      if (projectId) {
        data.project_id = projectId;
      }
      if (projectFileIds && projectFileIds.length > 0) {
        data.project_file_ids = projectFileIds;
      }
      if (filePath) {
        data.filePath = filePath;
      }
      const response = await client.invoke<{ conversation: ConversationDetail; message?: unknown }>({
        method: 'POST',
        endpoint: 'create-conversation-with-file',
        data,
      });
      return response.conversation;
    },

    /**
     * Create new message in conversation (project-scoped)
     * POST /v0/co_scientist/create_message (multipart/form-data)
     */
    createMessage: async (
      conversationId: number,
      content: string,
      projectId?: number | null,
      projectFileIds?: number[],
      filePath?: string
    ): Promise<Message> => {
      const data: Record<string, unknown> = {
        conversation_id: conversationId,
        content,
      };
      if (projectId) {
        data.project_id = projectId;
      }
      if (projectFileIds && projectFileIds.length > 0) {
        data.project_file_ids = projectFileIds;
      }
      if (filePath) {
        data.filePath = filePath;
      }
      const response = await client.invoke<{ message: Message }>({
        method: 'POST',
        endpoint: 'send-message-with-file',
        data,
      });
      return response.message;
    },

    /**
     * Archive a conversation
     * POST /v0/co_scientist/archive_conversation
     */
    archiveConversation: async (
      conversationId: number,
      _projectId?: number | null
    ): Promise<void> => {
      await client.invoke<unknown>({
        method: 'POST',
        endpoint: 'v0/co_scientist/archive_conversation',
        data: {
          conversation_id: conversationId,
        },
      });
    },

    /**
     * Unarchive a conversation
     * TODO: update endpoint once API spec is finalized
     * POST /v0/co_scientist/unarchive_conversation
     */
    unarchiveConversation: async (
      conversationId: number,
      _projectId?: number | null
    ): Promise<void> => {
      await client.invoke<unknown>({
        method: 'POST',
        endpoint: 'v0/co_scientist/unarchive_conversation',
        data: {
          conversation_id: conversationId,
        },
      });
    },

    /**
     * List archived conversations (project-scoped)
     * GET /v0/co_scientist/list_conversations?archived=true&parent_id=...&parent_type=Project
     */
    listArchivedConversations: async (
      offset: number = 0,
      projectId?: number | null,
      limit: number = 20
    ): Promise<ListConversationsResponse> => {
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: limit.toString(),
        archived: 'true',
      });
      if (projectId) {
        params.set('parent_id', projectId.toString());
        params.set('parent_type', 'Project');
      }

      const response = await client.invoke<{
        conversations?: ConversationResponse['conversation'][];
        has_more?: boolean;
        total_count?: number;
      }>({
        method: 'GET',
        endpoint: `v0/co_scientist/list_conversations?${params.toString()}`,
      });

      return {
        conversations: response.conversations || [],
        has_more: response.has_more || false,
        total_count: response.total_count || 0,
      };
    },
  }), [client]);
}
