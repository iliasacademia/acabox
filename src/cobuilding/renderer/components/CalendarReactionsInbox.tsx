import React, { useState, useEffect, useCallback } from 'react';
import type { CalendarReaction, CalendarEvent, CalendarPlan } from '../../shared/types';
import './CalendarReactionsInbox.css';

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const d = new Date(iso);
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

interface Props {
  allEvents: CalendarEvent[];
  plans: CalendarPlan[];
}

export function CalendarReactionsInbox({ allEvents, plans }: Props) {
  const [reactions, setReactions] = useState<CalendarReaction[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [openReactionId, setOpenReactionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, countResult] = await Promise.all([
      window.calendarAPI.listReactions({ includeRead: true }),
      window.calendarAPI.getReactionCount(),
    ]);
    setReactions(list);
    setUnreadCount(countResult.unread);
  }, []);

  useEffect(() => {
    load();
    const unsub = window.calendarAPI.onReactionsUpdated(load);
    return unsub;
  }, [load]);

  const handleDismiss = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await window.calendarAPI.updateReactionStatus(id, 'dismissed');
    setReactions(prev => prev.filter(r => r.id !== id));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  const handleOpen = async (reaction: CalendarReaction) => {
    if (reaction.status === 'unread') {
      await window.calendarAPI.updateReactionStatus(reaction.id, 'read');
      setReactions(prev => prev.map(r => r.id === reaction.id ? { ...r, status: 'read' } : r));
      setUnreadCount(prev => Math.max(0, prev - 1));
    }
    setOpenReactionId(prev => prev === reaction.id ? null : reaction.id);
  };

  const getEntityLabel = (r: CalendarReaction): string | null => {
    if (r.event_id) return allEvents.find(e => e.id === r.event_id)?.name ?? null;
    if (r.plan_id) return plans.find(p => p.id === r.plan_id)?.name ?? null;
    return null;
  };

  return (
    <div className="reactionsInbox">
      <div className="reactionsInboxHeader">
        <span className="reactionsInboxTitle">Insights</span>
        {unreadCount > 0 && (
          <span className="reactionsInboxBadge">{unreadCount}</span>
        )}
      </div>

      <div className="reactionsInboxList">
        {reactions.length === 0 ? (
          <div className="reactionsInboxEmpty">
            Insights will appear here after you edit events.
          </div>
        ) : (
          reactions.map(r => {
            const entityLabel = getEntityLabel(r);
            return (
              <div
                key={r.id}
                className={`reactionsInboxRow${r.status === 'unread' ? ' unread' : ''}`}
              >
                <button
                  className="reactionsInboxRowMain"
                  onClick={() => handleOpen(r)}
                >
                  {r.status === 'unread' && <span className="reactionsInboxDot" />}
                  <span className="reactionsInboxRowTitle">{r.title}</span>
                  {entityLabel && (
                    <span className="reactionsInboxRowEntity">{entityLabel}</span>
                  )}
                  <span className="reactionsInboxRowDate">{formatRelativeDate(r.created_at)}</span>
                </button>
                <button
                  className="reactionsInboxDismiss"
                  onClick={e => handleDismiss(r.id, e)}
                  title="Dismiss"
                >
                  ×
                </button>
                {openReactionId === r.id && (
                  <div className="reactionsInboxContent">
                    <pre className="reactionsInboxMarkdown">{r.content}</pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
