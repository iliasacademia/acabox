/**
 * Read-only access to OTHER chats, for the agent's `chats` MCP relay
 * (`list_chats` / `read_chat` — tool schemas in `agent-server/index.ts`,
 * host handlers in `controllers/AgentInfrastructureController.ts`).
 *
 * WHY PULLED AND PAGINATED, NOT INLINED
 * --------------------------------------
 * A real chat here is routinely 1,000+ rows and a megabyte — this app already
 * bricked a thread once by inlining a 5.5 MB CSV into a turn (every later turn
 * replayed it and was rejected forever). So `readChatForAgent` never dumps a
 * full transcript: `renderChatTranscript` produces a compact rendering under a
 * hard character budget and reports a `from_message_id` cursor to continue
 * from, same shape as `MAX_QUOTE_CHARS` in `quotes.ts` and the reasoning in
 * `shared/chatLinks.ts`.
 *
 * Pure rendering (`renderChatTranscript`) is separated from the two thin
 * entry points (`readChatForAgent` / `listChatsForAgent`) so the rendering
 * logic can be tested with hand-built `Session`/`Message` objects, no
 * database required.
 */

import type { Session, Message } from './db/chatRepository';
import { getSession, getMessages, listSessionsWithActivity } from './db/chatRepository';
import { extractChatId, buildChatLink, describeChatRef, formatStoredAt, type ChatRef } from '../shared/chatLinks';

export const DEFAULT_MAX_CHARS = 30_000;
export const MIN_MAX_CHARS = 2_000;
export const MAX_MAX_CHARS = 120_000;

export interface RenderChatTranscriptOptions {
  detail: 'conversation' | 'full';
  fromMessageId?: number;
  maxChars?: number;
  includeToolResults?: boolean;
}

export interface RenderChatTranscriptResult {
  text: string;
  truncated: boolean;
  nextFromMessageId: number | null;
  renderedRows: number;
}

// ---------------------------------------------------------------------------
// Small parsing / formatting helpers
// ---------------------------------------------------------------------------

/** `2026-09-18T07:40:38.067` → `07:40`. Falls back rather than throwing on a malformed stamp. */
function hhmm(createdAt: string): string {
  const m = /T(\d{2}:\d{2})/.exec(createdAt ?? '');
  return m ? m[1] : '??:??';
}

/** First 200 chars of a Bash command, i.e. everything before the first newline. */
function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

/** Appends an ellipsis only when something was actually cut. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function clampMaxChars(value: number | undefined): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MAX_CHARS;
  return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Math.floor(v)));
}

/** Never throws: a row whose content isn't valid JSON renders as best-effort text rather than crashing the whole read. */
function safeParse<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

interface StoredUserContent {
  text?: string;
  attachments?: Array<{ name?: string }>;
  quote?: { text?: string };
}

