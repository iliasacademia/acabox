import { useMemo } from 'react';
import {
  type ThreadMessageLike,
  ExportedMessageRepository,
} from '@assistant-ui/react';
import type { ThreadHistoryAdapter } from '@assistant-ui/react';
import type { ReadonlyJSONObject } from 'assistant-stream/utils';

const SESSION_ID = 'calendar-assistant';

export function useCalendarHistoryAdapter(): ThreadHistoryAdapter {
  return useMemo(
    (): ThreadHistoryAdapter => ({
      async load() {
        const dbMessages = await window.sessionsAPI.listMessages(SESSION_ID);
        const toolResults = buildToolResultsMap(dbMessages);
        const messages = convertToThreadMessages(dbMessages, toolResults);
        return ExportedMessageRepository.fromArray(messages);
      },

      async append() {},
    }),
    [],
  );
}

// --- Types ---

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

// --- Conversion helpers (same as notesHistoryAdapter) ---

function buildToolResultsMap(dbMessages: MessageData[]): ToolResultsMap {
  const toolResults: ToolResultsMap = new Map();
  for (const msg of dbMessages) {
    if (msg.type === 'tool_result') {
      const blocks = JSON.parse(msg.content) as (AnthropicToolResultBlock | { type: string })[];
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        const trBlock = block as AnthropicToolResultBlock;
        toolResults.set(trBlock.tool_use_id, {
          result: trBlock.content,
          isError: trBlock.is_error ?? false,
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
  let pendingAssistantContent: ReturnType<typeof convertAssistantContent> | null = null;

  const flushAssistant = () => {
    if (pendingAssistantContent && pendingAssistantContent.length > 0) {
      messages.push({ role: 'assistant', content: pendingAssistantContent });
    }
    pendingAssistantContent = null;
  };

  for (const msg of dbMessages) {
    if (msg.type === 'user') {
      flushAssistant();
      messages.push(convertUserMessage(msg.content));
    } else if (msg.type === 'assistant') {
      const newContent = convertAssistantContent(msg.content, toolResults);
      if (pendingAssistantContent) {
        pendingAssistantContent.push(...newContent);
      } else {
        pendingAssistantContent = [...newContent];
      }
    }
  }
  flushAssistant();

  return messages;
}

function convertUserMessage(content: string): ThreadMessageLike {
  const parsed = JSON.parse(content) as { text: string; attachments?: any[] };
  return { role: 'user', content: parsed.text };
}

function convertAssistantContent(content: string, toolResults: ToolResultsMap) {
  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
    return [{ type: 'text' as const, text: (parsed as { text: string }).text }];
  }

  const blocks = parsed as AnthropicContentBlock[];
  return blocks
    .filter((block): block is AnthropicContentBlock =>
      block.type === 'text' || block.type === 'tool_use',
    )
    .map((block) => {
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
