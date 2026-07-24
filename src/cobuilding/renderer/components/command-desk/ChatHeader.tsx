import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAssistantRuntime, useAuiState } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';
import { getSelectedModelLabel } from '../ModelSelector';
import type { FC } from 'react';

/**
 * Chat view header (56px, Phase B spec): back to the chat list, title,
 * mono meta, GENERATING chip while a turn runs, and per-chat actions —
 * "Open tool" (when the chat owns a mini-app), rename, delete.
 */

// sessionId → owning tool dirName (or null when the scan found none).
const toolBySession = new Map<string, string | null>();

/** Finds the mini-app whose manifest.chatSessionId names this session. */
function useSessionTool(remoteId: string | undefined, workspacePath: string, rescanKey: unknown): string | null {
  const [dirName, setDirName] = useState<string | null>(
    remoteId ? toolBySession.get(remoteId) ?? null : null,
  );

  useEffect(() => {
    if (!remoteId) { setDirName(null); return; }
    const cached = toolBySession.get(remoteId);
    if (cached) { setDirName(cached); return; }
    let cancelled = false;
    (async () => {
      try {
        const appsDir = `${workspacePath}/.applications`;
        const entries = await window.filesAPI.readDirectory(appsDir);
        for (const entry of entries) {
          if (!entry.isDirectory || entry.name.startsWith('.')) continue;
          const manifest = await window.filesAPI.readFile(`${entry.path}/manifest.json`).catch(() => null);
          if (!manifest || 'error' in manifest || manifest.type !== 'text') continue;
          try {
            const parsed = JSON.parse(manifest.content);
            if (parsed?.chatSessionId === remoteId) {
              if (!cancelled) {
                toolBySession.set(remoteId, entry.name);
                setDirName(entry.name);
              }
              return;
            }
          } catch { /* unparseable manifest — skip */ }
        }
        if (!cancelled) setDirName(null);
      } catch {
        if (!cancelled) setDirName(null);
      }
    })();
    return () => { cancelled = true; };
  }, [remoteId, workspacePath, rescanKey]);

  return dirName;
}

export interface ChatHeaderProps {
  workspacePath: string;
  onBack: () => void;
  onOpenTool: (dirName: string) => void;
}

export const ChatHeader: FC<ChatHeaderProps> = ({ workspacePath, onBack, onOpenTool }) => {
  const runtime = useAssistantRuntime();
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  const title = useAuiState((s: any) => s.threadListItem?.title) as string | undefined;
  const isRunning = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;
  const isEmpty = useAuiState((s: any) => s.thread?.isEmpty ?? true) as boolean;

  // Model label mirrors the composer's picker; updates on cd:model-changed.
  const [modelLabel, setModelLabel] = useState(getSelectedModelLabel);
  useEffect(() => {
    const handler = () => setModelLabel(getSelectedModelLabel());
    window.addEventListener('cd:model-changed', handler);
    return () => window.removeEventListener('cd:model-changed', handler);
  }, []);

  // Rescan the manifest → session mapping when a turn ends (the agent may
  // have just created the tool this chat owns).
  const toolDirName = useSessionTool(remoteId, workspacePath, isRunning);

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
        {isNewChat ? `${modelLabel} · NAMES ITSELF AFTER THE FIRST REPLY` : modelLabel}
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
