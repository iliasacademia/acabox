import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import { TrashIcon, ChevronRightIcon } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { dateFromSessionStoredAt } from '../sessionTimestamps';

export const ReactionsSidebar: React.FC = () => {
  const [userReactions, setUserReactions] = useState<SessionData[]>([]);
  const [systemReactions, setSystemReactions] = useState<SessionData[]>([]);
  const [instructions, setInstructions] = useState('');
  const [savedInstructions, setSavedInstructions] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const runtime = useAssistantRuntime();

  const load = useCallback(() => {
    window.sessionsAPI.list('reactions').then(setUserReactions);
    window.sessionsAPI.list('reactions-system').then(setSystemReactions);
  }, []);

  useEffect(() => {
    window.reactionPromptAPI.get().then(({ instructions: inst }) => {
      setInstructions(inst ?? '');
      setSavedInstructions(inst);
    });
  }, []);

  const handleSaveInstructions = useCallback(async () => {
    setSaving(true);
    try {
      const trimmed = instructions.trim();
      if (trimmed) {
        await window.reactionPromptAPI.set(trimmed);
        setSavedInstructions(trimmed);
      } else {
        await window.reactionPromptAPI.reset();
        setSavedInstructions(null);
        setInstructions('');
      }
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [instructions]);

  const handleResetInstructions = useCallback(async () => {
    await window.reactionPromptAPI.reset();
    setInstructions('');
    setSavedInstructions(null);
  }, []);

  const instructionsChanged = instructions.trim() !== (savedInstructions ?? '');

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

      <Collapsible>
        <CollapsibleTrigger className="reactionsSectionHeader">
          <ChevronRightIcon className="reactionsSectionChevron" />
          Prompts
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="reactionPromptEditor">
            <textarea
              className="reactionPromptEditor__textarea"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Describe what types of reactions would be useful to you..."
              rows={6}
            />
            <div className="reactionPromptEditor__actions">
              <button
                className="reactionPromptEditor__save"
                onClick={handleSaveInstructions}
                disabled={!instructionsChanged || saving}
              >
                {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
              </button>
              {savedInstructions !== null && (
                <button
                  className="reactionPromptEditor__reset"
                  onClick={handleResetInstructions}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
