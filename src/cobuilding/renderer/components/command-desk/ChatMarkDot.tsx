import React from 'react';
import { useChatMark } from '../../chatActivityStore';

/**
 * The one mark a chat row carries: a pulsing amber dot while a reply is
 * streaming (the same dot the GENERATING chip uses), a solid blue dot when a
 * reply landed that nobody has seen, nothing otherwise. Every chat list renders
 * this, so the vocabulary cannot drift between them.
 *
 * Renders nothing at all for a quiet chat, rather than a placeholder, so a row
 * with a dot always means something happened.
 */
export function ChatMarkDot({ sessionId, className }: { sessionId: string | null | undefined; className?: string }) {
  const mark = useChatMark(sessionId);
  if (!mark) return null;
  const extra = className ? ` ${className}` : '';
  return mark === 'active' ? (
    <span
      className={`cdDot cdDot--busy cdDot--pulse cdChatMark cdChatMark--active${extra}`}
      role="img"
      aria-label="Working"
      title="Working — a reply is streaming"
    />
  ) : (
    <span
      className={`cdDot cdDot--unread cdChatMark cdChatMark--unread${extra}`}
      role="img"
      aria-label="Unread"
      title="A reply you haven't seen yet"
    />
  );
}
