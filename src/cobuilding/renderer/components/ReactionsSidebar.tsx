import React, { useState, useEffect, useCallback } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import { TrashIcon, ChevronRightIcon, PenLineIcon } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { dateFromSessionStoredAt } from '../sessionTimestamps';

interface ReactionsSidebarProps {
  onOpenFocus: () => void;
}

export const ReactionsSidebar: React.FC<ReactionsSidebarProps> = ({ onOpenFocus }) => {
  const [userReactions, setUserReactions] = useState<SessionData[]>([]);
  const [systemReactions, setSystemReactions] = useState<SessionData[]>([]);
  const runtime = useAssistantRuntime();

  const load = useCallback(() => {
    window.sessionsAPI.list('reactions').then(setUserReactions);
    window.sessionsAPI.list('reactions-system').then(setSystemReactions);
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

  const renderThreadList = (items: SessionData[]) => (
    <div className="threadListItems">
      {items.map((r) => (
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
  );

  return (
    <div className="threadListRoot">
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="reactionsSectionHeader">
          <ChevronRightIcon className="reactionsSectionChevron" />
          Reactions
        </CollapsibleTrigger>
        <CollapsibleContent>
          {renderThreadList(userReactions)}
        </CollapsibleContent>
      </Collapsible>

      <Collapsible>
        <CollapsibleTrigger className="reactionsSectionHeader">
          <ChevronRightIcon className="reactionsSectionChevron" />
          System
        </CollapsibleTrigger>
        <CollapsibleContent>
          {renderThreadList(systemReactions)}
        </CollapsibleContent>
      </Collapsible>

      <button className="reactionsSidebarPromptBtn" onClick={onOpenFocus}>
        <PenLineIcon style={{ width: 14, height: 14 }} />
        Prompts
      </button>
    </div>
  );
};
