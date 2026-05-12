import { useMemo } from 'react';
import type {
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ToolCallMessagePart,
} from '@assistant-ui/react';
import { useAui } from '@assistant-ui/react';
import type { ChatStreamMessage, ChatMessageStream, IPCAttachment } from '../shared/types';
import { setToolProgress, clearToolProgress, resetProgress, setSubagentStarted, updateSubagentProgress, setSubagentDone, setProcessingLabel } from './progressStore';

export function toAsyncIterable(
  stream: ChatMessageStream,
): AsyncIterable<ChatStreamMessage> {
  return {
    [Symbol.asyncIterator]() {
      return stream as AsyncIterator<ChatStreamMessage>;
    },
  };
}

export function useElectronChatAdapter(): ChatModelAdapter {
  const aui = useAui() as any;
  return useMemo(() => createElectronChatAdapter(aui), [aui]);
}

function createElectronChatAdapter(aui: any): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, context }) {
      const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
      if (!lastUserMessage) return;

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

      const responseStream = toAsyncIterable(
        window.chatAPI.sendMessage(threadId, userText, extractAttachments(lastUserMessage), model, pendingDocPath),
      );

      const response = responseBuilder();
      resetProgress();

      const onAbort = () => window.chatAPI.stopResponding(threadId);
      abortSignal.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const msg of responseStream) {
          if (abortSignal.aborted) {
            console.debug(`[ChatAdapter] Stream loop aborted for ${threadId}`);
            break;
          }
          response.onMessage(msg);
          yield { content: response.getContent() };
        }
        console.debug(`[ChatAdapter] Stream loop completed normally for ${threadId}`);
      } finally {
        abortSignal.removeEventListener('abort', onAbort);
        resetProgress();
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
