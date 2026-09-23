import { useSyncExternalStore } from 'react';

/**
 * Renderer mirror of `main/chatActivity.ts`: which chats are working right
 * now, and which have news nobody has seen. Every chat list reads it — the
 * Chats page, Home, the rail's recents, a tool's chat switcher — so one chat
 * cannot read "working" in one place and idle in another.
 *
 * Pushed, never polled: main sends a full snapshot on every change, and this
 * also re-reads on `sessions:changed` so a deleted chat stops counting even if
 * no turn state moved.
 *
 * Imports nothing from `@assistant-ui/react`, so it and everything built on it
 * render under jest.
 */

interface RawSnapshot {
  activeIds: string[];
  unreadIds: string[];
}

export interface ChatActivity {
  active: ReadonlySet<string>;
  unread: ReadonlySet<string>;
}

/** What a chat row draws. Working outranks unread: news is only news once the turn has ended. */
export type ChatMark = 'active' | 'unread' | null;

const EMPTY: ChatActivity = { active: new Set(), unread: new Set() };

let snapshot: ChatActivity = EMPTY;
/** False until main has answered once — before that, a count of 0 would be a guess. */
let loaded = false;
const subscribers = new Set<() => void>();
let started = false;

function apply(raw: RawSnapshot | null | undefined): void {
  if (!raw) return;
  snapshot = {
    active: new Set(Array.isArray(raw.activeIds) ? raw.activeIds : []),
    unread: new Set(Array.isArray(raw.unreadIds) ? raw.unreadIds : []),
  };
  loaded = true;
  for (const fn of [...subscribers]) fn();
}

function refresh(): void {
  try {
    window.sessionsAPI?.getActivity?.().then(apply).catch(() => { /* next push corrects it */ });
  } catch { /* bridge absent (tests, early boot) */ }
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  try {
    window.sessionsAPI?.onActivityChanged?.(apply);
    window.sessionsAPI?.onSessionsChanged?.(refresh);
  } catch { /* bridge absent */ }
  refresh();
}

function subscribe(fn: () => void): () => void {
  ensureStarted();
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

const getSnapshot = () => snapshot;

/** Pure: the mark for one chat. */
export function chatMarkFor(activity: ChatActivity, sessionId: string | null | undefined): ChatMark {
  if (!sessionId) return null;
  if (activity.active.has(sessionId)) return 'active';
  if (activity.unread.has(sessionId)) return 'unread';
  return null;
}

/**
 * The mark for one chat. Selects a primitive, so a row re-renders only when
 * ITS mark changes — not on every turn anywhere in the app.
 */
export function useChatMark(sessionId: string | null | undefined): ChatMark {
  const select = () => chatMarkFor(snapshot, sessionId);
  return useSyncExternalStore(subscribe, select, select);
}

/** Whether any chat has unseen news — the sidebar's single dot. */
export function useHasUnreadChats(): boolean {
  const select = () => snapshot.unread.size > 0;
  return useSyncExternalStore(subscribe, select, select);
}

/**
 * How many chats have a turn in flight — the status bar's AGENTS count. Null
 * until main has answered, so the bar shows nothing rather than a made-up 0.
 */
export function useActiveChatCount(): number | null {
  const select = () => (loaded ? snapshot.active.size : null);
  return useSyncExternalStore(subscribe, select, select);
}

// ── Which conversation is on screen ─────────────────────────────────────────
//
// A chat can be shown by more than one surface (the Chats page, a tool's side
// panel), and every surface stays mounted behind `display:none`. Each reports
// under its own key and only while it is genuinely visible; main hears the
// one visible conversation, or null. Keyed rather than last-writer-wins
// because switching surfaces fires one's "hidden" and the other's "shown" in
// an order React does not promise — last-writer-wins would sometimes land on
// null with a chat plainly on screen, and that chat would then go unread.

const reporters = new Map<string, string>();
let lastSent: string | null | undefined;

function currentViewing(): string | null {
  for (const id of reporters.values()) return id;
  return null;
}

/** Report what surface `key` shows: a session id while visible, null otherwise. */
export function reportViewingChat(key: string, sessionId: string | null): void {
  if (sessionId) reporters.set(key, sessionId);
  else reporters.delete(key);
  const next = currentViewing();
  if (next === lastSent) return;
  lastSent = next;
  try {
    window.sessionsAPI?.setViewing?.(next);
  } catch { /* bridge absent */ }
}

/** Test-only reset of module state. */
export function __resetChatActivityStoreForTests(): void {
  snapshot = EMPTY;
  loaded = false;
  subscribers.clear();
  started = false;
  reporters.clear();
  lastSent = undefined;
}
