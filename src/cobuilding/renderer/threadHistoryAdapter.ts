import { useMemo } from 'react';
import {
  useAuiState,
  type ThreadMessageLike,
  ExportedMessageRepository,
} from '@assistant-ui/react';
import type { ThreadHistoryAdapter } from '@assistant-ui/react';
import type { ReadonlyJSONObject } from 'assistant-stream/utils';

export function useThreadHistoryAdapter(): ThreadHistoryAdapter {
  const remoteId = useAuiState((s: any) => s.threadListItem.remoteId) as string | undefined;

  return useMemo(
    (): ThreadHistoryAdapter => ({
      async load() {
        if (!remoteId) {
          return ExportedMessageRepository.fromArray([]);
        }

        const dbMessages = await window.sessionsAPI.listMessages(remoteId);
        const toolResults = buildToolResultsMap(dbMessages);
        const messages = convertToThreadMessages(dbMessages, toolResults);

        return ExportedMessageRepository.fromArray(messages);
      },

      async append() {},
    }),
    [remoteId],
  );
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

type ToolResultsMap = Map<string, { result: unknown; isError: boolean }>;

type MessageData = Awaited<ReturnType<typeof window.sessionsAPI.listMessages>>[number];

function buildToolResultsMap(dbMessages: MessageData[]): ToolResultsMap {
  const toolResults: ToolResultsMap = new Map();
  for (const msg of dbMessages) {
    if (msg.type === 'tool_result') {
      const blocks = JSON.parse(msg.content) as AnthropicToolResultBlock[];
      for (const block of blocks) {
        toolResults.set(block.tool_use_id, {
          result: block.content,
          isError: block.is_error ?? false,
        });
      }
    }
  }
  return toolResults;
}

function convertToThreadMessages(
  dbMessages: MessageData[],
  toolResults: ToolResultsMap,
): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];

  for (const msg of dbMessages) {
    if (msg.type === 'user') {
      messages.push(convertUserMessage(msg.content));
    } else if (msg.type === 'assistant') {
      messages.push({
        role: 'assistant',
        content: convertAssistantContent(msg.content, toolResults),
      });
    }
  }

  return messages;
}

interface StoredAttachment {
  type: 'image' | 'document';
  mediaType: string;
  name?: string;
  title?: string;
}

function convertUserMessage(content: string): ThreadMessageLike {
  const parsed = JSON.parse(content) as { text: string; attachments?: StoredAttachment[] };
  const storedAttachments = parsed.attachments ?? [];

  const attachments = storedAttachments.map((att: StoredAttachment, i: number) => ({
    id: `att-${i}`,
    type: att.type,
    name: att.name ?? att.title ?? (att.type === 'image' ? 'image' : 'file'),
    contentType: att.mediaType,
    status: { type: 'complete' as const },
    content: [] as any[],
  }));

  return {
    role: 'user',
    content: parsed.text,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function convertAssistantContent(content: string, toolResults: ToolResultsMap) {
  const blocks = JSON.parse(content) as AnthropicContentBlock[];
  return blocks.map((block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    const result = toolResults.get(block.id);
    return {
      type: 'tool-call' as const,
      toolCallId: block.id,
      toolName: block.name,
      args: block.input as ReadonlyJSONObject,
      result: result?.result,
      isError: result?.isError ?? false,
    };
  });
}
