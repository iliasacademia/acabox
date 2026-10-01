import { useSyncExternalStore } from 'react';

/**
 * First user/assistant line of every chat, from `main/db/chatSearch.ts` via
 * `sessions:previews` — see docs/design/chat-search.md. Replaces the old
 * per-row loader in thread-list.tsx, which called
 * `sessionsAPI.listMessages(sessionId)` (a chat's ENTIRE history) once per
 * row just to keep ~120 characters of it.
 *
 * Modelled on `chatActivityStore.ts`: one module-level snapshot, fetched once
 * and re-read on `sessions:changed` (a deleted chat's preview must go, and a
 * brand-new chat's first lines must appear — that broadcast fires when its
 * title is generated, which is also when the chat itself joins the list).
 *
 * Imports nothing from `@assistant-ui/react`, so it and everything built on it
 * render under jest.
 */

let snapshot: ReadonlyMap<string, ChatPreviewData> = new Map();
const subscribers = new Set<() => void>();
let started = false;

function apply(rows: ChatPreviewData[] | null | undefined): void {
  const next = new Map<string, ChatPreviewData>();
  if (Array.isArray(rows)) {
    for (const row of rows) next.set(row.sessionId, row);
  }
  snapshot = next;
  for (const fn of [...subscribers]) fn();
}

function refresh(): void {
  try {
    window.sessionsAPI?.previews?.().then(apply).catch(() => { /* keep the previous snapshot */ });
  } catch { /* bridge absent (tests, early boot) */ }
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  try {
    window.sessionsAPI?.onSessionsChanged?.(refresh);
  } catch { /* bridge absent */ }
  refresh();
}

function subscribe(fn: () => void): () => void {
  ensureStarted();
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/**
 * One chat's preview. Selects a single entry out of the shared snapshot, so a
 * row re-renders only when ITS preview changes — not on every fetch anywhere
 * in the list. Null for an id with no preview yet (a brand-new chat) or none
 * at all (`sessionId` undefined).
 */
export function useChatPreview(sessionId: string | undefined): ChatPreviewData | null {
  const select = () => (sessionId ? snapshot.get(sessionId) ?? null : null);
  return useSyncExternalStore(subscribe, select, select);
}

/** Exactly the old thread-list format: `You: ... · ▸ ...`. */
export function formatPreviewLine(preview: ChatPreviewData | null): string {
  if (!preview) return '';
  return [
    preview.userText ? `You: ${preview.userText}` : '',
    preview.assistantText ? `▸ ${preview.assistantText}` : '',
  ].filter(Boolean).join(' · ');
}

/** Test-only reset of module state. */
export function __resetChatPreviewStoreForTests(): void {
  snapshot = new Map();
  subscribers.clear();
  started = false;
}
