import { useMemo, useRef } from 'react';
import type {
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ToolCallMessagePart,
} from '@assistant-ui/react';
import { useAui } from '@assistant-ui/react';
import type { ChatStreamMessage, ChatMessageStream, IPCAttachment } from '../shared/types';
import { setToolProgress, clearToolProgress, resetProgress, setSubagentStarted, updateSubagentProgress, setSubagentDone, setProcessingLabel } from './progressStore';
import { track as trackAnalytics, shiftPendingAttribution } from './coscientistAnalytics';

export function toAsyncIterable(
  stream: ChatMessageStream,
): AsyncIterable<ChatStreamMessage> {
  return {
    [Symbol.asyncIterator]() {
      return stream as AsyncIterator<ChatStreamMessage>;
    },
  };
}

/**
 * `onSend` fires synchronously at the start of every send (regardless of where
 * it was initiated — global composer, chat detail, anywhere). The caller uses
 * this to navigate the UI to chat detail. The callback is read through a ref
 * so updates don't invalidate the memoized adapter identity.
 */
export function useElectronChatAdapter(onSend?: () => void): ChatModelAdapter {
  const aui = useAui() as any;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  return useMemo(() => createElectronChatAdapter(aui, onSendRef), [aui]);
}

function createElectronChatAdapter(aui: any, onSendRef: React.MutableRefObject<(() => void) | undefined>): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, context }) {
      const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
      if (!lastUserMessage) return;

      // Fire the navigation hook before any IPC. Idempotent if the user is
      // already in chat detail (parent's setState calls compare equal). This
      // is the single deterministic point that ensures the UI opens the chat
      // on every send — replacing the old NavigateOnSend state subscription
      // which could miss the 0→1 transition under remount / suppressed-reset
      // conditions.
      onSendRef.current?.();

      const { remoteId } = await aui.threadListItem().initialize();
      const threadId = remoteId;

      const userText = lastUserMessage.content
        .filter(
          (part): part is { type: 'text'; text: string } => part.type === 'text',
        )
        .map((part) => part.text)
        .join('');

      const model = context?.config?.modelName;

      // One-shot: callers (e.g. Writing-Agent flow) set this on the window
      // before triggering composer.send so the not-yet-existent session row
      // gets created with the right document_path. Consumed exactly once.
      const pendingDocPath = (window as any).__nextSessionDocumentPath as string | undefined;
      if (pendingDocPath) {
        delete (window as any).__nextSessionDocumentPath;
      }

      // Single correlation id for the full renderer → main → agent-server →
      // SSE round-trip. Grep this id across logs to reconstruct a turn.
      const messageId = crypto.randomUUID();
      console.log(`[ChatAdapter] send messageId=${messageId} threadId=${threadId} textLen=${userText.length}`);

      // Telemetry: fire chat.thread_created when this send is the FIRST
      // message of the thread (no prior history) — assistant-ui hydrates
      // `messages` from persisted history before calling run(), so
      // length === 1 with a single user message is the deterministic
      // "brand-new thread, first send" signal across renderer reloads.
      const attachments = extractAttachments(lastUserMessage);
      const modelForTelemetry = model ?? 'unknown';
      const isBrandNewThread =
        messages.length === 1 && messages[0].role === 'user';
      if (isBrandNewThread) {
        trackAnalytics({
          name: 'chat.thread_created',
          metadata: { thread_id: threadId },
        });
        // Bind any pending suggestion-attribution (from a Build-it click that
        // initiated this thread) to threadId. Main process indexes attributions
        // by thread_id; tool:opened resolves the tool's creating thread via
        // manifest.chatSessionId at first-open time.
        const pendingAttr = shiftPendingAttribution();
        if (pendingAttr) {
          window.toolAnalyticsAPI
            .setThreadAttribution(threadId, {
              source: pendingAttr.source,
              briefing_id: pendingAttr.briefing_id,
            })
            .catch(() => {});
        }
      }
      trackAnalytics({
        name: 'chat.message_sent',
        metadata: {
          thread_id: threadId,
          message_length: userText.length,
          attachment_count: attachments?.length ?? 0,
          model: modelForTelemetry,
        },
      });

      const turnStartMs = Date.now();
      let responseTextLength = 0;
      let toolCallCount = 0;

      // Detect agent creating a new tool by watching for an invocation of
      // .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs.
      // When seen, register the current turn's userText as the creation_prompt
      // for this thread. Main keys prompts by thread_id; tool:opened looks them
      // up via manifest.chatSessionId.
      //
      // Accumulate streamed argsText per toolCallId (Bash args arrive via
      // tool-call-args-delta), and also handle the non-streamed `tool-call`
      // shape. Fire at most once per turn.
      const CREATION_TRIGGER = 'manage_mini_app.mjs';
      const argsByToolCallId = new Map<string, string>();
      let creationPromptFired = false;
      const maybeFireCreationPrompt = (argsText: string) => {
        if (creationPromptFired) return;
        if (!argsText.includes(CREATION_TRIGGER)) return;
        creationPromptFired = true;
        window.toolAnalyticsAPI
          .setThreadCreationPrompt(threadId, userText)
          .catch(() => {
            // Analytics IPC failure is non-blocking — swallow.
          });
      };

      // sendMessage returns the stream synchronously; failures from main are
      // surfaced via the chat:error channel that the stream iterator already
      // listens on. Awaiting across contextBridge would break the stream's
      // `next()` proxying — see preload's sendMessage comment.
      const { stream, release } = window.chatAPI.sendMessage(
        threadId, userText, attachments, model, pendingDocPath, messageId,
      );
      const responseStream = toAsyncIterable(stream);

      const response = responseBuilder();
      resetProgress();

      const onAbort = () => window.chatAPI.stopResponding(threadId);
      abortSignal.addEventListener('abort', onAbort, { once: true });

      try {
        let eventCount = 0;
        for await (const msg of responseStream) {
          eventCount++;
          if (msg.type !== 'text-delta' && msg.type !== 'thinking-delta' && msg.type !== 'tool-call-args-delta' && msg.type !== 'heartbeat') {
            console.log(`[ChatAdapter] event #${eventCount} type=${msg.type} for ${threadId}`);
          }
          // Telemetry counters — sum across streamed and non-streamed shapes.
          if (msg.type === 'text-delta') {
            responseTextLength += msg.text.length;
          } else if (msg.type === 'text') {
            responseTextLength += msg.text.length;
          } else if (msg.type === 'tool-call-start' || msg.type === 'tool-call') {
            toolCallCount += 1;
          }

          // Creation-prompt detection: watch tool-call args as they stream.
          if (msg.type === 'tool-call-start') {
            argsByToolCallId.set(msg.toolCallId, '');
          } else if (msg.type === 'tool-call-args-delta') {
            const prev = argsByToolCallId.get(msg.toolCallId) ?? '';
            const next = prev + msg.argsText;
            argsByToolCallId.set(msg.toolCallId, next);
            maybeFireCreationPrompt(next);
          } else if (msg.type === 'tool-call') {
            // Non-streamed shape: full argsText present at once.
            const fullArgs = msg.argsText ?? JSON.stringify(msg.args ?? {});
            maybeFireCreationPrompt(fullArgs);
          }
          if (abortSignal.aborted) {
            console.log(`[ChatAdapter] Stream loop aborted for ${threadId} after ${eventCount} events`);
            break;
          }
          if (msg.type === 'turn-complete') {
            console.log(`[ChatAdapter] Turn complete for ${threadId} after ${eventCount} events`);
            trackAnalytics({
              name: 'chat.message_received',
              metadata: {
                thread_id: threadId,
                response_length: responseTextLength,
                model: modelForTelemetry,
                turn_duration_ms: Date.now() - turnStartMs,
                tool_call_count: toolCallCount,
              },
            });
            break;
          }
          response.onMessage(msg);
          yield { content: response.getContent() };
        }
        console.log(`[ChatAdapter] Stream loop ended for ${threadId}, total events=${eventCount}`);
      } finally {
        abortSignal.removeEventListener('abort', onAbort);
        resetProgress();
        // Free OUR stream iterator's slot. `release` is bound to the
        // iterator returned by sendMessage above — if a takeover
        // force-subscribed mid-turn and replaced it, this call's cleanup
        // ownership check makes it a no-op on the takeover's iterator
        // instead of killing it. A `chatAPI.releaseStream(threadId)` style
        // call would do the latter and break the takeover's resumeRun.
        // (Abort-path already calls markDone via `stopResponding`; this
        // is a no-op in that case.)
        release();
      }
    },
  };
}

export function responseBuilder() {
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
      case 'status':
        setProcessingLabel((msg as { status?: string }).status || null);
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

  return {
    onMessage,
    getContent,
  };
}

function extractAttachments(message: { attachments?: readonly any[] }): IPCAttachment[] | undefined {
  if (!message.attachments?.length) return undefined;

  const attachments: IPCAttachment[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type === 'file_reference') {
      const textPart = (attachment.content ?? []).find((p: any) => p.type === 'text');
      if (textPart) {
        attachments.push({
          type: 'file_reference',
          filePath: (textPart as any).text as string,
          name: attachment.name,
        });
      }
      continue;
    }
    for (const part of attachment.content ?? []) {
      if (part.type === 'image') {
        const match = (part.image as string).match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (match) {
          attachments.push({ type: 'image', data: match[2], mediaType: match[1], name: attachment.name });
        }
      } else if (part.type === 'file') {
        attachments.push({
          type: 'document',
          data: part.data as string,
          mediaType: part.mimeType as string,
          title: part.filename as string | undefined,
          name: attachment.name,
        });
      }
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}
