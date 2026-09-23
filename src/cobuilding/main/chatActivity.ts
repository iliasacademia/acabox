import log from 'electron-log';
import { clearSessionUnread, listUnreadSessionIds, markSessionUnread } from './db/chatRepository';

/**
 * Which chats are working right now, and which have news their owner has not
 * seen — the two marks every chat list draws.
 *
 * Two states, deliberately never merged:
 *
 *  - ACTIVE: a turn is in flight. Live only; a fresh process starts with none,
 *    which is true, because no turn survives the app.
 *  - UNREAD: a turn ENDED while nobody was looking at that chat. Persisted in
 *    `sessions.unread`, so a reply that landed overnight is still flagged
 *    after a restart.
 *
 * "Looking" is the chat on screen AND the Acabox window focused. The renderer
 * reports the first (it alone knows which surface is visible); main observes
 * the second from its own BrowserWindow events. Deliberately NOT inferred from
 * `sessionRegistry` subscribers: every tab stays mounted behind
 * `display:none`, so "subscribed" is not "on screen" — the same trap that
 * froze the API-proxy banner.
 *
 * Fed from the one place a turn's state actually changes —
 * `agentSession.ts`'s turn-in-progress writes, plus its error and destroy
 * paths — so no caller can start or end a turn without this knowing. That is
 * "announce at the write", the rule `onScheduledTasksChanged` follows.
 *
 * Electron-free so it can be unit-tested; `main/index.ts` subscribes and
 * broadcasts to windows.
 */

export interface ChatActivitySnapshot {
  activeIds: string[];
  unreadIds: string[];
}

const active = new Set<string>();
let viewingId: string | null = null;
let windowFocused = false;
const listeners = new Set<(snapshot: ChatActivitySnapshot) => void>();

function isLooking(sessionId: string): boolean {
  return windowFocused && viewingId === sessionId;
}

/**
 * Unread bookkeeping must never break a turn: a DB hiccup here would
 * otherwise surface as a turn that cannot start or end. The mark is lost; the
 * conversation is not.
 */
function guarded<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    log.warn(`[ChatActivity] ${what} failed: ${(err as Error).message}`);
    return fallback;
  }
}

export function getChatActivity(): ChatActivitySnapshot {
  return {
    activeIds: [...active],
    unreadIds: guarded('listing unread chats', listUnreadSessionIds, []),
  };
}

function emit(): void {
  if (listeners.size === 0) return;
  const snapshot = getChatActivity();
  for (const fn of [...listeners]) {
    try {
      fn(snapshot);
    } catch (err) {
      log.error('[ChatActivity] listener threw:', err);
    }
  }
}

/** Subscribe to every change. Returns an unsubscribe function. */
export function onChatActivityChanged(fn: (snapshot: ChatActivitySnapshot) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function noteTurnStarted(sessionId: string): void {
  if (active.has(sessionId)) return;
  active.add(sessionId);
  emit();
}

/**
 * Idempotent, and a no-op for a chat that was not active — the error and
 * destroy paths call this unconditionally, and a session destroyed between
 * turns must not flag anything.
 */
export function noteTurnEnded(sessionId: string): void {
  if (!active.delete(sessionId)) return;
  if (!isLooking(sessionId)) {
    guarded('marking a chat unread', () => markSessionUnread(sessionId), false);
  }
  emit();
}

function clearIfLooking(): void {
  if (!viewingId || !windowFocused) return;
  const id = viewingId;
  if (guarded('clearing a chat’s unread mark', () => clearSessionUnread(id), false)) emit();
}

/** The chat currently on screen, or null when no conversation is visible. */
export function setViewingChat(sessionId: string | null): void {
  viewingId = sessionId;
  clearIfLooking();
}

/** Whether the main window has focus. A chat on screen behind another app is not being read. */
export function setChatWindowFocused(focused: boolean): void {
  windowFocused = focused;
  clearIfLooking();
}

/** Test-only: forget all in-memory state. The persisted flags are the database's business. */
export function __resetChatActivityForTests(): void {
  active.clear();
  viewingId = null;
  windowFocused = false;
  listeners.clear();
}
