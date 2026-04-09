import { useEffect } from 'react';
import { useThreadRuntime, useAuiState } from '@assistant-ui/react';
import type { ChatStreamMessage, ChatMessageStream } from '../shared/types';
import type { ThreadAssistantMessagePart, ToolCallMessagePart } from '@assistant-ui/react';

const IDLE_TIMEOUT_MS = 60_000;

/**
 * Subscribes to agent session events whenever a thread is opened.
 * Assumes any thread might have a running session. If events arrive,
 * feeds them into the assistant-ui thread runtime via resumeRun().
 * Auto-unsubscribes after 60s of no new events.
 */
export function useSessionSubscription() {
  const threadRuntime = useThreadRuntime();
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;

  useEffect(() => {
    if (!remoteId) return;

    const { stream, unsubscribe } = window.chatAPI.subscribe(remoteId);
    let cancelled = false;
    let started = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cancelled = true;
        unsubscribe();
      }, IDLE_TIMEOUT_MS);
    };

    // Start the idle timer immediately
    resetIdleTimer();

    (async () => {
      const iterable = toAsyncIterable(stream);
      const response = responseBuilder();

      for await (const msg of iterable) {
        if (cancelled) break;
        resetIdleTimer();
        response.onMessage(msg);

        if (!started) {
          started = true;
          try {
            const messages = threadRuntime.getState().messages;
            const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
            threadRuntime.resumeRun({
              parentId: lastMessageId,
              stream: async function* ({ abortSignal }) {
                // Yield the first event we already processed
                yield { content: response.getContent() };

                // Continue yielding subsequent events
                for await (const nextMsg of iterable) {
                  if (abortSignal.aborted || cancelled) break;
                  resetIdleTimer();
                  response.onMessage(nextMsg);
                  yield { content: response.getContent() };
                }
              },
            });
          } catch {
            // Ignore — a concurrent run() from chatAdapter may already be active
          }
          break; // The inner generator now owns the stream iteration
        }
      }
    })();

    return () => {
      cancelled = true;
      if (idleTimer) clearTimeout(idleTimer);
      unsubscribe();
    };
  }, [remoteId, threadRuntime]);
}

function toAsyncIterable(stream: ChatMessageStream): AsyncIterable<ChatStreamMessage> {
  return {
    [Symbol.asyncIterator]() {
      return stream as AsyncIterator<ChatStreamMessage>;
    },
  };
}

function responseBuilder() {
  const messages: ThreadAssistantMessagePart[] = [];
  let streamingText = '';
  let streamingToolCall: {
    toolCallId: string;
    toolName: string;
    argsText: string;
  } | null = null;

  const getContent = (): ThreadAssistantMessagePart[] => {
    const content: ThreadAssistantMessagePart[] = [...messages];
    if (streamingText) {
      content.push({ type: 'text', text: streamingText });
    }
    if (streamingToolCall) {
      content.push({
        type: 'tool-call',
        toolCallId: streamingToolCall.toolCallId,
        toolName: streamingToolCall.toolName,
        args: {} as any,
        argsText: streamingToolCall.argsText,
      });
    }
    return content;
  };

  const onMessage = (msg: ChatStreamMessage) => {
    switch (msg.type) {
      case 'text-delta':
        streamingText += msg.text;
        return;
      case 'tool-call-start':
        streamingToolCall = {
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          argsText: '',
        };
        return;
      case 'tool-call-args-delta':
        if (streamingToolCall) {
          streamingToolCall.argsText += msg.argsText;
        }
        return;
      case 'tool-call-end':
        streamingToolCall = null;
        return;
      case 'text':
        streamingText = '';
        messages.push(msg);
        return;
      case 'tool-call':
        streamingToolCall = null;
        messages.push({
          type: 'tool-call',
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          args: msg.args as any,
          argsText: msg.argsText,
        });
        return;
      case 'tool-result': {
        const existingIndex = messages.findIndex(
          (m) => m.type === 'tool-call' && m.toolCallId === msg.toolCallId,
        );
        if (existingIndex !== -1) {
          const existing = messages[existingIndex];
          messages[existingIndex] = {
            ...(existing as ToolCallMessagePart),
            result: msg.result,
            isError: msg.isError,
          };
        }
        return;
      }
    }
  };

  return { onMessage, getContent };
}
