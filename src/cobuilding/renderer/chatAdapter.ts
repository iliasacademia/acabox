import { useMemo } from 'react';
import type {
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ToolCallMessagePart,
} from '@assistant-ui/react';
import { useAui } from '@assistant-ui/react';
import type { ChatStreamMessage, ChatMessageStream } from '../shared/types';

function toAsyncIterable(
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
    async *run({ messages }) {
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

      const responseStream = toAsyncIterable(
        window.chatAPI.sendMessage(threadId, userText),
      );

      const response = responseBuilder();

      for await (const msg of responseStream) {
        response.onMessage(msg);
        yield { content: response.getContent() };
      }
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

  return {
    onMessage,
    getContent,
  };
}
