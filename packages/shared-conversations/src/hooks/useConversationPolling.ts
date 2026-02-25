import { useState, useEffect, useCallback, useRef } from 'react';
import { useConversationsApi } from '../api/useConversationsApi';
import { Message, Conversation } from '../types/conversation';

const POLL_INTERVAL = 2000; // 2 seconds

export interface MessageCreatedEvent {
  conversation_id: number;
  message_id: number;
  role: string;
  is_final?: boolean;
}

export interface UseConversationPollingOptions {
  /**
   * Optional callback for when a message_created event is received from an event stream.
   * When provided, the hook will call refetch() automatically when events arrive,
   * reducing the need for constant polling.
   *
   * @param callback - Called to register the event listener. Should return a cleanup function.
   */
  onEventReceived?: (handler: (event: MessageCreatedEvent) => void) => () => void;
}

export interface UseConversationPollingResult {
  messages: Message[];
  conversation: Conversation | null;
  isPolling: boolean;
  isLoading: boolean;
  error: string | null;
  startPolling: (conversationId: number, projectId: number) => void;
  stopPolling: () => void;
  refetch: () => Promise<void>;
  initializeMessages: (conversationId: number, projectId: number) => Promise<void>;
  addOptimisticMessage: (message: Message) => void;
}

/**
 * Hook for polling conversation messages with automatic updates.
 * Uses the injected API client via useConversationsApi hook.
 *
 * @param options - Optional configuration for event-driven updates
 *
 * @example
 * // Basic usage (polling only)
 * const { messages, isPolling, startPolling, stopPolling } = useConversationPolling();
 *
 * @example
 * // Event-driven usage (Electron)
 * const { messages, startPolling } = useConversationPolling({
 *   onEventReceived: (handler) => {
 *     window.electronAPI.on('message-created', handler);
 *     return () => window.electronAPI.removeListener('message-created', handler);
 *   }
 * });
 */
export function useConversationPolling(
  options?: UseConversationPollingOptions
): UseConversationPollingResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const conversationIdRef = useRef<number | null>(null);
  const projectIdRef = useRef<number | null>(null);

  const { getConversation } = useConversationsApi();

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
      const response = await getConversation(
        conversationIdRef.current,
        projectIdRef.current
      );

      if (!response) {
        console.error('[ConversationPolling] Conversation not found');
        setError('Conversation not found');
        stopPolling();
        return;
      }

      // Extract conversation and messages from response
      // Response structure: { conversation: {...}, messages: [...] }
      const conversationData = (response as any).conversation || response;
      const messagesArray = (response as any).messages || [];

      setConversation(conversationData);
      setMessages(messagesArray);
      setError(null); // Clear any previous errors

      // Check if the AI response is complete.
      // Stop polling when any last message has data.final === true.
      const lastMessage = messagesArray[messagesArray.length - 1];
      if (lastMessage && (lastMessage.data as { final?: boolean })?.final === true) {
        stopPolling();
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('[ConversationPolling] Failed to fetch messages:', err);
      setError(error.message || 'Failed to load messages');
      // Don't stop polling on temporary network errors
      // Only set error without stopping so it can retry
    } finally {
      setIsLoading(false);
    }
  }, [getConversation, stopPolling]);

  const startPolling = useCallback(
    (conversationId: number, projectId: number) => {
      // Stop any existing polling
      stopPolling();

      // Store IDs
      conversationIdRef.current = conversationId;
      projectIdRef.current = projectId;
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
      setConversation(null);
      conversationIdRef.current = conversationId;
      projectIdRef.current = projectId;

      // Load initial messages
      setIsLoading(true);
      setError(null);

      try {
        const response = await getConversation(conversationId, projectId);

        if (response) {
          // Extract conversation and messages from response
          // Response structure: { conversation: {...}, messages: [...] }
          const conversationData = (response as any).conversation || response;
          const messagesArray = (response as any).messages || [];

          setConversation(conversationData);
          setMessages(messagesArray);
        }
      } catch (err: unknown) {
        const error = err as { message?: string };
        console.error('[ConversationPolling] Failed to initialize messages:', err);
        setError(error.message || 'Failed to load messages');
      } finally {
        setIsLoading(false);
      }
    },
    [getConversation, stopPolling]
  );

  // Add a message optimistically (before API confirms it)
  const addOptimisticMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  // Event-driven updates (if supported)
  useEffect(() => {
    if (!options?.onEventReceived) return;

    const handleEvent = async (event: MessageCreatedEvent) => {
      // Check if this event is for the active conversation
      if (event.conversation_id !== conversationIdRef.current) {
        return;
      }

      console.log('[ConversationPolling] message_created event received, fetching messages');

      // Trigger a refetch to get the new message
      await refetch();

      // If this is the final message, stop polling
      if (event.is_final === true) {
        console.log('[ConversationPolling] Final message received, stopping polling');
        stopPolling();
      }
    };

    // Register event listener and get cleanup function
    const cleanup = options.onEventReceived(handleEvent);

    return cleanup;
  }, [options, refetch, stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return {
    messages,
    conversation,
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
