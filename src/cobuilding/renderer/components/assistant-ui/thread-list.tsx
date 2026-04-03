import React from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
} from '@assistant-ui/react';
import { PlusIcon, TrashIcon } from 'lucide-react';
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
  return (
    <ThreadListItemPrimitive.Root className="threadListItem">
      <ThreadListItemPrimitive.Trigger className="threadListItemTrigger">
        <span className="threadListItemTitle">
          <ThreadListItemPrimitive.Title fallback="New Chat" />
        </span>
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemPrimitive.Delete asChild>
        <button className="threadListItemDelete">
          <TrashIcon style={{ width: 14, height: 14 }} />
        </button>
      </ThreadListItemPrimitive.Delete>
    </ThreadListItemPrimitive.Root>
  );
};
