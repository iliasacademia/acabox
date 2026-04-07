import React, { useState, useRef, useEffect } from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useThreadListItemRuntime,
} from '@assistant-ui/react';
import { PencilIcon, PlusIcon, TrashIcon } from 'lucide-react';
import type { FC } from 'react';
import {
  dateFromSessionStoredAt,
  getSessionCreatedAt,
} from '../../sessionTimestamps';

export const ThreadList: FC = () => {
  return (
    <ThreadListPrimitive.Root className="threadListRoot">
      <ThreadListNew />
      <div className="threadListItems">
        <ThreadListPrimitive.Items>
          {() => <ThreadListItem />}
        </ThreadListPrimitive.Items>
      </div>
    </ThreadListPrimitive.Root>
  );
};

const ThreadListNew: FC = () => {
  return (
    <ThreadListPrimitive.New asChild>
      <button className="threadListNewBtn">
        <PlusIcon style={{ width: 16, height: 16 }} />
        New Thread
      </button>
    </ThreadListPrimitive.New>
  );
};

const ThreadListItem: FC = () => {
  const runtime = useThreadListItemRuntime();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    const title = runtime.getState().title ?? 'New Chat';
    setEditValue(title);
    setIsEditing(true);
  };

  const remoteId = runtime.getState().remoteId;
  const createdAt = getSessionCreatedAt(remoteId);

  const formatCreatedAt = (iso: string) => {
    const date = dateFromSessionStoredAt(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== runtime.getState().title) {
      runtime.rename(trimmed);
    }
    setIsEditing(false);
  };

  const cancelEditing = () => {
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <ThreadListItemPrimitive.Root className="threadListItem">
        <input
          ref={inputRef}
          className="threadListItemRenameInput"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') cancelEditing();
          }}
        />
      </ThreadListItemPrimitive.Root>
    );
  }

  return (
    <ThreadListItemPrimitive.Root className="threadListItem">
      <ThreadListItemPrimitive.Trigger className="threadListItemTrigger">
        <span className="threadListItemTitle">
          <span className="threadListItemTitleText">
            <ThreadListItemPrimitive.Title fallback="New Chat" />
          </span>
          {createdAt ? (
            <span className="threadListItemDate">{formatCreatedAt(createdAt)}</span>
          ) : null}
        </span>
      </ThreadListItemPrimitive.Trigger>
      <button className="threadListItemAction" onClick={startEditing}>
        <PencilIcon style={{ width: 14, height: 14 }} />
      </button>
      <ThreadListItemPrimitive.Delete asChild>
        <button className="threadListItemAction threadListItemDelete">
          <TrashIcon style={{ width: 14, height: 14 }} />
        </button>
      </ThreadListItemPrimitive.Delete>
    </ThreadListItemPrimitive.Root>
  );
};
