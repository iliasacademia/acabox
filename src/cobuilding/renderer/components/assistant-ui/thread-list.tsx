import React, { useState, useRef, useEffect } from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useThreadListItemRuntime,
} from '@assistant-ui/react';
import { PencilIcon, PlusIcon, TrashIcon } from 'lucide-react';
import type { FC } from 'react';

export const ThreadList: FC = () => {
  return (
    <ThreadListPrimitive.Root className="threadListRoot">
      <ThreadListNew />
      <ThreadListPrimitive.Items>
        {() => <ThreadListItem />}
      </ThreadListPrimitive.Items>
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
          <ThreadListItemPrimitive.Title fallback="New Chat" />
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