interface StoredAssistantBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StoredToolResultEnvelope {
  tool_use_id?: string;
  type?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

interface StoredResultContent {
  subtype?: string;
  result?: string;
  is_error?: boolean;
}

function renderUserLine(row: Message): string {
  const parsed = safeParse<StoredUserContent>(row.content, { text: row.content });
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  let line = `[user ${hhmm(row.created_at)}] ${text}`;
  const quoteText = parsed.quote && typeof parsed.quote.text === 'string' ? parsed.quote.text : null;
  if (quoteText) {
    line += ` (quoted: ${cut(quoteText, 200)})`;
  }
  if (Array.isArray(parsed.attachments) && parsed.attachments.length) {
    const names = parsed.attachments.map((a) => a?.name).filter((n): n is string => Boolean(n));
    if (names.length) line += ` (attachments: ${names.join(', ')})`;
  }
  return line;
}

function summarizeToolUse(block: StoredAssistantBlock): string {
  const input = block.input ?? {};
  let summary: string;
  if (block.name === 'Bash') {
    summary = typeof input.command === 'string' ? firstLine(input.command) : '';
  } else if (block.name === 'Read' || block.name === 'Write' || block.name === 'Edit' || block.name === 'Glob' || block.name === 'Grep') {
    const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
    const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
    summary = filePath ?? pattern ?? '';
  } else {
    summary = JSON.stringify(input);
  }
  return cut(summary, 200);
}

function extractToolResultText(envelope: StoredToolResultEnvelope): string {
  if (typeof envelope.content === 'string') return envelope.content;
  if (Array.isArray(envelope.content)) {
    return envelope.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function buildHeader(session: Session, totalMessageCount: number): string {
  const titleLine = session.title?.trim() ? `Chat "${session.title.trim()}"` : '(untitled chat)';
  const lines = [titleLine, `Link: ${buildChatLink(session.id)}`];
  if (session.app_dir_name) lines.push(`Tool: ${session.app_dir_name}`);
  if (session.model) lines.push(`Model: ${session.model}`);
  lines.push(`Created: ${formatStoredAt(session.created_at)}`);
  lines.push(`Messages: ${totalMessageCount} rows total`);
  lines.push('Times below are UTC.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Row → line contributions
// ---------------------------------------------------------------------------

/** One or more rendered lines, attributed to the row id that produced them — the unit the budget/truncation pass works in. */
interface Contribution {
  id: number;
  lines: string[];
}

/**
 * Walks the (already id-ordered, already from-cursor-filtered) rows once and
 * produces the ordered list of lines to render, each tagged with the row id
 * that owns it.
 *
 * The one piece of state that crosses row boundaries is the "pending"
 * assistant text buffer used in `conversation` mode: a turn's intermediate
 * assistant text is held rather than emitted immediately, because the
 * TURN-ENDING `result` row is what conversation mode actually wants to show.
 * If a `result` row never arrives — the turn was interrupted or is still
 * running — the buffer is flushed (as the turn's last word) either when the
 * next `user` row arrives or when the rows run out. This is what keeps an
 * interrupted turn from vanishing entirely.
 */
function buildContributions(
  rows: Message[],
  detail: 'conversation' | 'full',
  includeToolResults: boolean,
): Contribution[] {
  const contributions: Contribution[] = [];
  let pending: { id: number; createdAt: string; text: string } | null = null;
  // full mode only: the text of the last `[assistant …]` line emitted, so a
  // `result` row whose text merely restates it can be dropped rather than
  // shown twice.
  let lastAssistantLineText: string | null = null;

  const flushPending = () => {
    if (!pending) return;
    contributions.push({ id: pending.id, lines: [`[assistant ${hhmm(pending.createdAt)}] ${pending.text}`] });
    pending = null;
  };

  for (const row of rows) {
    if (row.type === 'user') {
      if (detail === 'conversation') flushPending();
      contributions.push({ id: row.id, lines: [renderUserLine(row)] });
      continue;
    }

    if (row.type === 'assistant') {
      const blocks = safeParse<StoredAssistantBlock[]>(row.content, []);
      const lines: string[] = [];
      for (const block of blocks) {
        if (block.type === 'thinking') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          if (detail === 'full') {
            lines.push(`[assistant ${hhmm(row.created_at)}] ${block.text}`);
            lastAssistantLineText = block.text;
          } else {
            // Buffer rather than emit — see the function comment.
            pending = { id: row.id, createdAt: row.created_at, text: block.text };
          }
        } else if (block.type === 'tool_use' && detail === 'full') {
          lines.push(`[tool ${block.name ?? 'unknown'}] ${summarizeToolUse(block)}`);
        }
      }
      if (lines.length) contributions.push({ id: row.id, lines });
      continue;
    }

    if (row.type === 'tool_result') {
      if (detail === 'full' && includeToolResults) {
        const envelopes = safeParse<StoredToolResultEnvelope[]>(row.content, []);
        const lines = envelopes
          .map((e) => extractToolResultText(e))
          .filter((t) => t.length > 0)
          .map((t) => `[result] ${cut(t, 500)}`);
        if (lines.length) contributions.push({ id: row.id, lines });
      }
      continue;
    }

    if (row.type === 'result') {
      const parsed = safeParse<StoredResultContent>(row.content, {});
      if (parsed.is_error) {
        contributions.push({ id: row.id, lines: [`[assistant ${hhmm(row.created_at)}] (turn failed: ${parsed.result || 'error'})`] });
      } else if (parsed.subtype === 'success') {
        const resultText = parsed.result ?? '';
        if (detail === 'full' && resultText === lastAssistantLineText) {
          // Dedupe: the final reply just restates the last text block already shown.
        } else {
          contributions.push({ id: row.id, lines: [`[assistant ${hhmm(row.created_at)}] ${resultText}`] });
          lastAssistantLineText = resultText;
        }
      }
      // A result row resolves the turn either way — discard, never flush, any
      // buffered intermediate text: the authoritative reply just arrived.
      pending = null;
      continue;
    }
  }

  if (detail === 'conversation') flushPending();

  return contributions;
}

// ---------------------------------------------------------------------------
// Public: renderChatTranscript
// ---------------------------------------------------------------------------

export function renderChatTranscript(
  session: Session,
  messages: Message[],
  opts: RenderChatTranscriptOptions,
): RenderChatTranscriptResult {
  const maxChars = clampMaxChars(opts.maxChars);
  const fromMessageId = opts.fromMessageId;
  const rows = messages
    .filter((m) => fromMessageId === undefined || m.id > fromMessageId)
    .slice()
    .sort((a, b) => a.id - b.id);

  const header = buildHeader(session, messages.length);
  const contributions = buildContributions(rows, opts.detail, !!opts.includeToolResults);

  const bodyLines: string[] = [];
  let total = header.length;
  let truncated = false;
  let lastIncludedId: number | null = fromMessageId ?? null;
  let renderedRows = 0;

  for (const contribution of contributions) {
    const joined = contribution.lines.join('\n');
    const addedLen = joined.length + 1; // + separator
    if (total + addedLen > maxChars) {
      truncated = true;
      break;
    }
    bodyLines.push(...contribution.lines);
    total += addedLen;
    lastIncludedId = contribution.id;
    renderedRows += 1;
  }

  const parts = [header];
  parts.push(bodyLines.join('\n'));

  let text = parts.join('\n\n');
  let nextFromMessageId: number | null = null;
  if (truncated) {
    nextFromMessageId = lastIncludedId;
    const footer = `… truncated at ${total} chars; call read_chat again with from_message_id=${nextFromMessageId} to continue.`;
    text += `\n\n${footer}`;
  }

  return { text, truncated, nextFromMessageId, renderedRows };
}

// ---------------------------------------------------------------------------
// Public: entry points called from the host MCP handlers
// ---------------------------------------------------------------------------

export type ChatToolResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * `read_chat`. `workspaceId` comes from the CALLING session's own workspace,
 * never from the arguments — the agent names a chat, not a workspace, and a
 * chat in a different workspace must read as nonexistent rather than leaking
 * its existence.
 */
export function readChatForAgent(workspaceId: string, args: unknown): ChatToolResult {
  const a = (args ?? {}) as Record<string, unknown>;
  const rawChat = a.chat;
  const chatId = extractChatId(rawChat as string);
  if (!chatId) {
    return {
      ok: false,
      error: `"${String(rawChat)}" is not a chat link or id. Links look like acabox://chat/<uuid>; use list_chats to find one.`,
    };
  }

  const session = getSession(chatId);
  if (!session || session.workspace_id !== workspaceId) {
    return { ok: false, error: `No chat ${buildChatLink(chatId)} exists in this workspace.` };
  }

  const messages = getMessages(chatId);
  const detail: 'conversation' | 'full' = a.detail === 'full' ? 'full' : 'conversation';
  const fromMessageId = Number.isInteger(a.from_message_id) ? (a.from_message_id as number) : undefined;
  const maxChars = typeof a.max_chars === 'number' ? a.max_chars : undefined;
  const includeToolResults = a.include_tool_results === true;

  const rendered = renderChatTranscript(session, messages, { detail, fromMessageId, maxChars, includeToolResults });
  return { ok: true, text: rendered.text };
}

/** `list_chats`. Same workspace-scoping rule as `readChatForAgent`. */
export function listChatsForAgent(workspaceId: string, args: unknown): { ok: true; text: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  const query = typeof a.query === 'string' ? a.query : undefined;
  const limit = typeof a.limit === 'number' ? a.limit : undefined;

  const rows = listSessionsWithActivity(workspaceId, { query, limit });

  if (rows.length === 0) {
    return { ok: true, text: query ? `No chats found matching "${query}".` : 'No chats found.' };
  }

  const header = query
    ? `${rows.length} chat(s), matching "${query}", most recent first:`
    : `${rows.length} chat(s), most recent first:`;

  const lines = rows.map((row) => {
    const ref: ChatRef = {
      sessionId: row.id,
      exists: true,
      title: row.title,
      appDirName: row.app_dir_name,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
    };
    return describeChatRef(ref);
  });

  return { ok: true, text: [header, ...lines].join('\n') };
}
