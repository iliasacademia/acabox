import { useEffect } from 'react';
import { useThreadRuntime, useAuiState } from '@assistant-ui/react';
import type { ChatStreamMessage, ChatMessageStream } from '../shared/types';
import type { ThreadAssistantMessagePart, ToolCallMessagePart } from '@assistant-ui/react';
import { setToolProgress, clearToolProgress, resetProgress, setSubagentStarted, updateSubagentProgress, setSubagentDone, setProcessingLabel } from './progressStore';

const IDLE_TIMEOUT_MS = 60_000;

/**
 * Subscribes to agent session events whenever a thread is opened.
 * Assumes any thread might have a running session. If events arrive,
 * feeds them into the assistant-ui thread runtime via resumeRun().
 * Auto-unsubscribes after 60s of no new events (heartbeat events from
 * the agent session prevent this from firing during active processing).
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
                const onAbort = () => window.chatAPI.stopResponding(remoteId!);
                abortSignal.addEventListener('abort', onAbort, { once: true });

                try {
                  // Yield the first event we already processed
                  yield { content: response.getContent() };

                  // Continue yielding subsequent events
                  for await (const nextMsg of iterable) {
                    if (abortSignal.aborted || cancelled) break;
                    resetIdleTimer();
                    response.onMessage(nextMsg);
                    yield { content: response.getContent() };
                  }
                } finally {
                  abortSignal.removeEventListener('abort', onAbort);
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
      resetProgress();
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
  let streamingReasoning = '';
  let streamingToolCall: {
    toolCallId: string;
    toolName: string;
    argsText: string;
  } | null = null;

  const getContent = (): ThreadAssistantMessagePart[] => {
    const content: ThreadAssistantMessagePart[] = [...messages];
    if (streamingReasoning) {
      content.push({ type: 'reasoning', text: streamingReasoning });
    }
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
      case 'thinking-delta':
        streamingReasoning += msg.text;
        return;
      case 'thinking-end':
        if (streamingReasoning) {
          messages.push({ type: 'reasoning', text: streamingReasoning });
          streamingReasoning = '';
        }
        return;
      case 'tool-progress':
        setToolProgress(msg.toolCallId, msg.toolName, msg.elapsedSeconds);
        return;
      case 'subagent-started':
        setSubagentStarted(msg.parentToolCallId, msg.taskId, msg.description);
        return;
      case 'subagent-progress':
        updateSubagentProgress(msg.parentToolCallId, {
          summary: msg.summary,
          lastToolName: msg.lastToolName,
          toolUseCount: msg.toolUseCount,
          durationMs: msg.durationMs,
        });
        return;
      case 'subagent-done':
        setSubagentDone(msg.parentToolCallId, msg.status, msg.summary);
        return;
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
        clearToolProgress(msg.toolCallId);
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
      case 'status':
        setProcessingLabel((msg as any).status || null);
        return;
      case 'tool-result': {
        clearToolProgress(msg.toolCallId);
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
