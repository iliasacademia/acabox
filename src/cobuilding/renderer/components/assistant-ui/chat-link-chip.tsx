import React, { useEffect, useState } from 'react';
import { MSymbol } from '../command-desk/MSymbol';
import { buildChatLink, splitTextByChatLinks } from '../../../shared/chatLinks';
import type { FC } from 'react';

/**
 * Renders `acabox://chat/<id>` links as chips instead of raw URLs, wherever
 * one can appear: the user's own bubble (a link the user pasted in, wired in
 * `thread.tsx`) and the agent's replies (`doi-link.tsx`, since chat links are
 * just another kind of anchor href there). See `shared/chatLinks.ts` for why
 * nothing is stored beside the message — the link in the text IS the
 * reference, so this component looks the chat up live rather than trusting
 * anything frozen at send time.
 *
 * Deliberately imports only `react`, `MSymbol`, and `shared/chatLinks` — no
 * `@assistant-ui/react` — so it (and `TextWithChatLinks`) can be rendered and
 * tested under plain jest, the way `MiniAppViewer`-adjacent components
 * cannot.
 */

/** Dispatched by a chip's click; `index.tsx` subscribes and switches threads. */
export const OPEN_CHAT_EVENT = 'cd:open-chat';

export function requestOpenChat(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(OPEN_CHAT_EVENT, { detail: { sessionId } }));
}

type ChatLookupResult = SessionData | null;

/**
 * Module-level so ten chips referencing the same chat (the same id can appear
 * more than once in a message, or across several messages) make exactly one
 * `sessions:get` call. Reset between tests via `__resetChatLinkCacheForTests`.
 */
let lookupCache = new Map<string, Promise<ChatLookupResult>>();

export function __resetChatLinkCacheForTests(): void {
  lookupCache = new Map();
}

function lookupChat(sessionId: string): Promise<ChatLookupResult> {
  let pending = lookupCache.get(sessionId);
  if (!pending) {
    pending = (async () => {
      try {
        const session = await window.sessionsAPI?.get(sessionId);
        return session ?? null;
      } catch {
        // No preload bridge (a test environment) or a rejected IPC call both
        // read as "can't confirm this chat exists" — same as a deleted one.
        return null;
      }
    })();
    lookupCache.set(sessionId, pending);
  }
  return pending;
}

/** A chat link rendered as a small pill: icon + title, clickable, opens the chat. */
export const ChatLinkChip: FC<{ sessionId: string }> = ({ sessionId }) => {
  const [result, setResult] = useState<'loading' | ChatLookupResult>('loading');

  useEffect(() => {
    let cancelled = false;
    setResult('loading');
    lookupChat(sessionId).then((session) => {
      if (!cancelled) setResult(session);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  let label: string;
  if (result === 'loading') {
    label = 'Chat…';
  } else if (!result) {
    label = 'Deleted chat';
  } else {
    label = result.title?.trim() || 'Untitled chat';
  }
  const missing = result !== 'loading' && !result;

  return (
    <button
      type="button"
      className={`cdChatLinkChip${missing ? ' cdChatLinkChip--missing' : ''}`}
      title={buildChatLink(sessionId)}
      onClick={() => requestOpenChat(sessionId)}
    >
      <MSymbol name="forum" size={13} />
      <span className="cdChatLinkChip__label">{label}</span>
    </button>
  );
};

/** Splits `text` into plain runs and `ChatLinkChip`s in place, in order. */
export const TextWithChatLinks: FC<{ text: string }> = ({ text }) => (
  <>
    {splitTextByChatLinks(text).map((part, i) =>
      part.type === 'chat' ? (
        <ChatLinkChip key={`chat-${i}-${part.sessionId}`} sessionId={part.sessionId} />
      ) : (
        <React.Fragment key={`text-${i}`}>{part.text}</React.Fragment>
      ))}
  </>
);
