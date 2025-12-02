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
  initializeMessages: (conversationId: number, projectId: number) => Promise<void>;
  addOptimisticMessage: (message: Message) => void;
}

export function useConversationPolling(): UseConversationPollingResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const conversationIdRef = useRef<number | null>(null);
  const projectIdRef = useRef<number | null>(null);
  const shouldKeepMessages = useRef<boolean>(false);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
    // Note: We keep messages intact when polling stops naturally (AI response complete)
    // Messages are only cleared when conversation changes
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
        id: conversation.conversation.id,
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

  // Initialize messages for a conversation (used when switching conversations)
  const initializeMessages = useCallback(
    async (conversationId: number, projectId: number) => {
      // Stop any active polling
      stopPolling();

      // Clear messages and store IDs
      setMessages([]);
      conversationIdRef.current = conversationId;
      projectIdRef.current = projectId;

      // Load initial messages
      setIsLoading(true);
      setError(null);

      try {
        console.log('[ConversationPolling] Initializing messages for conversation:', conversationId);
        const conversation = await getConversation(conversationId, projectId);

        if (conversation && conversation.messages) {
          setMessages(conversation.messages);
        }
      } catch (err: any) {
        console.error('[ConversationPolling] Failed to initialize messages:', err);
        setError(err.message || 'Failed to load messages');
      } finally {
        setIsLoading(false);
      }
    },
    [stopPolling]
  );

  // Add a message optimistically (before API confirms it)
  const addOptimisticMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

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
    initializeMessages,
    addOptimisticMessage,
  };
}
