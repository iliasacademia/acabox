import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAssistantRuntime, useAuiState } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';
import { formatSessionModelMeta, useSessionMeta } from './useSessionMeta';
import type { FC } from 'react';

/**
 * Chat view header (56px, Phase B spec): back to the chat list, title,
 * mono meta, GENERATING chip while a turn runs, and per-chat actions —
 * "Open tool" (when the chat belongs to a mini-app), rename, delete.
 */

export interface ChatHeaderProps {
  onBack: () => void;
  onOpenTool: (dirName: string) => void;
}

export const ChatHeader: FC<ChatHeaderProps> = ({ onBack, onOpenTool }) => {
  const runtime = useAssistantRuntime();
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  const title = useAuiState((s: any) => s.threadListItem?.title) as string | undefined;
  const isRunning = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;
  const isEmpty = useAuiState((s: any) => s.thread?.isEmpty ?? true) as boolean;

  // Refetched when a turn ends: the first turn is what records the model pin,
  // and it may also be the turn whose agent created the tool this chat owns.
  const meta = useSessionMeta(remoteId, isRunning);
  const toolDirName = meta.appDirName;

  // An empty chat has no pin yet and falls back to the picker's selection —
  // re-render so that fallback tracks the picker.
  const [pickerNonce, setPickerNonce] = useState(0);
  useEffect(() => {
    const handler = () => setPickerNonce((n) => n + 1);
    window.addEventListener('cd:model-changed', handler);
    window.addEventListener('cd:effort-changed', handler);
    return () => {
      window.removeEventListener('cd:model-changed', handler);
      window.removeEventListener('cd:effort-changed', handler);
    };
  }, []);

  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  const commitRename = useCallback(() => {
    const next = draftTitle.trim();
    setRenaming(false);
    if (!next || !remoteId || next === title) return;
    try {
      runtime.threads.getItemById(remoteId).rename(next);
    } catch (err) {
      console.error('[ChatHeader] rename failed:', err);
    }
  }, [draftTitle, remoteId, title, runtime]);

  const handleDelete = useCallback(() => {
    if (!remoteId) { onBack(); return; }
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;
    try {
      runtime.threads.getItemById(remoteId).delete();
    } catch (err) {
      console.error('[ChatHeader] delete failed:', err);
    }
    onBack();
  }, [remoteId, runtime, onBack]);

  const isNewChat = !title || isEmpty;
  // pickerNonce is read so the empty-chat fallback re-evaluates on picker changes.
  void pickerNonce;
  const modelMeta = formatSessionModelMeta(meta, isEmpty);

  return (
    <div className="cdChatHeader">
      <button type="button" className="cdIconBtn" title="Back to chats" onClick={onBack}>
        <MSymbol name="arrow_back" size={18} />
      </button>
      {renaming ? (
        <input
          ref={renameInputRef}
          className="cdChatHeader__renameInput"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <span className={`cdChatHeader__title${isNewChat ? ' cdChatHeader__title--empty' : ''}`}>
          {title || 'New chat'}
        </span>
      )}
      <span className="cdChatHeader__meta">
        {[modelMeta, isNewChat ? 'NAMES ITSELF AFTER THE FIRST REPLY' : null]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {isRunning && (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--busy cdDot--pulse" />
          GENERATING
        </span>
      )}
      <span className="cdChatHeader__spacer" />
      {toolDirName && (
        <button type="button" className="cdBtnXs cdBtnXs--sm" onClick={() => onOpenTool(toolDirName)}>
          <MSymbol name="deployed_code" size={15} />
          Open tool
        </button>
      )}
      {!isNewChat && remoteId && (
        <button
          type="button"
          className="cdIconBtn"
          title="Rename"
          onClick={() => { setDraftTitle(title ?? ''); setRenaming(true); }}
        >
          <MSymbol name="edit" size={17} />
        </button>
      )}
      {remoteId && (
        <button type="button" className="cdIconBtn cdIconBtn--danger" title="Delete chat" onClick={handleDelete}>
          <MSymbol name="delete" size={17} />
        </button>
      )}
    </div>
  );
};
