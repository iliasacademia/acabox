import { useState, useEffect, useCallback, useRef } from 'react';
import { Message, getConversation } from '../services/conversationsApi';

const POLL_INTERVAL = 2000; // 2 seconds

interface UseConversationPollingResult {
  messages: Message[];
  isPolling: boolean;
  isLoading: boolean;
  error: string | null;
  startPolling: (conversationId: number, projectId: number) => void;
  stopPolling: () => void;
  refetch: () => Promise<void>;
}

export function useConversationPolling(): UseConversationPollingResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const conversationIdRef = useRef<number | null>(null);
  const projectIdRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const fetchMessages = useCallback(async () => {
    if (!conversationIdRef.current || !projectIdRef.current) return;

    try {
      setIsLoading(true);
      console.log('[ConversationPolling] Fetching messages for conversation:', conversationIdRef.current);

      const conversation = await getConversation(
        conversationIdRef.current,
        projectIdRef.current
      );

      if (!conversation) {
        console.error('[ConversationPolling] Conversation not found');
        setError('Conversation not found');
        stopPolling();
        return;
      }

      console.log('[ConversationPolling] Received conversation:', {
        id: conversation.id,
        messageCount: conversation.messages?.length || 0,
        messages: conversation.messages,
      });

      // Handle different possible response structures
      const messagesArray = conversation.messages || [];
      console.log('[ConversationPolling] Setting messages:', messagesArray);
      setMessages(messagesArray);
      setError(null); // Clear any previous errors

      // Check if the AI response is complete
      // If the last message is from assistant and has final: true, stop polling
      const lastMessage = messagesArray[messagesArray.length - 1];
      if (
        lastMessage &&
        lastMessage.role === 'assistant' &&
        lastMessage.data?.final === true
      ) {
        console.log('[ConversationPolling] AI response complete, stopping poll');
        stopPolling();
      }
    } catch (err: any) {
      console.error('[ConversationPolling] Failed to fetch messages:', err);
      setError(err.message || 'Failed to load messages');
      // Don't stop polling on temporary network errors
      // Only set error without stopping so it can retry
    } finally {
      setIsLoading(false);
    }
  }, [stopPolling]);

  const startPolling = useCallback(
    (conversationId: number, projectId: number) => {
      // Stop any existing polling
      stopPolling();

      // Store IDs
      conversationIdRef.current = conversationId;
      projectIdRef.current = projectId;

      console.log('[ConversationPolling] Starting to poll for messages:', {
        conversationId,
        projectId,
      });

      setIsPolling(true);
      setError(null);

      // Initial fetch
      fetchMessages();

      // Set up interval
      intervalRef.current = setInterval(fetchMessages, POLL_INTERVAL);
    },
    [fetchMessages, stopPolling]
  );

  // Manual refetch function
  const refetch = useCallback(async () => {
    await fetchMessages();
  }, [fetchMessages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return {
    messages,
    isPolling,
    isLoading,
    error,
    startPolling,
    stopPolling,
    refetch,
  };
}
