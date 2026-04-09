import React, { useState, useEffect, useCallback } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import { TrashIcon } from 'lucide-react';
import { dateFromSessionStoredAt } from '../sessionTimestamps';

export const ReactionsSidebar: React.FC = () => {
  const [reactions, setReactions] = useState<SessionData[]>([]);
  const runtime = useAssistantRuntime();

  const load = useCallback(() => {
    window.sessionsAPI.list('reactions').then(setReactions);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    await window.sessionsAPI.delete(id);
    load();
  }, [load]);

  const formatDate = (iso: string) => {
    const date = dateFromSessionStoredAt(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div className="threadListRoot">
      <div className="threadListItems">
        {reactions.map((r) => (
          <div key={r.id} className="threadListItem">
            <button
              className="threadListItemTrigger"
              onClick={() => runtime.threads.switchToThread(r.id)}
            >
              <span className="threadListItemTitle">
                <span className="threadListItemTitleText">{r.title}</span>
                <span className="threadListItemDate">{formatDate(r.created_at)}</span>
              </span>
            </button>
            <button
              className="threadListItemAction threadListItemDelete"
              onClick={() => handleDelete(r.id)}
            >
              <TrashIcon style={{ width: 14, height: 14 }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
