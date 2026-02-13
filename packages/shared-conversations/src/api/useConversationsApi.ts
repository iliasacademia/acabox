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
      projectId: number,
      limit: number = 20
    ): Promise<ListConversationsResponse> => {
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: limit.toString(),
        parent_id: projectId.toString(),
        parent_type: 'Project',
      });

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
      projectId: number
    ): Promise<ConversationResponse | null> => {
      try {
        const params = new URLSearchParams({
          conversation_id: conversationId.toString(),
          parent_id: projectId.toString(),
          parent_type: 'Project',
        });

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
     * POST /v0/co_scientist/create_conversation
     */
    createConversation: async (
      content: string,
      agentName: string,
      projectId: number
    ): Promise<ConversationDetail> => {
      const response = await client.invoke<{ conversation: ConversationDetail }>({
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
    },

    /**
     * Create new message in conversation (project-scoped)
     * POST /v0/co_scientist/create_message
     */
    createMessage: async (
      conversationId: number,
      content: string,
      projectId: number
    ): Promise<Message> => {
      const response = await client.invoke<{ message: Message }>({
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
    },

    /**
     * Trigger fact-check for a review
     * POST /v0/co_scientist/fact_check_review
     */
    factCheckReview: async (
      conversationId: number,
      reviewId: number,
      projectId?: number
    ): Promise<{ success: boolean; message: string }> => {
      const data: Record<string, unknown> = {
        conversation_id: conversationId,
        review_id: reviewId,
      };

      if (projectId) {
        data.project_id = projectId;
        data.parent_type = 'Project';
      }

      const response = await client.invoke<{ success: boolean; message: string }>({
        method: 'POST',
        endpoint: 'v0/co_scientist/fact_check_review',
        data,
      });
      return response;
    },
  }), [client]);
}
