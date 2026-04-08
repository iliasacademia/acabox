import React, { type FC } from 'react';
import { XIcon, MessageSquareIcon, CircleIcon } from 'lucide-react';
import type { TabDescriptor } from './types';

interface TabBarProps {
  tabs: TabDescriptor[];
  activeTabId: string | null;
  dirtyTabIds: Set<string>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onShowChat: () => void;
}

export const TabBar: FC<TabBarProps> = ({
  tabs,
  activeTabId,
  dirtyTabIds,
  onActivate,
  onClose,
  onPin,
  onShowChat,
}) => {
  if (tabs.length === 0) return null;

  const chatIsActive = activeTabId === null;

  return (
    <div className="tabBar">
      <div
        className={`tabBarItem tabBarItem--home${chatIsActive ? ' tabBarItem--active' : ''}`}
        onClick={onShowChat}
      >
        <MessageSquareIcon style={{ width: 14, height: 14 }} />
        <span className="tabBarItemLabel">Chat</span>
      </div>
      {tabs.map((tab) => {
        const isDirty = dirtyTabIds.has(tab.id);
        return (
          <div
            key={tab.id}
            className={`tabBarItem${tab.id === activeTabId ? ' tabBarItem--active' : ''}${!tab.pinned ? ' tabBarItem--preview' : ''}`}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => onPin(tab.id)}
            title={tab.label}
          >
            <span className="tabBarItemLabel">{tab.label}</span>
            <button
              className={`tabBarItemClose${isDirty ? ' tabBarItemClose--dirty' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (isDirty) {
                  if (!window.confirm('You have unsaved changes. Close anyway?')) return;
                }
                onClose(tab.id);
              }}
            >
              {isDirty ? (
                <CircleIcon style={{ width: 8, height: 8, fill: 'currentColor' }} />
              ) : (
                <XIcon style={{ width: 14, height: 14 }} />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
};
