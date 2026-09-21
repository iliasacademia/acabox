/**
 * Chat links: `acabox://chat/<session-id>`.
 *
 * The one way to point at another conversation from inside a conversation.
 * The user copies a link from a chat's header and pastes it into a message;
 * the bubble renders it as a chip that opens that chat, and the agent is told
 * which chats were referenced so it can load them with the `chats` MCP tools
 * (`list_chats` / `read_chat`, host-side in `main/chatReference.ts`).
 *
 * WHY THE LINK STAYS IN THE TEXT
 * ------------------------------
 * Nothing about a reference is stored beside the message. The link IS the
 * reference: it sits in the text the user typed, so the optimistic bubble, the
 * bubble rehydrated from SQLite after a restart, and the agent's own view of
 * the message all derive from one string with no second copy that can drift.
 * Titles and counts are looked up live (renderer: `sessionsAPI.get`; main: the
 * repository) rather than frozen at send time, so a renamed chat shows its
 * current name.
 *
 * WHY THE AGENT GETS A REFERENCE BLOCK AND NOT THE TRANSCRIPT
 * ----------------------------------------------------------
 * A real chat here is routinely a megabyte of rows (1,000+ messages). Inlining
 * one into a turn would recreate the 5.5 MB-transcript failure this app has
 * already had once — every later turn replays it and is rejected forever. So
 * the turn carries a short block naming each chat and the agent PULLS what it
 * needs through `read_chat`, which is paginated and capped. Same reasoning as
 * `MAX_QUOTE_CHARS` in `quotes.ts`.
 *
 * This module is pure and shared by main, the renderer, and the agent-server
 * tool descriptions. Keep it free of Electron and DOM imports.
 */

export const CHAT_LINK_PREFIX = 'acabox://chat/';

const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_ONLY_RE = new RegExp(`^${UUID_SOURCE}$`);

/** Fresh instance per call: a shared `g` regex carries `lastIndex` between callers. */
function chatLinkRegex(): RegExp {
  return new RegExp(`acabox://chat/(${UUID_SOURCE})`, 'g');
}

/**
 * Ceiling on distinct chats one message may reference. Each one costs a
 * repository lookup at send time and a line in the agent's reference block;
 * past this the extra links stay in the text but are not resolved or named.
 */
export const MAX_CHAT_REFS_PER_MESSAGE = 8;

export function buildChatLink(sessionId: string): string {
  return `${CHAT_LINK_PREFIX}${sessionId}`;
}

/** True for exactly one well-formed chat link (used for `href` routing). */
export function isChatLink(href: string): boolean {
  return extractChatId(href) !== null && href.trim().toLowerCase().startsWith(CHAT_LINK_PREFIX);
}

/**
 * The session id named by a chat link OR a bare uuid, or null. Accepts the
 * forms an agent or a user plausibly types: the full link, the link wrapped in
 * `<…>` or trailing punctuation, or just the id. Always lower-cased so ids
 * compare equal regardless of how they were typed.
 */
export function extractChatId(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^<|>$/g, '');
  if (UUID_ONLY_RE.test(trimmed)) return trimmed.toLowerCase();
  const m = chatLinkRegex().exec(trimmed);
  return m ? m[1].toLowerCase() : null;
}

/** Every distinct chat id linked in `text`, first occurrence first. */
export function parseChatLinks(text: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const re = chatLinkRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export type TextOrChatLink =
  | { type: 'text'; text: string }
  | { type: 'chat'; sessionId: string; raw: string };

/**
 * Split a message's text into plain runs and chat links, in order, so a
 * renderer can draw each link as a chip in place. Adjacent text runs are
 * merged; an input with no links comes back as a single text run (or an
 * empty array for empty input).
 */
export function splitTextByChatLinks(text: string): TextOrChatLink[] {
  if (typeof text !== 'string' || !text) return [];
  const parts: TextOrChatLink[] = [];
  const re = chatLinkRegex();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
    parts.push({ type: 'chat', sessionId: m[1].toLowerCase(), raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}

/** What main resolves each linked id into, at send time, from the repository. */
export interface ChatRef {
  sessionId: string;
  /** False when no chat with this id exists in the active workspace. */
  exists: boolean;
  title: string | null;
  /** Mini-app the chat belongs to, or null for a general chat. */
  appDirName: string | null;
  messageCount: number;
  /** SQLite `strftime('%Y-%m-%dT%H:%M:%f')` text (UTC), or null for an empty chat. */
  lastMessageAt: string | null;
}

/** `2026-09-18T07:40:38.067` → `2026-09-18 07:40 UTC`; anything else passes through. */
export function formatStoredAt(stored: string | null): string {
  if (!stored) return 'never';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(stored);
  return m ? `${m[1]} ${m[2]} UTC` : stored;
}

/** One line per reference, as the agent reads it. Exported for the chip's tooltip too. */
export function describeChatRef(ref: ChatRef): string {
  const link = buildChatLink(ref.sessionId);
  if (!ref.exists) {
    return `- ${link} — no chat with this id exists in this workspace; say so rather than guessing its contents.`;
  }
  const title = ref.title?.trim() ? `"${ref.title.trim()}"` : '(untitled chat)';
  const bits = [
    `${ref.messageCount} message${ref.messageCount === 1 ? '' : 's'}`,
    ref.appDirName ? `tool ${ref.appDirName}` : null,
    `last active ${formatStoredAt(ref.lastMessageAt)}`,
  ].filter(Boolean);
  return `- ${link} — ${title} — ${bits.join(' · ')}`;
}

/**
 * Append the reference block to the text the agent receives. A no-op with no
 * references, so the ordinary path is byte-identical to before. Runs AFTER
 * `composeQuotedText` in main — quote, typed text, then references — and is
 * the only place this block is built, so what is sent cannot drift from what
 * the tool descriptions promise.
 */
export function composeChatRefsText(text: string, refs: ChatRef[]): string {
  if (!refs || refs.length === 0) return text;
  const header =
    'Referenced chats — load each with the read_chat tool before answering '
    + '(start with detail "conversation"; page with from_message_id if the result says it was truncated):';
  const block = [header, ...refs.map(describeChatRef)].join('\n');
  const body = text.trimEnd();
  return body ? `${body}\n\n${block}` : block;
}
