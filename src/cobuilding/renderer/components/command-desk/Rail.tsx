import React, { useState } from 'react';
import { MSymbol } from './MSymbol';
import { AcaboxMark } from './AcaboxMark';
import { resolveToolIcon } from './toolIcon';
import { useToolStatuses } from '../../toolStatusStore';
import { toolStatusDotClass } from './toolStatusDisplay';

export type RailTab = 'home' | 'chats' | 'tools' | 'files' | 'activity' | 'debug' | 'settings';

export interface RailRecentChat {
  id: string;
  title: string;
}

export interface RailPinnedTool {
  dirName: string;
  name: string;
  icon: string | null;
}

const NAV_ITEMS: { tab: RailTab; label: string; icon: string }[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'chats', label: 'Chats', icon: 'forum' },
  { tab: 'tools', label: 'Tools', icon: 'grid_view' },
  { tab: 'files', label: 'Files', icon: 'folder_open' },
  { tab: 'activity', label: 'Activity', icon: 'monitoring' },
];

const RAIL_OPEN_KEY = 'cd.railOpen';

/**
 * Left rail — expanded (236px) and collapsed (64px) states, toggle persisted.
 */
export function Rail({
  activeTab,
  chatCount,
  toolCount,
  recents,
  pinned,
  workspaceName,
  onNavigate,
  onOpenChat,
  onOpenTool,
}: {
  activeTab: RailTab | string;
  chatCount: number;
  toolCount: number;
  recents: RailRecentChat[];
  pinned: RailPinnedTool[];
  workspaceName: string;
  onNavigate: (tab: RailTab) => void;
  onOpenChat: (sessionId: string) => void;
  onOpenTool: (dirName: string) => void;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(RAIL_OPEN_KEY) !== 'false');
  const toolStatuses = useToolStatuses();

  const toggle = () => {
    setOpen((prev) => {
      localStorage.setItem(RAIL_OPEN_KEY, String(!prev));
      return !prev;
    });
  };

  if (!open) {
    return (
      <div className="cdRail cdRail--collapsed">
        <div className="cdRail__logo">
          <AcaboxMark size={28} />
        </div>
        <button className="cdIconBtn" title="Expand" onClick={toggle}>
          <MSymbol name="keyboard_double_arrow_right" size={18} />
        </button>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.tab}
            className={`cdRail__bigIconBtn${activeTab === item.tab ? ' cdRail__bigIconBtn--active' : ''}`}
            title={item.label}
            onClick={() => onNavigate(item.tab)}
          >
            <MSymbol name={item.icon} size={20} />
          </button>
        ))}
        <span className="cdRail__spacer" />
        <button className="cdRail__bigIconBtn" title="Debug" onClick={() => onNavigate('debug')}>
          <MSymbol name="bug_report" size={20} />
        </button>
        <button className="cdRail__bigIconBtn" title="Settings" onClick={() => onNavigate('settings')}>
          <MSymbol name="settings" size={20} />
        </button>
      </div>
    );
  }

  return (
    <div className="cdRail">
      <div className="cdRail__header">
        <div className="cdRail__logo">
          <AcaboxMark size={28} />
        </div>
        <span className="cdRail__wordmark">ACABOX</span>
        <span className="cdRail__spacer" />
        <button className="cdIconBtn" title="Collapse" onClick={toggle}>
          <MSymbol name="keyboard_double_arrow_left" size={18} />
        </button>
      </div>

      <nav className="cdRail__nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.tab}
            className={`cdRail__navItem${activeTab === item.tab ? ' cdRail__navItem--active' : ''}`}
            onClick={() => onNavigate(item.tab)}
          >
            <MSymbol name={item.icon} size={18} />
            {item.label}
            <span className="cdRail__spacer" />
            {item.tab === 'chats' && chatCount > 0 && (
              <span className="cdRail__navCount">{chatCount}</span>
            )}
            {item.tab === 'tools' && toolCount > 0 && (
              <span className="cdRail__navCount">{toolCount}</span>
            )}
          </button>
        ))}
      </nav>

      {recents.length > 0 && (
        <>
          <div className="cdRail__sectionLabel">Recents</div>
          <div className="cdRail__list">
            {recents.map((chat) => (
              <button key={chat.id} className="cdRail__row" onClick={() => onOpenChat(chat.id)}>
                <MSymbol name="chat_bubble" size={16} />
                <span className="cdRail__rowTitle">{chat.title}</span>
              </button>
            ))}
            <button className="cdRail__row cdRail__row--more" onClick={() => onNavigate('chats')}>
              <MSymbol name="more_horiz" size={16} />
              More
            </button>
          </div>
        </>
      )}

      {pinned.length > 0 && (
        <>
          <div className="cdRail__sectionLabel">Pinned tools</div>
          <div className="cdRail__list">
            {pinned.map((tool) => {
              const Icon = resolveToolIcon(tool.icon);
              // Idle tools carry no dot at all — a dot here means the tool is
              // busy or broken, not merely that it exists.
              const status = toolStatuses.get(tool.dirName);
              return (
                <button
                  key={tool.dirName}
                  className="cdRail__row"
                  onClick={() => onOpenTool(tool.dirName)}
                >
                  <Icon style={{ width: 16, height: 16, color: 'var(--cd-text3)', flex: 'none' }} />
                  <span className="cdRail__rowTitle">{tool.name}</span>
                  {status && <span className={`cdDot ${toolStatusDotClass(status)}`} />}
                </button>
              );
            })}
          </div>
        </>
      )}

      <span className="cdRail__spacer" />

      <div className="cdRail__footer">
        <button className="cdRail__row" onClick={() => onNavigate('files')}>
          <MSymbol name="hard_drive" size={16} />
          <span className="cdRail__mono12">~/{workspaceName}</span>
          <span className="cdRail__mono9">SYNCED</span>
        </button>
        <button className="cdRail__row" onClick={() => onNavigate('debug')}>
          <MSymbol name="bug_report" size={16} />
          Debug
        </button>
        <button className="cdRail__row" onClick={() => onNavigate('settings')}>
          <MSymbol name="settings" size={16} />
          Settings
        </button>
      </div>
    </div>
  );
}
