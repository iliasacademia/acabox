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
import { parseStoredQuote } from '../shared/quotes';
import { parseCostRow, turnCosts } from '../shared/turnCost';
import { dateFromSessionStoredAt } from './sessionTimestamps';

// ─── Wire shapes ────────────────────────────────────────────────────

/**
 * Normalized DB row passed into the converter. Each adapter is responsible
 * for parsing its raw transport (string content from IPC, already-parsed
 * content from HTTP) into this shape before calling in.
 */
export interface HistoryDbMessage {
  type: string;
  /**
   * For 'user': `{ text, attachments?, quote? }`.
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
  // How long the turn took, for the thread's "Worked for …" line: from the
  // user row that started it to the last row it produced (usually its
  // `result` row). Both are real timestamps; with either missing the duration
  // is left out rather than guessed.
  let turnStartAt: string | undefined;
  let turnEndAt: string | undefined;
  // Set when the turn ended on a `stopped` result (a user Stop, a teardown, or
  // a crash closed by `closeOrphanTurn`). Its unfinished tool calls then read
  // as stopped rather than running forever.
  let turnStopped = false;
  // Cost of the turn, from its result row. Unknown (null) renders nothing; a
  // stopped turn has one only when the CLI's own result carried a cost.
  const resultCosts = turnCosts(dbMessages.filter((m) => m.type === 'result').map((m) => parseCostRow(m.content)));
  let resultIndex = 0;
  let turnCost: number | null = null;

  const flushAssistant = () => {
    if (pendingAssistantContent && pendingAssistantContent.length > 0) {
      const workedMs = turnStartAt && turnEndAt
        ? Date.parse(turnEndAt) - Date.parse(turnStartAt)
        : NaN;
      messages.push({
        role: 'assistant',
        content: pendingAssistantContent,
        ...(pendingAssistantCreatedAt ? { createdAt: dateFromSessionStoredAt(pendingAssistantCreatedAt) } : {}),
        // `incomplete / cancelled` is the status assistant-ui hands to a
        // tool call that has no result; the tool card and `isFailed` already
        // read it as "stopped", not failed.
        ...(turnStopped ? { status: { type: 'incomplete' as const, reason: 'cancelled' as const } } : {}),
        ...(turnStopped || turnCost !== null || (Number.isFinite(workedMs) && workedMs > 0)
          ? {
            metadata: {
              custom: {
                ...(turnStopped ? { stopped: true } : {}),
                // No duration for a stopped turn: none is measured.
                ...(!turnStopped && Number.isFinite(workedMs) && workedMs > 0 ? { workedMs } : {}),
                ...(turnCost !== null ? { costUsd: turnCost } : {}),
              },
            },
          }
          : {}),
      });
    }
    pendingAssistantContent = null;
    pendingAssistantCreatedAt = undefined;
  };

  for (const msg of dbMessages) {
    if (msg.type === 'user') {
      flushAssistant();
      turnStartAt = msg.createdAt;
      turnEndAt = undefined;
      turnStopped = false;
      turnCost = null;
      messages.push(convertUserMessage(msg.content, msg.createdAt));
      continue;
    }
    if (msg.createdAt) turnEndAt = msg.createdAt;
    if (msg.type === 'assistant') {
      const blocks = asAnthropicContentBlocks(msg.content);
      const converted = convertAssistantBlocks(blocks, toolResults);
      if (pendingAssistantContent) {
        pendingAssistantContent.push(...converted);
      } else {
        pendingAssistantContent = [...converted];
        pendingAssistantCreatedAt = msg.createdAt;
      }
    }
    if (msg.type === 'result') {
      turnCost = resultCosts[resultIndex++] ?? null;
      if (isStoppedResult(msg.content)) turnStopped = true;
    }
    // tool_result rows are folded into their tool_use parents via the
    // toolResults map; no top-level message emitted for them.
  }
  flushAssistant();
  return messages;
}

/** A result row written by a stop: the host's own (`subtype: 'stopped'`) or the
 *  CLI's answer to an interrupt, which the host tags with `stopped_by`. */
function isStoppedResult(content: unknown): boolean {
  if (typeof content !== 'object' || content === null) return false;
  const c = content as { subtype?: unknown; stopped_by?: unknown };
  return c.subtype === 'stopped' || typeof c.stopped_by === 'string';
}

const INTERRUPT_REJECTION = "The user doesn't want to proceed with this tool use";

/** Acabox has no permission prompt, so this text only ever comes from a Stop. */
function isInterruptRejection(content: unknown): boolean {
  if (typeof content === 'string') return content.startsWith(INTERRUPT_REJECTION);
  if (Array.isArray(content)) {
    return content.some((b) => typeof b?.text === 'string' && b.text.startsWith(INTERRUPT_REJECTION));
  }
  return false;
}

function buildToolResultsMap(dbMessages: readonly HistoryDbMessage[]): ToolResultsMap {
  const map: ToolResultsMap = new Map();
  for (const msg of dbMessages) {
    if (msg.type === 'tool_result') {
      const blocks = asArray<AnthropicToolResultBlock>(msg.content);
      for (const block of blocks) {
        if (typeof block?.tool_use_id === 'string') {
          // The CLI answers an interrupted tool with this rejection. It is a
          // Stop, not a failure, so the call is left without a result and the
          // stopped turn renders it as cancelled (measured live 2026-10-01:
          // otherwise the fold read "Stopped · 1 step · 1 FAILED").
          if (block.is_error && isInterruptRejection(block.content)) continue;
          map.set(block.tool_use_id, { result: block.content, isError: block.is_error ?? false });
        }
      }
    }
  }
  return map;
}

function convertUserMessage(content: unknown, createdAt?: string): ThreadMessageLike {
  const parsed = (typeof content === 'object' && content !== null
    ? (content as { text?: string; attachments?: StoredAttachment[]; quote?: unknown })
    : { text: typeof content === 'string' ? content : '' });
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const storedAttachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  // Restored to the exact key the live composer writes
  // (`metadata.custom.quote`), so a rehydrated message renders through the same
  // component as one that was just sent. Rows written before quoting existed
  // simply have no `quote` field and parse to undefined.
  const quote = parseStoredQuote(parsed.quote);

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
    ...(quote ? { metadata: { custom: { quote } } } : {}),
    ...(createdAt ? { createdAt: dateFromSessionStoredAt(createdAt) } : {}),
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
