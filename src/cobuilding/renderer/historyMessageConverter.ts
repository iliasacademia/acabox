/**
 * Shared converter from stored DB rows to assistant-ui's ThreadMessageLike[].
 *
 * Both the desktop history adapter (`threadHistoryAdapter.ts`) and the
 * overlay history adapter (`popupV2/httpChatAdapter.ts`) used to ship
 * their own copies of this logic. The two had drifted: the overlay
 * dropped user-message attachments, mishandled the assistant-content
 * stream pattern slightly differently, and so on. The result was that
 * the SAME conversation, loaded from the SAME database, rendered
 * differently between the desktop and overlay surfaces.
 *
 * This module is the single source of truth. The desktop adapter parses
 * JSON-string content from IPC into objects and feeds it in; the overlay
 * adapter has objects already (the HTTP route does the JSON.parse server-
 * side). Both then call `convertHistoryMessages` and get identical output
 * for identical input.
 */

import type { ThreadMessageLike } from '@assistant-ui/react';
import type { ReadonlyJSONObject } from 'assistant-stream/utils';

// ─── Wire shapes ────────────────────────────────────────────────────

/**
 * Normalized DB row passed into the converter. Each adapter is responsible
 * for parsing its raw transport (string content from IPC, already-parsed
 * content from HTTP) into this shape before calling in.
 */
export interface HistoryDbMessage {
  type: string;
  /**
   * For 'user': `{ text, attachments? }`.
   * For 'assistant': `Array<{ type: 'text'|'tool_use'|... }>`.
   * For 'tool_result': `Array<{ type: 'tool_result', tool_use_id, content, is_error? }>`.
   */
  content: unknown;
  /** ISO timestamp of the DB row, when the transport provides it. */
  createdAt?: string;
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

interface StoredAttachment {
  type: 'image' | 'document';
  mediaType: string;
  name?: string;
  title?: string;
}

type ToolResultsMap = Map<string, { result: unknown; isError: boolean }>;

// ─── Converter ──────────────────────────────────────────────────────

export function convertHistoryMessages(dbMessages: readonly HistoryDbMessage[]): ThreadMessageLike[] {
  const toolResults = buildToolResultsMap(dbMessages);
  const messages: ThreadMessageLike[] = [];
  let pendingAssistantContent: ReturnType<typeof convertAssistantBlocks> | null = null;
  let pendingAssistantCreatedAt: string | undefined;

  const flushAssistant = () => {
    if (pendingAssistantContent && pendingAssistantContent.length > 0) {
      messages.push({
        role: 'assistant',
        content: pendingAssistantContent,
        ...(pendingAssistantCreatedAt ? { createdAt: new Date(pendingAssistantCreatedAt) } : {}),
      });
    }
    pendingAssistantContent = null;
    pendingAssistantCreatedAt = undefined;
  };

  for (const msg of dbMessages) {
    if (msg.type === 'user') {
      flushAssistant();
      messages.push(convertUserMessage(msg.content, msg.createdAt));
    } else if (msg.type === 'assistant') {
      const blocks = asAnthropicContentBlocks(msg.content);
      const converted = convertAssistantBlocks(blocks, toolResults);
      if (pendingAssistantContent) {
        pendingAssistantContent.push(...converted);
      } else {
        pendingAssistantContent = [...converted];
        pendingAssistantCreatedAt = msg.createdAt;
      }
    }
    // tool_result rows are folded into their tool_use parents via the
    // toolResults map; no top-level message emitted for them.
  }
  flushAssistant();
  return messages;
}

function buildToolResultsMap(dbMessages: readonly HistoryDbMessage[]): ToolResultsMap {
  const map: ToolResultsMap = new Map();
  for (const msg of dbMessages) {
    if (msg.type === 'tool_result') {
      const blocks = asArray<AnthropicToolResultBlock>(msg.content);
      for (const block of blocks) {
        if (typeof block?.tool_use_id === 'string') {
          map.set(block.tool_use_id, { result: block.content, isError: block.is_error ?? false });
        }
      }
    }
  }
  return map;
}

function convertUserMessage(content: unknown, createdAt?: string): ThreadMessageLike {
  const parsed = (typeof content === 'object' && content !== null
    ? (content as { text?: string; attachments?: StoredAttachment[] })
    : { text: typeof content === 'string' ? content : '' });
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const storedAttachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];

  const attachments = storedAttachments.map((att, i) => ({
    id: `att-${i}`,
    type: att.type,
    name: att.name ?? att.title ?? (att.type === 'image' ? 'image' : 'file'),
    contentType: att.mediaType,
    status: { type: 'complete' as const },
    content: [] as any[],
  }));

  return {
    role: 'user',
    content: text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
  };
}

function convertAssistantBlocks(
  blocks: readonly AnthropicContentBlock[],
  toolResults: ToolResultsMap,
) {
  return blocks
    .filter((block): block is AnthropicContentBlock =>
      block?.type === 'text' || block?.type === 'tool_use',
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
        args: (block.input ?? {}) as ReadonlyJSONObject,
        result: result?.result,
        isError: result?.isError ?? false,
      };
    });
}

// ─── Shape helpers ──────────────────────────────────────────────────

function asAnthropicContentBlocks(content: unknown): AnthropicContentBlock[] {
  return asArray<AnthropicContentBlock>(content);
}

function asArray<T>(content: unknown): T[] {
  return Array.isArray(content) ? (content as T[]) : [];
}

// ─── Per-adapter helper: parse JSON content and forward ─────────────

/**
 * Helper for adapters whose transport returns content as a JSON string
 * (e.g. the desktop IPC adapter, where SQLite rows come through with
 * `content` still serialized). Parses each row's content, hands the
 * normalized rows to `convertHistoryMessages`. Adapters whose transport
 * already parses (e.g. HTTP `JSON.parse(body)`) skip this and call
 * `convertHistoryMessages` directly.
 */
export function convertHistoryMessagesFromStringContent(
  dbMessages: readonly { type: string; content: string; created_at?: string }[],
): ThreadMessageLike[] {
  const normalized: HistoryDbMessage[] = dbMessages.map((m) => ({
    type: m.type,
    content: safeJsonParse(m.content),
    createdAt: m.created_at,
  }));
  return convertHistoryMessages(normalized);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
